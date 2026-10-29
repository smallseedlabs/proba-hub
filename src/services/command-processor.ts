import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { transaction } from '../db/client.js';
import { logger } from '../logger.js';
import { kickOutboxRelay } from './outbox-relay.js';
import { isBrainOutput } from '@smallseedlabs/proba-protocol';
import type { BrainPort, BrainGoalUpdate, Command, Event, Thread, Message, Goal, BrainContext } from '../types.js';
import { normalizeBrainStepResult } from '../types.js';
import type { 
  CommandEnvelope, 
  BrainOutput,
  ControlPayload,
  CreateGoalPayload,
  AnswerAskPayload,
  ContextPacket,
} from '@smallseedlabs/proba-protocol';
import { mapBrainOutputToEvent } from '@smallseedlabs/proba-protocol';
import { toJsonb } from '../db/jsonb.js';
import { getAudit } from '../audit/service.js';
import { runInSpan, startSpan, type Span } from '../audit/trace.js';
import type { AssertionMinter } from '../auth/assertions/mint.js';
import type { ContextClient } from '../brain/context-client.js';
import {
  contextBridgeRuntimeFromConfig,
  runBrainWithBridge,
  type ContextBridgeRuntime,
} from '../brain/context-attach.js';
import {
  lockExecutionState,
  nextExecutionState,
  saveExecutionState,
  type ExecutionState,
} from './execution-state.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GoalStatus = 'active' | 'paused' | 'completed' | 'cancelled';

interface GoalRow {
  id: string;
  title: string;
  status: string;
  progress: BrainGoalUpdate['progress'] | null;
  metrics: BrainGoalUpdate['metrics'] | null;
  budget: { daily?: number; total?: number; currency?: string } | null;
}

/** A brain call that threw. Carries the call's span so the failure can be audited even when the transaction rolls back. */
export class BrainCallError extends Error {
  constructor(
    readonly cause: unknown,
    readonly span: Span,
    readonly durationMs: number,
    readonly trigger: string
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'BrainCallError';
  }
}

/** Control command -> audit action. `kill` is control.emergency_stopped (decided with the protocol v0.3.1 catalog). */
const CONTROL_AUDIT_ACTIONS: Record<string, 'control.paused' | 'control.resumed' | 'control.emergency_stopped'> = {
  pause: 'control.paused',
  resume: 'control.resumed',
  kill: 'control.emergency_stopped',
};

interface AuditScope {
  userId: string;
  threadId?: string;
  commandType: string;
}

/** Type and size of a brain output, never its content. Safe for audit details on any input. */
function summarizeOutput(output: unknown): Record<string, unknown> {
  const o = (output ?? {}) as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type.slice(0, 32) : 'unknown';
  switch (type) {
    case 'reply':
      return { type, textLength: typeof o.text === 'string' ? o.text.length : 0 };
    case 'explain':
      return { type, textLength: typeof o.explanation === 'string' ? o.explanation.length : 0 };
    case 'tool_call':
      return { type, tool: typeof o.tool === 'string' ? o.tool.slice(0, 64) : 'unknown' };
    case 'plan':
      return { type, stepCount: Array.isArray(o.steps) ? o.steps.length : 0 };
    case 'clarify':
      return { type, questionCount: Array.isArray(o.questions) ? o.questions.length : 0 };
    case 'decision':
      return { type, decision: typeof o.decision === 'string' ? o.decision.slice(0, 16) : 'unknown' };
    default:
      return { type };
  }
}

/** The question the user is asked, as one readable text: the reason, then each question. */
function clarificationText(output: { reason?: string; questions: Array<{ text: string }> }): string {
  const lines = output.questions.map((q, i) => `${i + 1}. ${q.text}`);
  return [output.reason, ...lines].filter((l): l is string => typeof l === 'string' && l.length > 0).join('\n');
}

export interface CommandProcessorOptions {
  /** Context bridge HTTP client. When omitted, the brain uses the legacy in-Hub context. */
  contextClient?: ContextClient;
  /** Mints act-as assertions for bridge calls. */
  assertionMinter?: AssertionMinter | null;
  /** Override config.contextBridge.enabled (tests). */
  contextBridgeEnabled?: boolean;
  /** Override max hybrid needs rounds (tests). */
  maxNeedRounds?: number;
  /** Override failure mode (tests). */
  onFailure?: ContextBridgeRuntime['onFailure'];
}

export class CommandProcessor {
  private readonly bridge: ContextBridgeRuntime | null;
  /** Last packet attached to a brain step in this process (for tests / step linkage). */
  lastAttachedPacket: ContextPacket | null = null;
  lastAttachedStep: { stepId: string; stepType: string; packetId: string; packetHash: string } | null =
    null;

  constructor(
    private brain: BrainPort,
    options: CommandProcessorOptions = {}
  ) {
    if (options.contextClient === undefined) {
      this.bridge = null;
    } else {
      const runtime = contextBridgeRuntimeFromConfig(
        options.contextClient,
        options.assertionMinter ?? null
      );
      if (options.contextBridgeEnabled !== undefined) runtime.enabled = options.contextBridgeEnabled;
      if (options.maxNeedRounds !== undefined) runtime.maxNeedRounds = Math.max(0, options.maxNeedRounds);
      if (options.onFailure !== undefined) runtime.onFailure = options.onFailure;
      this.bridge = runtime;
    }
  }

  async processCommand(
    userId: string,
    envelope: CommandEnvelope
  ): Promise<{ command: Command; events: Event[] }> {
    const startedAt = Date.now();
    const result = await transaction((client) => this.processInTransaction(client, userId, envelope, startedAt));
    // Only now are the events committed and visible to the relay. Kicking from
    // inside the transaction callback raced COMMIT and fell back to the poll.
    void kickOutboxRelay();
    return result;
  }

  /**
   * The processing transaction rolled back, so none of its audit events exist.
   * Record the failure in its own transaction, under the same traceId.
   */
  async auditProcessingFailure(userId: string, envelope: CommandEnvelope, error: unknown): Promise<void> {
    const audit = getAudit();
    const scope: AuditScope = { userId, threadId: envelope.threadId, commandType: envelope.type };
    const message = error instanceof Error ? error.message : String(error);
    try {
      if (error instanceof BrainCallError) {
        await audit.emit(
          {
            action: 'brain.error',
            outcome: 'failure',
            userId,
            threadId: envelope.threadId,
            spanId: error.span.spanId,
            parentSpanId: error.span.parentSpanId,
            errorCode: 'brain_failed',
            errorMessage: message,
            durationMs: error.durationMs,
            details: { trigger: error.trigger },
          },
          { bestEffort: true }
        );
      }
      await audit.emit(
        {
          action: 'command.processed',
          outcome: 'failure',
          userId,
          threadId: envelope.threadId,
          errorCode: 'command_processing_failed',
          errorMessage: message,
          details: { commandType: scope.commandType, rolledBack: true },
        },
        { bestEffort: true }
      );
      await audit.emit(
        {
          action: 'system.error',
          outcome: 'failure',
          actor: { type: 'service', id: 'hub' },
          userId,
          threadId: envelope.threadId,
          errorCode: 'command_processing_failed',
          errorMessage: message,
          details: { component: 'command_processor', commandType: scope.commandType },
        },
        { bestEffort: true }
      );
    } catch {
      // bestEffort emits never throw; this only guards the logging above.
    }
  }

  private async processInTransaction(
    client: PoolClient,
    userId: string,
    envelope: CommandEnvelope,
    startedAt: number
  ): Promise<{ command: Command; events: Event[] }> {
    const audit = getAudit();
    const scope: AuditScope = { userId, threadId: envelope.threadId, commandType: envelope.type };

    // INSERT ... ON CONFLICT DO NOTHING is race-safe: a concurrent duplicate
    // waits for the first transaction and then becomes a no-op, instead of
    // failing with a unique violation (check-then-insert was racy).
    const command = await this.storeCommand(client, userId, envelope);

    if (!command) {
      const existingCommand = await this.checkIdempotency(client, userId, envelope.clientMsgId);
      logger.info(
        { userId, clientMsgId: envelope.clientMsgId },
        'Command already processed (idempotent)'
      );
      const events = existingCommand ? await this.getCommandEvents(client, existingCommand.id) : [];
      await audit.emit(
        {
          action: 'command.duplicate',
          outcome: 'success',
          userId,
          threadId: envelope.threadId,
          target: existingCommand ? { type: 'command', id: existingCommand.id } : undefined,
          details: { commandType: envelope.type, replayedEvents: events.length },
        },
        { tx: client }
      );
      return { command: existingCommand!, events };
    }

    // Control always goes through: it is how a paused or stopped workspace is resumed.
    if (envelope.type === 'control') {
      return this.processControl(client, userId, command, envelope, startedAt);
    }

    // Pause / emergency stop: nothing else runs, and the brain is not called, until resume.
    const executionState = await lockExecutionState(client, userId, 'share');
    if (executionState !== 'running') {
      return this.rejectWhileHalted(client, userId, command, scope, executionState, startedAt);
    }

    // The user's typed message joins the thread before the brain sees its context.
    if (envelope.type === 'send_message') {
      await this.storeUserMessage(client, envelope);
    }

    const events: Event[] = [];
    // Set when the user declined an ask that carried a cost: the budget is not approved, so nothing launches.
    let budgetDeclined = false;
    
    // Pre-allocate goal id for create_goal so the bridge assertion can carry it
    // before the goals row is inserted (after the brain step).
    const pendingGoalId = envelope.type === 'create_goal' ? randomUUID() : undefined;

    // Commands with special handlers (answer_ask, approve_plan) skip initial brain invocation
    // and invoke it themselves after doing their specific work
    if (envelope.type === 'answer_ask' || envelope.type === 'approve_plan') {
      // These handlers will invoke brain and populate events
    } else {
      const context = await this.buildContext(client, userId, envelope.threadId);
      
      let brainOutputs: BrainOutput[];
      let brainSpan: Span;
      try {
        ({ outputs: brainOutputs, span: brainSpan } = await this.callBrain(client, scope, envelope, context, {
          goalId: pendingGoalId,
        }));
      } catch (error) {
        // Only a failing brain is turned into an error event. Anything else (for
        // example the audit insert) must roll the command back.
        if (!(error instanceof BrainCallError)) throw error;
        const cause = error.cause;
        logger.error({ error: cause, userId, command: envelope.type }, 'Brain processing failed');
        
        const errorEvent = await this.createErrorEvent(
          client,
          userId,
          envelope.threadId,
          'brain_error',
          'Failed to process command. Please try again.'
        );
        
        await this.addToOutbox(client, userId, errorEvent.id);
        await this.auditBrainFailure(client, scope, error, cause);
        await this.auditProcessed(client, scope, startedAt, [errorEvent], 'failure', 'brain_error');
        return { command, events: [errorEvent] };
      }
      
      for (const output of brainOutputs) {
        // Validate brain output against protocol schema BEFORE any DB writes
        if (!isBrainOutput(output)) {
          logger.error({ output }, 'Invalid brain output - does not match protocol schema');
          
          try {
            const seq = await this.getNextSeq(client, userId);
            const errorEvent = await client.query<Event>(
              `INSERT INTO events (user_id, seq, type, thread_id, payload, created_at)
               VALUES ($1, $2, 'error', $3, $4, NOW())
               RETURNING id, user_id as "userId", seq, type, thread_id as "threadId",
                         payload, created_at as "createdAt"`,
              [userId, seq, envelope.threadId, toJsonb({ code: 'brain_error', message: 'Invalid brain output format' })]
            );
            const errorEventRow = errorEvent.rows[0];
            events.push(errorEventRow);
            await this.addToOutbox(client, userId, errorEventRow.id);
          } catch (innerError) {
            logger.error({ error: innerError }, 'Failed to create error event for invalid output');
          }
          await this.auditInvalidOutput(client, scope, brainSpan, output);
          continue;
        }

        // Savepoint: a failed output must not abort the whole transaction,
        // otherwise the error event below (and the command row) are lost too.
        await client.query('SAVEPOINT brain_output');
        let event: Event | undefined;
        let outputError: unknown;
        try {
          event = await this.processBrainOutput(
            client,
            userId,
            envelope.threadId,
            output
          );
          events.push(event);
          await this.addToOutbox(client, userId, event.id);
          await client.query('RELEASE SAVEPOINT brain_output');
        } catch (error) {
          outputError = error;
          await client.query('ROLLBACK TO SAVEPOINT brain_output');
          logger.error({ error, output }, 'Failed to process brain output');
          if (event) events.splice(events.indexOf(event), 1);
          event = undefined;
          
          // Surface error as error event
          try {
            const seq = await this.getNextSeq(client, userId);
            const errorEvent = await client.query<Event>(
              `INSERT INTO events (user_id, seq, type, thread_id, payload, created_at)
               VALUES ($1, $2, 'error', $3, $4, NOW())
               RETURNING id, user_id as "userId", seq, type, thread_id as "threadId",
                         payload, created_at as "createdAt"`,
              [userId, seq, envelope.threadId, toJsonb({ code: 'brain_error', message: (error as Error).message })]
            );
            const errorEventRow = errorEvent.rows[0];
            events.push(errorEventRow);
            await this.addToOutbox(client, userId, errorEventRow.id);
          } catch (innerError) {
            logger.error({ error: innerError }, 'Failed to create error event');
          }
        }
        // Audit after the savepoint is settled: a database failure here must
        // propagate and roll the whole command back, not be swallowed as a
        // "failed output".
        if (event) await this.auditBrainOutput(client, scope, brainSpan, output, event);
        else await this.auditInvalidOutput(client, scope, brainSpan, output, 'brain_output_failed', outputError);
      }
    }

    if (envelope.type === 'answer_ask') {
      const answerPayload = envelope.payload as AnswerAskPayload;
      const payloadAskType = (envelope.payload as unknown as Record<string, unknown>).askType;
      logger.info({ askId: answerPayload.askId, askType: payloadAskType }, 'Handling answer_ask command');
      // Clients answer with { askId, choice, values }; the brain also needs the
      // ask type (clarify / plan_approval / action_approval). Look it up.
      const brainEnvelope = await this.withAskType(client, envelope);
      const askResolvedEvent = await this.handleAskAnswer(client, userId, envelope.threadId!, answerPayload);
      events.push(askResolvedEvent);
      await this.auditAskAnswered(
        client,
        scope,
        answerPayload,
        (brainEnvelope.payload as unknown as Record<string, unknown>).askType
      );
      budgetDeclined = await this.isBudgetDeclined(
        client,
        scope.threadId,
        String(answerPayload.askId),
        answerPayload.choice === 'reject'
      );
      
      // After recording the answer, invoke brain to generate next step
      const context = await this.buildContext(client, userId, envelope.threadId);
      const resolvedAskType = String(
        (brainEnvelope.payload as unknown as Record<string, unknown>).askType ?? ''
      );
      const called = await this.callBrain(client, scope, brainEnvelope, context, {
        askType: resolvedAskType,
      });
      const brainSpan = called.span;
      const brainOutputs = budgetDeclined
        ? await this.enforceBudgetDecline(client, scope, called.outputs, String(answerPayload.askId), brainSpan)
        : called.outputs;
      
      for (const output of brainOutputs) {
        if (!isBrainOutput(output)) {
          logger.error({ output }, 'Invalid brain output after answer_ask');
          const seq = await this.getNextSeq(client, userId);
          const errorEvent = await client.query<Event>(
            `INSERT INTO events (user_id, seq, type, thread_id, payload, created_at)
             VALUES ($1, $2, 'error', $3, $4, NOW())
             RETURNING id, user_id as "userId", seq, type, thread_id as "threadId",
                       payload, created_at as "createdAt"`,
            [userId, seq, envelope.threadId, toJsonb({ code: 'brain_error', message: 'Invalid brain output format' })]
          );
          events.push(errorEvent.rows[0]);
          await this.addToOutbox(client, userId, errorEvent.rows[0].id);
          await this.auditInvalidOutput(client, scope, brainSpan, output);
          continue;
        }
        
        const event = await this.processBrainOutput(client, userId, envelope.threadId!, output);
        events.push(event);
        await this.addToOutbox(client, userId, event.id);
        await this.auditBrainOutput(client, scope, brainSpan, output, event);
      }
    }

    if (envelope.type === 'approve_plan') {
      const planPayload = envelope.payload as Record<string, unknown>;
      logger.info({ planId: planPayload.planId }, 'Handling approve_plan command');

      // The plan was presented as a plan_approval ask: resolve it so every
      // client (and a reload) sees it as decided.
      const planResolved = await this.resolvePlanAsk(client, userId, envelope.threadId, planPayload);
      if (planResolved) events.push(planResolved);
      await this.auditPlanDecision(client, scope, planPayload, planResolved !== null);
      budgetDeclined =
        typeof planPayload.planId === 'string' &&
        (await this.isBudgetDeclined(client, scope.threadId, planPayload.planId, planPayload.approved === false));
      
      // After approving plan, invoke brain to generate next step
      const context = await this.buildContext(client, userId, envelope.threadId);
      const called = await this.callBrain(client, scope, envelope, context);
      const brainSpan = called.span;
      const brainOutputs = budgetDeclined
        ? await this.enforceBudgetDecline(client, scope, called.outputs, String(planPayload.planId), brainSpan)
        : called.outputs;
      logger.debug({ outputCount: brainOutputs.length, outputs: brainOutputs }, 'Brain outputs after approve_plan');
      
      for (const output of brainOutputs) {
        if (!isBrainOutput(output)) {
          logger.error({ output }, 'Invalid brain output after approve_plan');
          const seq = await this.getNextSeq(client, userId);
          const errorEvent = await client.query<Event>(
            `INSERT INTO events (user_id, seq, type, thread_id, payload, created_at)
             VALUES ($1, $2, 'error', $3, $4, NOW())
             RETURNING id, user_id as "userId", seq, type, thread_id as "threadId",
                       payload, created_at as "createdAt"`,
            [userId, seq, envelope.threadId, toJsonb({ code: 'brain_error', message: 'Invalid brain output format' })]
          );
          events.push(errorEvent.rows[0]);
          await this.addToOutbox(client, userId, errorEvent.rows[0].id);
          await this.auditInvalidOutput(client, scope, brainSpan, output);
          continue;
        }
        
        const event = await this.processBrainOutput(client, userId, envelope.threadId!, output);
        events.push(event);
        await this.addToOutbox(client, userId, event.id);
        await this.auditBrainOutput(client, scope, brainSpan, output, event);
      }
    }

    const threadKey = envelope.threadId || 'default';
    const reportedUpdate = this.brain.takeGoalUpdate?.(threadKey);
    // A declined budget does not launch: whatever progress or spend the brain reported is dropped and the goal waits.
    const goalUpdate: BrainGoalUpdate | undefined = budgetDeclined ? { status: 'paused' } : reportedUpdate;

    if (envelope.type === 'create_goal') {
      const goal = await this.createGoal(
        client,
        userId,
        envelope.threadId!,
        envelope.payload as CreateGoalPayload,
        pendingGoalId
      );
      events.push(await this.emitGoalUpdated(client, userId, envelope.threadId!, goal, goalUpdate ?? {}, 'created'));
    } else if (goalUpdate && envelope.threadId) {
      const goal = await this.latestGoal(client, envelope.threadId);
      if (goal) events.push(await this.emitGoalUpdated(client, userId, envelope.threadId, goal, goalUpdate, 'updated'));
    }

    await client.query(
      'UPDATE commands SET status = $1, processed_at = NOW() WHERE id = $2',
      ['processed', command.id]
    );
    await this.auditProcessed(client, scope, startedAt, events, 'success');

    return { command, events };
  }

  // ---------------------------------------------------------------------------
  // Audit helpers. Every one writes through the command's own transaction
  // (`tx: client`), so an event exists if and only if the change it describes
  // committed. Parents: the request's root span -> brain call -> output/tool.
  // ---------------------------------------------------------------------------

  /**
   * Call the brain inside its own span and audit the call (brain.llm_call).
   * When the context bridge flag is on: mint assertion → POST /v1/context/build →
   * attach packet → optional hybrid needs rounds → brain. Never falls back to an
   * in-process builder on failure.
   */
  private async callBrain(
    client: PoolClient,
    scope: AuditScope,
    envelope: CommandEnvelope,
    context: BrainContext,
    options: { askType?: string; goalId?: string } = {}
  ): Promise<{ outputs: BrainOutput[]; span: Span; held?: boolean }> {
    const span = startSpan();
    const started = Date.now();
    let outputs: BrainOutput[];
    let held = false;

    try {
      if (this.bridge?.enabled) {
        const result = await runInSpan(span, () =>
          runBrainWithBridge({
            runtime: this.bridge!,
            brain: this.brain,
            client,
            scope,
            envelope,
            context,
            brainSpan: span,
            askType: options.askType,
            goalId: options.goalId,
          })
        );
        outputs = result.outputs;
        held = result.held;
        if (result.attached) {
          this.lastAttachedPacket = result.attached.packet;
          this.lastAttachedStep = {
            stepId: result.attached.stepId,
            stepType: result.attached.stepType,
            packetId: result.attached.packet.packetId,
            packetHash: result.attached.packet.packetHash,
          };
        } else {
          this.lastAttachedPacket = null;
          this.lastAttachedStep = null;
        }
      } else {
        // Feature flag off (local only): legacy in-Hub context, unchanged behaviour.
        this.lastAttachedPacket = null;
        this.lastAttachedStep = null;
        const result = await runInSpan(span, () => this.brain.process(envelope, context));
        outputs = normalizeBrainStepResult(result).outputs;
      }
    } catch (error) {
      throw new BrainCallError(error, span, Date.now() - started, envelope.type);
    }

    await getAudit().emit(
      {
        action: 'brain.llm_call',
        outcome: 'success',
        userId: scope.userId,
        threadId: scope.threadId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        durationMs: Date.now() - started,
        details: {
          trigger: envelope.type,
          brain: this.brain.constructor?.name ?? 'brain',
          outputCount: outputs.length,
          held,
          ...(this.lastAttachedStep
            ? {
                packetId: this.lastAttachedStep.packetId,
                stepId: this.lastAttachedStep.stepId,
                stepType: this.lastAttachedStep.stepType,
              }
            : { bridge: this.bridge?.enabled ? 'failed' : 'off' }),
          // Types and sizes only: never the text the brain produced.
          outputs: outputs.slice(0, 20).map(summarizeOutput),
        },
      },
      { tx: client }
    );
    return { outputs, span, held };
  }

  private async auditBrainFailure(
    client: PoolClient,
    scope: AuditScope,
    error: BrainCallError,
    cause: unknown
  ): Promise<void> {
    await getAudit().emit(
      {
        action: 'brain.error',
        outcome: 'failure',
        userId: scope.userId,
        threadId: scope.threadId,
        spanId: error.span.spanId,
        parentSpanId: error.span.parentSpanId,
        errorCode: 'brain_failed',
        errorMessage: cause instanceof Error ? cause.message : String(cause),
        durationMs: error.durationMs,
        details: { trigger: error.trigger },
      },
      { tx: client }
    );
  }

  private async auditInvalidOutput(
    client: PoolClient,
    scope: AuditScope,
    brainSpan: Span,
    output: unknown,
    errorCode = 'invalid_brain_output',
    cause?: unknown
  ): Promise<void> {
    await getAudit().emit(
      {
        action: 'brain.error',
        outcome: 'failure',
        userId: scope.userId,
        threadId: scope.threadId,
        parentSpanId: brainSpan.spanId,
        errorCode,
        ...(cause ? { errorMessage: cause instanceof Error ? cause.message : String(cause) } : {}),
        details: { trigger: scope.commandType, output: summarizeOutput(output) },
      },
      { tx: client }
    );
  }

  /** Audit one stored brain output: reply, explanation, clarification, plan, tool proposal, decision (the invocation itself is brain.llm_call). */
  private async auditBrainOutput(
    client: PoolClient,
    scope: AuditScope,
    brainSpan: Span,
    output: BrainOutput,
    event: Event
  ): Promise<void> {
    const audit = getAudit();
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const askId = typeof payload.askId === 'string' ? payload.askId : undefined;
    const base = { userId: scope.userId, threadId: scope.threadId };
    const tx = { tx: client };

    switch (output.type) {
      case 'reply':
        await audit.emit(
          {
            action: 'brain.reply_generated',
            outcome: 'success',
            ...base,
            parentSpanId: brainSpan.spanId,
            // `details` has the length only; the text goes in `content` (when enabled, secrets masked).
            details: { textLength: output.text.length },
            content: { kind: 'brain_reply', text: output.text },
          },
          tx
        );
        return;

      case 'explain':
        await audit.emit(
          {
            action: 'brain.explanation_generated',
            outcome: 'success',
            ...base,
            parentSpanId: brainSpan.spanId,
            target: { type: 'subject', id: String(output.target).slice(0, 128) },
            details: { textLength: output.explanation.length },
            content: { kind: 'explanation', text: output.explanation },
          },
          tx
        );
        return;

      case 'clarify':
        await audit.emit(
          {
            action: 'brain.clarification_requested',
            outcome: 'success',
            ...base,
            parentSpanId: brainSpan.spanId,
            target: askId ? { type: 'ask', id: askId } : undefined,
            details: { askType: 'clarify', questionCount: output.questions.length },
            content: { kind: 'brain_clarification', text: clarificationText(output) },
          },
          tx
        );
        return;

      case 'plan': {
        const plan = startSpan(brainSpan.spanId);
        await audit.emit(
          {
            action: 'brain.plan_created',
            outcome: 'success',
            ...base,
            spanId: plan.spanId,
            parentSpanId: plan.parentSpanId,
            target: askId ? { type: 'ask', id: askId } : undefined,
            details: { stepCount: output.steps.length, totalCost: output.totalCost ?? null },
          },
          tx
        );
        await audit.emit(
          {
            action: 'approval.requested',
            outcome: 'success',
            ...base,
            parentSpanId: plan.spanId,
            target: askId ? { type: 'ask', id: askId } : undefined,
            details: { askType: 'plan_approval', blocking: true },
          },
          tx
        );
        return;
      }

      case 'tool_call': {
        const tool = startSpan(brainSpan.spanId);
        // The Hub does not execute tools: a tool call is the brain *proposing*
        // one, and with needsApproval it waits for a human ('partial').
        await audit.emit(
          {
            action: 'tool.proposed',
            outcome: output.needsApproval ? 'partial' : 'success',
            ...base,
            spanId: tool.spanId,
            parentSpanId: tool.parentSpanId,
            target: { type: 'tool', id: output.tool },
            riskLevel: output.risk,
            details: {
              tool: output.tool,
              needsApproval: output.needsApproval,
              executed: false,
              // Names only: parameter values can hold ad copy, ids or credentials.
              parameterKeys: Object.keys(output.parameters ?? {}).slice(0, 20),
            },
          },
          tx
        );
        if (output.costImpact) {
          // The proposal itself is the brain's call; the Hub enforces a user's decline (enforceBudgetDecline).
          await audit.emit(
            {
              action: 'budget.evaluated',
              outcome: 'success',
              ...base,
              parentSpanId: tool.spanId,
              target: { type: 'tool', id: output.tool },
              details: {
                decision: output.needsApproval ? 'requires_approval' : 'allowed',
                enforced: false,
                decidedBy: 'brain',
                limit: null,
                spent: output.costImpact.current,
                proposed: output.costImpact.proposed,
                currency: 'USD',
              },
            },
            tx
          );
        }
        if (output.needsApproval) {
          await audit.emit(
            {
              action: 'approval.requested',
              outcome: 'success',
              ...base,
              parentSpanId: tool.spanId,
              target: askId ? { type: 'ask', id: askId } : undefined,
              riskLevel: output.risk,
              details: { askType: 'action_approval', blocking: true, tool: output.tool },
            },
            tx
          );
        }
        return;
      }

      case 'decision':
        await audit.emit(
          {
            action: 'brain.decision_made',
            outcome: 'success',
            ...base,
            parentSpanId: brainSpan.spanId,
            target: { type: 'subject', id: String(output.target).slice(0, 128) },
            riskLevel: output.decision === 'kill' ? 'high' : output.decision === 'change' ? 'medium' : 'low',
            details: {
              decision: output.decision,
              confidence: output.confidence,
              evidenceCount: output.evidence.length,
            },
          },
          tx
        );
        return;

    }
  }

  /** The goal a thread is about (the latest one), if any, and whether an ask carried a cost effect (a budget decision). */
  private async goalAndCostOf(
    client: PoolClient,
    threadId: string | undefined,
    askId: string | undefined
  ): Promise<{ goalId?: string; costEffect?: { current?: unknown; proposed?: unknown; currency?: unknown } }> {
    if (!threadId) return {};
    const goal = await client.query<{ id: string }>(
      'SELECT id FROM goals WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1',
      [threadId]
    );
    let costEffect: { current?: unknown; proposed?: unknown; currency?: unknown } | undefined;
    if (askId && UUID_RE.test(askId)) {
      const ask = await client.query<{ costEffect: Record<string, unknown> | null }>(
        'SELECT cost_effect as "costEffect" FROM asks WHERE id = $1 AND thread_id = $2',
        [askId, threadId]
      );
      costEffect = ask.rows[0]?.costEffect ?? undefined;
    }
    return { goalId: goal.rows[0]?.id, costEffect };
  }

  /** Did the user decline an ask that carried a cost? Decided from the stored ask, never from audit output. */
  private async isBudgetDeclined(
    client: PoolClient,
    threadId: string | undefined,
    askId: string,
    rejected: boolean
  ): Promise<boolean> {
    if (!rejected) return false;
    const { costEffect } = await this.goalAndCostOf(client, threadId, askId);
    return costEffect !== undefined;
  }

  /**
   * The budget was declined, so the brain's tool calls are not applied (the brain may still acknowledge the
   * decision). Recorded as budget.evaluated with enforced: true.
   */
  private async enforceBudgetDecline(
    client: PoolClient,
    scope: AuditScope,
    outputs: BrainOutput[],
    askId: string,
    brainSpan: Span
  ): Promise<BrainOutput[]> {
    const kept = outputs.filter((o) => (o as { type?: unknown } | null)?.type !== 'tool_call');
    const dropped = outputs.length - kept.length;
    if (dropped > 0) logger.warn({ threadId: scope.threadId, askId, dropped }, 'Budget declined: brain tool calls not applied');
    await getAudit().emit(
      {
        action: 'budget.evaluated',
        outcome: 'denied',
        userId: scope.userId,
        threadId: scope.threadId,
        parentSpanId: brainSpan.spanId,
        target: { type: 'ask', id: askId.slice(0, 128) },
        details: { decision: 'declined', enforced: true, decidedBy: 'user', droppedToolCalls: dropped },
      },
      { tx: client }
    );
    return kept;
  }

  /** Audit a budget decision (goal.budget_approved / goal.budget_declined) next to the approval.* event when the ask carried a cost effect. */
  private async auditBudgetDecision(
    client: PoolClient,
    scope: AuditScope,
    askId: string,
    decision: 'approved' | 'declined' | 'edited',
    askType: string,
    parentSpanId?: string
  ): Promise<void> {
    const { goalId, costEffect } = await this.goalAndCostOf(client, scope.threadId, askId);
    if (!costEffect) return;
    const declined = decision === 'declined';
    await getAudit().emit(
      {
        action: declined ? 'goal.budget_declined' : 'goal.budget_approved',
        outcome: 'success',
        userId: scope.userId,
        threadId: scope.threadId,
        ...(goalId ? { goalId } : {}),
        target: { type: 'ask', id: askId.slice(0, 128) },
        parentSpanId,
        details: {
          askType,
          // A declined budget is enforced: the goal does not launch (see enforceBudgetDecline).
          enforced: declined,
          ...(decision === 'edited' ? { edited: true } : {}),
          currentCost: typeof costEffect.current === 'number' ? costEffect.current : null,
          proposedCost: typeof costEffect.proposed === 'number' ? costEffect.proposed : null,
          currency: typeof costEffect.currency === 'string' ? costEffect.currency.slice(0, 8) : null,
        },
      },
      { tx: client }
    );
  }

  /** The user answered an ask: approvals are audited as approval.* (plus goal.budget_* when it carried a cost), clarifications as goal.clarification_answered. */
  private async auditAskAnswered(
    client: PoolClient,
    scope: AuditScope,
    payload: AnswerAskPayload,
    askType: unknown
  ): Promise<void> {
    const audit = getAudit();
    const type = typeof askType === 'string' ? askType : 'unknown';
    const target = { type: 'ask', id: String(payload.askId).slice(0, 128) };
    const base = { userId: scope.userId, threadId: scope.threadId, target };
    if (type === 'plan_approval' || type === 'action_approval') {
      const granted = payload.choice === 'approve';
      const decision = await audit.emit(
        {
          action: granted ? 'approval.granted' : 'approval.rejected',
          outcome: 'success',
          ...base,
          details: { askType: type, choice: String(payload.choice).slice(0, 64) },
        },
        { tx: client }
      );
      // Editing an approval adjusts the budget rather than declining it.
      const budget = payload.choice === 'reject' ? 'declined' : payload.choice === 'edit' ? 'edited' : 'approved';
      await this.auditBudgetDecision(client, scope, String(payload.askId), budget, type, decision?.spanId);
      return;
    }
    const { goalId } = await this.goalAndCostOf(client, scope.threadId, undefined);
    await audit.emit(
      {
        action: 'goal.clarification_answered',
        outcome: 'success',
        ...base,
        ...(goalId ? { goalId } : {}),
        details: { askType: type, answerCount: Object.keys(payload.values ?? {}).length },
      },
      { tx: client }
    );
  }

  /** approve_plan: the user's decision on a plan (approval.granted / approval.rejected). */
  private async auditPlanDecision(
    client: PoolClient,
    scope: AuditScope,
    payload: Record<string, unknown>,
    askResolved: boolean
  ): Promise<void> {
    const approved = payload.approved !== false;
    const decision = await getAudit().emit(
      {
        action: approved ? 'approval.granted' : 'approval.rejected',
        outcome: 'success',
        userId: scope.userId,
        threadId: scope.threadId,
        target: { type: 'plan', id: String(payload.planId ?? 'unknown').slice(0, 128) },
        details: { askType: 'plan_approval', approved, askResolved },
      },
      { tx: client }
    );
    if (typeof payload.planId === 'string') {
      await this.auditBudgetDecision(client, scope, payload.planId, approved ? 'approved' : 'declined', 'plan_approval', decision?.spanId);
    }
  }

  private async auditProcessed(
    client: PoolClient,
    scope: AuditScope,
    startedAt: number,
    events: Event[],
    outcome: 'success' | 'failure' | 'denied',
    errorCode?: string
  ): Promise<void> {
    await getAudit().emit(
      {
        action: 'command.processed',
        outcome,
        userId: scope.userId,
        threadId: scope.threadId,
        durationMs: Date.now() - startedAt,
        ...(errorCode ? { errorCode } : {}),
        details: { commandType: scope.commandType, eventCount: events.length },
      },
      { tx: client }
    );
  }

  private async checkIdempotency(
    client: PoolClient,
    userId: string,
    clientMsgId: string
  ): Promise<Command | null> {
    const result = await client.query<Command>(
      `SELECT id, user_id as "userId", client_msg_id as "clientMsgId", type, 
              thread_id as "threadId", payload, status, processed_at as "processedAt", 
              created_at as "createdAt"
       FROM commands 
       WHERE user_id = $1 AND client_msg_id = $2`,
      [userId, clientMsgId]
    );

    return result.rows[0] || null;
  }

  private async storeCommand(
    client: PoolClient,
    userId: string,
    envelope: CommandEnvelope
  ): Promise<Command | null> {
    const result = await client.query<Command>(
      `INSERT INTO commands (user_id, client_msg_id, type, thread_id, payload, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, client_msg_id) DO NOTHING
       RETURNING id, user_id as "userId", client_msg_id as "clientMsgId", type,
                 thread_id as "threadId", payload, status, processed_at as "processedAt",
                 created_at as "createdAt"`,
      [userId, envelope.clientMsgId, envelope.type, envelope.threadId, toJsonb(envelope.payload), 'accepted']
    );

    return result.rows[0] ?? null;
  }

  private async getCommandEvents(client: PoolClient, commandId: string): Promise<Event[]> {
    const result = await client.query<Event>(
      `SELECT DISTINCT e.id, e.user_id as "userId", e.seq, e.type, e.thread_id as "threadId",
              e.payload, e.ui_payload_id as "uiPayloadId", e.fallback_text as "fallbackText",
              e.created_at as "createdAt"
       FROM events e
       JOIN outbox o ON e.id = o.event_id
       JOIN commands c ON c.id = $1
       WHERE e.user_id = c.user_id
         AND o.created_at >= c.created_at
       ORDER BY e.seq ASC`,
      [commandId]
    );

    return result.rows;
  }

  private async buildContext(
    client: PoolClient,
    userId: string,
    threadId?: string
  ): Promise<BrainContext> {
    let thread: Thread | undefined;
    let messages: Message[] = [];
    let goals: Goal[] = [];

    if (threadId) {
      const threadResult = await client.query<Thread>(
        `SELECT id, user_id as "userId", title, status, 
                created_at as "createdAt", updated_at as "updatedAt"
         FROM threads WHERE id = $1`,
        [threadId]
      );
      thread = threadResult.rows[0];

      const messagesResult = await client.query<Message>(
        `SELECT id, thread_id as "threadId", text, source, created_at as "createdAt"
         FROM messages WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [threadId]
      );
      messages = messagesResult.rows;

      const goalsResult = await client.query<Goal>(
        `SELECT id, user_id as "userId", thread_id as "threadId", title, description,
                constraints, budget, status, progress, metrics,
                created_at as "createdAt", updated_at as "updatedAt"
         FROM goals WHERE thread_id = $1`,
        [threadId]
      );
      goals = goalsResult.rows;
    }

    return { userId, threadId, thread, messages, goals, client };
  }

  private async processBrainOutput(
    client: PoolClient,
    userId: string,
    threadId: string | undefined,
    output: BrainOutput
  ): Promise<Event> {
    const seq = await this.getNextSeq(client, userId);
    
    const eventEnvelope = mapBrainOutputToEvent(output, { seq, threadId });
    
    let uiPayloadId: string | undefined;
    if ('ui' in eventEnvelope && eventEnvelope.ui) {
      const uiResult = await client.query<{ id: string }>(
        'INSERT INTO ui_payloads (component, version, props, actions) VALUES ($1, $2, $3, $4) RETURNING id',
        [
          eventEnvelope.ui.component,
          eventEnvelope.ui.version,
          toJsonb(eventEnvelope.ui.props),
          toJsonb('actions' in eventEnvelope.ui ? eventEnvelope.ui.actions : null),
        ]
      );
      uiPayloadId = uiResult.rows[0].id;
    }

    const eventResult = await client.query<Event>(
      `INSERT INTO events (user_id, seq, type, thread_id, payload, ui_payload_id, fallback_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id as "userId", seq, type, thread_id as "threadId",
                 payload, ui_payload_id as "uiPayloadId", fallback_text as "fallbackText",
                 created_at as "createdAt"`,
      [
        userId,
        seq,
        eventEnvelope.type,
        threadId,
        toJsonb(eventEnvelope.payload),
        uiPayloadId,
        'fallbackText' in eventEnvelope ? eventEnvelope.fallbackText : null,
      ]
    );

    if (eventEnvelope.type === 'ask') {
      await this.createAsk(client, threadId!, eventEnvelope.payload as Record<string, unknown>);
    }

    if (eventEnvelope.type === 'message') {
      const payload = eventEnvelope.payload as Record<string, unknown>;
      await client.query(
        'INSERT INTO messages (thread_id, text, source) VALUES ($1, $2, $3)',
        [threadId, payload.text, payload.source]
      );
    }

    return eventResult.rows[0];
  }

  private async getNextSeq(client: PoolClient, userId: string): Promise<number> {
    const result = await client.query<{ seq: number }>(
      'SELECT get_next_event_seq($1) as seq',
      [userId]
    );
    return result.rows[0].seq;
  }

  private async createAsk(
    client: PoolClient,
    threadId: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO asks (id, thread_id, ask_type, title, description, blocking, risk, cost_effect, questions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        payload.askId,
        threadId,
        payload.askType,
        payload.title,
        payload.description,
        payload.blocking,
        payload.risk,
        toJsonb(payload.costEffect),
        toJsonb(payload.questions),
      ]
    );

    const questions = payload.questions as Array<Record<string, unknown>>;
    for (const question of questions) {
      await client.query(
        `INSERT INTO ask_questions (ask_id, question_id, type, label, required, options, constraints)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          payload.askId,
          question.id,
          question.type,
          question.label,
          question.required ?? true,
          toJsonb(question.options),
          toJsonb(question.constraints),
        ]
      );
    }

    await client.query(
      `INSERT INTO inbox_items (user_id, thread_id, type, title, description, priority, related_ask_id)
       SELECT t.user_id, $1, 'ask', $2, $3, 'high', $4
       FROM threads t WHERE t.id = $1`,
      [threadId, payload.title, payload.description, payload.askId]
    );
  }

  private async handleAskAnswer(
    client: PoolClient,
    userId: string,
    threadId: string,
    payload: AnswerAskPayload
  ): Promise<Event> {
    await client.query(
      `UPDATE asks SET status = 'answered', answered_at = NOW(), answer = $1 WHERE id = $2 AND thread_id = $3`,
      [toJsonb(payload), payload.askId, threadId]
    );

    await client.query(
      `UPDATE inbox_items SET status = 'resolved', updated_at = NOW() 
       WHERE related_ask_id = $1`,
      [payload.askId]
    );

    const seq = await this.getNextSeq(client, userId);
    
    const eventResult = await client.query<Event>(
      `INSERT INTO events (user_id, seq, type, thread_id, payload, created_at)
       VALUES ($1, $2, 'ask_resolved', $3, $4, NOW())
       RETURNING id, user_id as "userId", seq, type, thread_id as "threadId",
                 payload, created_at as "createdAt"`,
      [
        userId,
        seq,
        threadId,
        toJsonb({
          askId: payload.askId,
          resolution: 'answered',
          answer: { choice: payload.choice, ...(payload.values ? { values: payload.values } : {}) },
        }),
      ]
    );
    
    const event = eventResult.rows[0];
    await this.addToOutbox(client, userId, event.id);
    return event;
  }

  private async createGoal(
    client: PoolClient,
    userId: string,
    threadId: string,
    payload: CreateGoalPayload,
    goalId?: string
  ): Promise<GoalRow> {
    const result = await client.query<GoalRow>(
      goalId
        ? `INSERT INTO goals (id, user_id, thread_id, title, description, constraints, budget, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
           RETURNING id, title, status, progress, metrics, budget`
        : `INSERT INTO goals (user_id, thread_id, title, description, constraints, budget, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'active')
           RETURNING id, title, status, progress, metrics, budget`,
      goalId
        ? [
            goalId,
            userId,
            threadId,
            payload.title,
            payload.description,
            toJsonb(payload.constraints),
            toJsonb(payload.budget),
          ]
        : [
            userId,
            threadId,
            payload.title,
            payload.description,
            toJsonb(payload.constraints),
            toJsonb(payload.budget),
          ]
    );
    return result.rows[0];
  }

  private async latestGoal(client: PoolClient, threadId: string): Promise<GoalRow | null> {
    const result = await client.query<GoalRow>(
      `SELECT id, title, status, progress, metrics, budget FROM goals
       WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [threadId]
    );
    return result.rows[0] ?? null;
  }

  /** Persist a goal update and emit goal_updated (with a goal_summary UI) for clients. */
  private async emitGoalUpdated(
    client: PoolClient,
    userId: string,
    threadId: string,
    goal: GoalRow,
    update: BrainGoalUpdate,
    change: 'created' | 'updated'
  ): Promise<Event> {
    const knownStatuses: GoalStatus[] = ['active', 'paused', 'completed', 'cancelled'];
    const status: GoalStatus =
      update.status ?? (knownStatuses.includes(goal.status as GoalStatus) ? (goal.status as GoalStatus) : 'active');
    const progress = update.progress ?? goal.progress ?? undefined;
    const mergedMetrics = update.metrics || goal.metrics ? { ...(goal.metrics ?? {}), ...(update.metrics ?? {}) } : undefined;
    const metrics = mergedMetrics
      ? {
          spend: mergedMetrics.spend ?? 0,
          impressions: mergedMetrics.impressions ?? 0,
          clicks: mergedMetrics.clicks ?? 0,
          conversions: mergedMetrics.conversions ?? 0,
        }
      : undefined;

    await client.query('UPDATE goals SET status = $1, progress = $2, metrics = $3 WHERE id = $4', [
      status,
      toJsonb(progress ?? null),
      toJsonb(metrics ?? null),
      goal.id,
    ]);

    const percent = progress && progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
    const ui = await client.query<{ id: string }>(
      'INSERT INTO ui_payloads (component, version, props, actions) VALUES ($1, $2, $3, $4) RETURNING id',
      [
        'goal_summary',
        '1.0.0',
        toJsonb({
          title: goal.title,
          status,
          progress: percent,
          metrics: {
            spend: metrics?.spend ?? 0,
            budget: goal.budget?.daily ?? 0,
            currency: goal.budget?.currency ?? 'USD',
            ...(metrics
              ? { impressions: metrics.impressions, clicks: metrics.clicks, conversions: metrics.conversions }
              : {}),
          },
        }),
        toJsonb(null),
      ]
    );

    const seq = await this.getNextSeq(client, userId);
    const payload = {
      goalId: goal.id,
      status,
      ...(progress ? { progress } : {}),
      ...(metrics ? { metrics } : {}),
    };
    const eventResult = await client.query<Event>(
      `INSERT INTO events (user_id, seq, type, thread_id, payload, ui_payload_id, fallback_text)
       VALUES ($1, $2, 'goal_updated', $3, $4, $5, $6)
       RETURNING id, user_id as "userId", seq, type, thread_id as "threadId",
                 payload, ui_payload_id as "uiPayloadId", fallback_text as "fallbackText",
                 created_at as "createdAt"`,
      [userId, seq, threadId, toJsonb(payload), ui.rows[0].id, `${goal.title} (${status}, ${percent}%)`]
    );
    const event = eventResult.rows[0];
    await this.addToOutbox(client, userId, event.id);

    // Goal state change: goal.created / goal.updated (+ goal.status_changed when the lifecycle status moved).
    const audit = getAudit();
    const previousStatus = change === 'updated' ? goal.status : undefined;
    const changedFields = (['status', 'progress', 'metrics'] as const).filter((k) => update[k] !== undefined);
    const write = await audit.emit(
      {
        action: change === 'created' ? 'goal.created' : 'goal.updated',
        outcome: 'success',
        userId,
        threadId,
        goalId: goal.id,
        target: { type: 'goal', id: goal.id },
        details:
          change === 'created'
            ? { status, hasBudget: goal.budget !== null, progressPercent: percent }
            : { changedFields, progressPercent: percent },
      },
      { tx: client }
    );
    if (change === 'updated' && previousStatus !== undefined && previousStatus !== status) {
      await audit.emit(
        {
          action: 'goal.status_changed',
          outcome: 'success',
          userId,
          threadId,
          goalId: goal.id,
          target: { type: 'goal', id: goal.id },
          parentSpanId: write?.spanId,
          details: { from: previousStatus, to: status },
        },
        { tx: client }
      );
    }
    if (change === 'created' && goal.budget) {
      // The user proposed a budget with the goal. The Hub records it but does not enforce it yet.
      await audit.emit(
        {
          action: 'goal.budget_proposed',
          outcome: 'success',
          userId,
          threadId,
          goalId: goal.id,
          target: { type: 'goal', id: goal.id },
          parentSpanId: write?.spanId,
          details: {
            proposedBy: 'user',
            enforced: false,
            dailyBudget: goal.budget.daily ?? null,
            totalBudget: goal.budget.total ?? null,
            currency: goal.budget.currency ?? 'USD',
          },
        },
        { tx: client }
      );
    }
    return event;
  }

  /** answer_ask payloads from clients omit askType; add it from the stored ask. */
  private async withAskType(client: PoolClient, envelope: CommandEnvelope): Promise<CommandEnvelope> {
    const payload = envelope.payload as unknown as Record<string, unknown>;
    if (typeof payload.askType === 'string' || typeof payload.askId !== 'string' || !UUID_RE.test(payload.askId)) {
      return envelope;
    }
    const result = await client.query<{ askType: string }>(
      'SELECT ask_type as "askType" FROM asks WHERE id = $1 AND thread_id = $2',
      [payload.askId, envelope.threadId]
    );
    if (result.rows.length === 0) return envelope;
    return { ...envelope, payload: { ...payload, askType: result.rows[0].askType } };
  }

  /** Mark the plan_approval ask behind an approve_plan command as answered. */
  private async resolvePlanAsk(
    client: PoolClient,
    userId: string,
    threadId: string | undefined,
    payload: Record<string, unknown>
  ): Promise<Event | null> {
    const planId = payload.planId;
    if (!threadId || typeof planId !== 'string' || !UUID_RE.test(planId)) return null;
    const choice = payload.approved === false ? 'reject' : 'approve';
    const updated = await client.query(
      `UPDATE asks SET status = 'answered', answered_at = NOW(), answer = $1
       WHERE id = $2 AND thread_id = $3 AND ask_type = 'plan_approval' AND status = 'pending'
       RETURNING id`,
      [toJsonb({ askId: planId, choice }), planId, threadId]
    );
    if (updated.rowCount === 0) return null;

    await client.query(
      `UPDATE inbox_items SET status = 'resolved', updated_at = NOW() WHERE related_ask_id = $1`,
      [planId]
    );
    const seq = await this.getNextSeq(client, userId);
    const eventResult = await client.query<Event>(
      `INSERT INTO events (user_id, seq, type, thread_id, payload, created_at)
       VALUES ($1, $2, 'ask_resolved', $3, $4, NOW())
       RETURNING id, user_id as "userId", seq, type, thread_id as "threadId",
                 payload, created_at as "createdAt"`,
      [userId, seq, threadId, toJsonb({ askId: planId, resolution: 'answered', answer: { choice } })]
    );
    const event = eventResult.rows[0];
    await this.addToOutbox(client, userId, event.id);
    return event;
  }

  private async processControl(
    client: PoolClient,
    userId: string,
    command: Command,
    envelope: CommandEnvelope,
    startedAt: number
  ): Promise<{ command: Command; events: Event[] }> {
    const payload = envelope.payload as ControlPayload;

    // Persist the state before anything else, under an exclusive lock: commands already past the gate finish
    // first, every later one sees paused/stopped until a resume.
    const previousState = await lockExecutionState(client, userId, 'update');
    const executionState = nextExecutionState(previousState, payload.action);
    await saveExecutionState(client, userId, executionState, command.id);

    const seq = await this.getNextSeq(client, userId);
    
    const eventResult = await client.query<Event>(
      `INSERT INTO events (user_id, seq, type, thread_id, payload)
       VALUES ($1, $2, 'status', $3, $4)
       RETURNING id, user_id as "userId", seq, type, thread_id as "threadId",
                 payload, ui_payload_id as "uiPayloadId", fallback_text as "fallbackText",
                 created_at as "createdAt"`,
      [
        userId,
        seq,
        envelope.threadId,
        toJsonb({
          state: payload.action,
          executionState,
          message: `Execution ${payload.action}`,
        }),
      ]
    );

    const event = eventResult.rows[0];
    await this.addToOutbox(client, userId, event.id);

    await client.query(
      'UPDATE commands SET status = $1, processed_at = NOW() WHERE id = $2',
      ['processed', command.id]
    );

    // Pause / resume / emergency stop. The Hub's `kill` command stops everything in
    // its scope, so it is control.emergency_stopped (control.killed is for one goal/run).
    // The scope is the whole workspace: the state is stored per user, not per thread.
    const scope: AuditScope = { userId, threadId: envelope.threadId, commandType: envelope.type };
    const controlAction = CONTROL_AUDIT_ACTIONS[payload.action];
    if (controlAction) {
      await getAudit().emit(
        {
          action: controlAction,
          outcome: 'success',
          userId,
          threadId: envelope.threadId,
          target: { type: 'execution_state', id: userId },
          tags: payload.action === 'kill' ? ['emergency_stop'] : [payload.action],
          details: { control: payload.action, scope: 'workspace', previousState, executionState },
        },
        { tx: client }
      );
    }
    await this.auditProcessed(client, scope, startedAt, [event], 'success');

    return { command, events: [event] };
  }

  /** The workspace is paused or stopped: the command is refused before the brain, with an error event and an audit trail. */
  private async rejectWhileHalted(
    client: PoolClient,
    userId: string,
    command: Command,
    scope: AuditScope,
    executionState: ExecutionState,
    startedAt: number
  ): Promise<{ command: Command; events: Event[] }> {
    const code = executionState === 'stopped' ? 'execution_stopped' : 'execution_paused';
    const message =
      executionState === 'stopped'
        ? 'Execution was stopped. Resume to continue.'
        : 'Execution is paused. Resume to continue.';
    logger.info({ userId, commandType: scope.commandType, executionState }, 'Command refused: execution halted');

    const errorEvent = await this.createErrorEvent(client, userId, scope.threadId, code, message);
    await this.addToOutbox(client, userId, errorEvent.id);
    await client.query('UPDATE commands SET status = $1, processed_at = NOW() WHERE id = $2', ['rejected', command.id]);

    const audit = getAudit();
    await audit.emit(
      {
        action: 'command.rejected',
        outcome: 'denied',
        userId,
        threadId: scope.threadId,
        target: { type: 'command', id: command.id },
        errorCode: code,
        details: { commandType: scope.commandType, reason: code, executionState },
      },
      { tx: client }
    );
    await this.auditProcessed(client, scope, startedAt, [errorEvent], 'denied', code);
    return { command: { ...command, status: 'rejected' }, events: [errorEvent] };
  }

  /** The text a user typed joins the thread's messages (source 'user'); brain replies are stored when they are emitted. */
  private async storeUserMessage(client: PoolClient, envelope: CommandEnvelope): Promise<void> {
    const text = (envelope.payload as { text?: unknown } | null)?.text;
    if (!envelope.threadId || typeof text !== 'string') return;
    await client.query('INSERT INTO messages (thread_id, text, source) VALUES ($1, $2, $3)', [
      envelope.threadId,
      text,
      'user',
    ]);
  }

  private async createErrorEvent(
    client: PoolClient,
    userId: string,
    threadId: string | undefined,
    code: string,
    message: string
  ): Promise<Event> {
    const seq = await this.getNextSeq(client, userId);
    
    const result = await client.query<Event>(
      `INSERT INTO events (user_id, seq, type, thread_id, payload)
       VALUES ($1, $2, 'error', $3, $4)
       RETURNING id, user_id as "userId", seq, type, thread_id as "threadId",
                 payload, ui_payload_id as "uiPayloadId", fallback_text as "fallbackText",
                 created_at as "createdAt"`,
      [userId, seq, threadId, toJsonb({ code, message })]
    );

    return result.rows[0];
  }

  private async addToOutbox(
    client: PoolClient,
    userId: string,
    eventId: string
  ): Promise<void> {
    await client.query(
      'INSERT INTO outbox (user_id, event_id) VALUES ($1, $2)',
      [userId, eventId]
    );
  }
}
