import { randomUUID } from 'node:crypto';
import {
  RESEARCH_ACCEPT_VERB,
  isBrainOutput,
  type BrainOutput,
  type CommandEnvelope,
  type StepType,
} from '@smallseedlabs/proba-protocol';
import type { AssertionMinter } from '../auth/assertions/mint.js';
import type { GatewayTokenMinter } from '../auth/gateway-token.js';
import { currentTrace } from '../audit/trace.js';
import { logger } from '../logger.js';
import { userSuppliedInputFromCommand } from '../research/user-input.js';
import type { BrainContext, BrainPort, GatewayAbortReason } from '../types.js';
import { BaseBrainPort } from './port.js';
import type { GatewayClient, GatewayRunRequest, GatewayRunSnapshot } from './gateway-client.js';
import { GatewayClientError } from './gateway-client.js';
import { approvalAskIdFromSnapshot } from './gateway-ask-identity.js';
import {
  durableGatewayRequest,
  type GatewayRunRecord,
  type GatewayRunStore,
} from './gateway-run-store.js';
import { researchReviewFromSnapshot } from './research-snapshot.js';
import { mapCommandToStepType } from './step-type.js';

export interface GatewayBrainAudit {
  emit(
    draft: {
      action: 'approval.expired';
      outcome: 'denied' | 'failure';
      userId?: string;
      workspaceId?: string;
      threadId?: string;
      goalId?: string;
      target?: { type: string; id: string };
      errorCode?: string;
      details?: Record<string, unknown>;
    },
    options?: { bestEffort?: boolean }
  ): Promise<unknown>;
}

export interface GatewayBrainOptions {
  client: GatewayClient;
  serviceTokens: GatewayTokenMinter;
  assertions: AssertionMinter | null;
  workspaceId: string;
  tokenTtlSeconds: number;
  store: GatewayRunStore;
  audit?: GatewayBrainAudit;
  budget?: Record<string, unknown>;
  getConnectedPlatforms?: (workspaceId: string) => Promise<string[]>;
  onCampaignCreated?: (info: {
    workspaceId: string;
    userId: string;
    goalId?: string;
    threadId?: string;
    outcome: Record<string, unknown>;
  }) => Promise<void>;
}

const RESUME_ASK_TYPES = new Set(['action_approval', 'plan_approval', 'research_review']);

export class GatewayBrain extends BaseBrainPort implements BrainPort {
  readonly ownsExternalContext = true;

  constructor(private readonly options: GatewayBrainOptions) {
    super();
  }

  async process(command: CommandEnvelope, context: BrainContext): Promise<BrainOutput[]> {
    const workspaceId = this.options.workspaceId;
    const userId = context.userId;
    const threadId = context.threadId ?? command.threadId;
    const goalId = context.pendingGoalId ?? context.goals?.[context.goals.length - 1]?.id;
    const token = await this.options.serviceTokens.mint({
      workspaceId,
      ttlSeconds: this.options.tokenTtlSeconds,
    });

    const resume = resumeFromCommand(command);
    const pending = resume
      ? await this.bindResume(resume, { workspaceId, userId, threadId, goalId })
      : await this.options.store.getByIdempotency({
          workspaceId,
          userId,
          idempotencyKey: command.clientMsgId,
        });

    const base = pending
      ? resume
        ? withCurrentOperatorScope(pending.request, context.userSuppliedInput)
        : pending.request
      : await this.buildRequest(command, context, { workspaceId, userId, threadId, goalId });
    const request: GatewayRunRequest = {
      ...durableGatewayRequest(base),
      ...(resume ? { resume } : {}),
      actAsAssertion: await this.maybeMintActAs({ workspaceId, userId, goalId, threadId }),
    };

    const snapshot = await this.options.client.createRun(request, token);
    await this.options.store.upsert({
      workspaceId,
      userId,
      idempotencyKey: request.idempotencyKey,
      runId: snapshot.runId,
      ...(goalId ? { goalId } : {}),
      ...(threadId ? { threadId } : {}),
      askId: approvalAskIdFromSnapshot(snapshot) ?? pending?.askId,
      status: snapshot.status,
      request,
    });

    logger.info(
      { userId, threadId, runId: snapshot.runId, status: snapshot.status, stepType: request.stepType },
      'gateway run finished'
    );

    if (
      this.options.onCampaignCreated &&
      snapshot.actionOutcome &&
      snapshot.actionOutcome.verb === 'ads.create_campaign' &&
      snapshot.actionOutcome.ok === true
    ) {
      try {
        await this.options.onCampaignCreated({
          workspaceId,
          userId,
          goalId: goalId ?? pending?.goalId,
          threadId: threadId ?? pending?.threadId,
          outcome: snapshot.actionOutcome,
        });
      } catch (err) {
        logger.warn({ err, userId, threadId, runId: snapshot.runId }, 'failed to auto-register analytics campaign');
      }
    }

    const nextUrl = resume?.choice === 'edit' ? userSuppliedInputFromCommand(command) : undefined;
    if (nextUrl && pending) {
      const gathered = await this.regatherAfterEdit({
        token,
        pending,
        nextUrl,
        command,
        ids: { workspaceId, userId, threadId, goalId },
      });
      return this.outputsOrThrow(gathered);
    }

    return this.outputsOrThrow(snapshot, { resumed: !!resume });
  }

  /**
   * A resumed run that ends blocked/failed/ambiguous has left awaiting_approval, so bindResume
   * will refuse the same ask next time (approval_expired): the error says so (runStatus), and
   * Hub closes the card instead of reopening it.
   */
  private outputsOrThrow(snapshot: GatewayRunSnapshot, options: { resumed?: boolean } = {}): BrainOutput[] {
    if (snapshot.status === 'awaiting_approval' || snapshot.status === 'completed') {
      return outputsOf(snapshot);
    }
    if (snapshot.status === 'blocked' || snapshot.status === 'failed' || snapshot.status === 'ambiguous') {
      throw new GatewayClientError(
        snapshot.error?.code ?? snapshot.status,
        snapshot.error?.message ?? `gateway run ${snapshot.status}`,
        undefined,
        snapshot.error?.retryable ?? snapshot.status === 'blocked',
        snapshot.status,
        options.resumed === true
      );
    }
    if (snapshot.status === 'cancelled' || snapshot.status === 'paused' || snapshot.status === 'stopped') {
      return outputsOf(snapshot);
    }
    throw new GatewayClientError('gateway_error', `gateway run status ${snapshot.status} is not a Hub brain result`);
  }

  /**
   * Edit invalidates the bound artifact on the original run (same fingerprint /
   * userSuppliedInput). A new operator URL is a new input revision: Hub starts a
   * new run rather than changing the URL on the resumed idempotency key.
   */
  private async regatherAfterEdit(input: {
    token: string;
    pending: GatewayRunRecord;
    nextUrl: { landingPageUrl: string };
    command: CommandEnvelope;
    ids: { workspaceId: string; userId: string; threadId?: string; goalId?: string };
  }): Promise<GatewayRunSnapshot> {
    const original = durableGatewayRequest(input.pending.request);
    const originalCommand =
      original.command && typeof original.command === 'object' && !Array.isArray(original.command)
        ? (original.command as CommandEnvelope)
        : input.command;
    const originalPayload =
      originalCommand.payload && typeof originalCommand.payload === 'object' && !Array.isArray(originalCommand.payload)
        ? (originalCommand.payload as Record<string, unknown>)
        : {};
    const nextRequest: GatewayRunRequest = {
      ...original,
      traceId: currentTrace()?.traceId ?? input.command.clientMsgId,
      workspaceId: input.ids.workspaceId,
      userId: input.ids.userId,
      ...(input.ids.goalId ? { goalId: input.ids.goalId } : {}),
      ...(input.ids.threadId ? { threadId: input.ids.threadId } : {}),
      stepId: randomUUID(),
      stepType: 'interpret_message',
      command: {
        ...originalCommand,
        clientMsgId: input.command.clientMsgId,
        payload: { ...originalPayload, userSuppliedInput: input.nextUrl },
      },
      idempotencyKey: input.command.clientMsgId,
      userSuppliedInput: input.nextUrl,
    };
    const snapshot = await this.options.client.createRun(nextRequest, input.token);
    await this.options.store.upsert({
      workspaceId: input.ids.workspaceId,
      userId: input.ids.userId,
      idempotencyKey: nextRequest.idempotencyKey,
      runId: snapshot.runId,
      ...(input.ids.goalId ? { goalId: input.ids.goalId } : {}),
      ...(input.ids.threadId ? { threadId: input.ids.threadId } : {}),
      askId: approvalAskIdFromSnapshot(snapshot),
      status: snapshot.status,
      request: nextRequest,
    });
    logger.info(
      { userId: input.ids.userId, threadId: input.ids.threadId, runId: snapshot.runId, status: snapshot.status },
      'gateway re-gather after research edit'
    );
    return snapshot;
  }

  async cancelActive(reason: GatewayAbortReason, context: { userId: string; threadId?: string }): Promise<void> {
    const workspaceId = this.options.workspaceId;
    const rows = await this.options.store.listCancellable({ workspaceId, userId: context.userId });
    if (rows.length === 0) return;
    const token = await this.options.serviceTokens.mint({
      workspaceId,
      ttlSeconds: this.options.tokenTtlSeconds,
    });
    const failures: unknown[] = [];
    for (const row of rows) {
      try {
        const snapshot = await this.options.client.cancelRun(row.runId, reason, token);
        await this.options.store.upsert({ ...row, status: snapshot.status, request: durableGatewayRequest(row.request) });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  }

  private async bindResume(
    resume: NonNullable<GatewayRunRequest['resume']>,
    ids: { workspaceId: string; userId: string; threadId?: string; goalId?: string }
  ): Promise<GatewayRunRecord> {
    const pending = await this.options.store.getByAsk({
      workspaceId: ids.workspaceId,
      userId: ids.userId,
      askId: resume.askId,
    });
    if (!pending || pending.status !== 'awaiting_approval') {
      await this.auditExpired(ids, resume.askId, 'approval_expired', pending?.runId, pending?.status);
      throw new GatewayClientError('approval_expired', 'no awaiting approval bound to this ask');
    }
    if (pending.userId !== ids.userId || pending.workspaceId !== ids.workspaceId) {
      await this.auditExpired(ids, resume.askId, 'approval_mismatch', pending.runId, pending.status);
      throw new GatewayClientError('approval_mismatch', 'askId does not match bound operation');
    }
    if (ids.threadId && pending.threadId && pending.threadId !== ids.threadId) {
      await this.auditExpired(ids, resume.askId, 'approval_mismatch', pending.runId, pending.status);
      throw new GatewayClientError('approval_mismatch', 'askId does not match bound operation');
    }
    if (ids.goalId && pending.goalId && pending.goalId !== ids.goalId) {
      await this.auditExpired(ids, resume.askId, 'approval_mismatch', pending.runId, pending.status);
      throw new GatewayClientError('approval_mismatch', 'askId does not match bound operation');
    }
    if (pending.askId && pending.askId !== resume.askId) {
      await this.auditExpired(ids, resume.askId, 'approval_mismatch', pending.runId, pending.status);
      throw new GatewayClientError('approval_mismatch', 'askId does not match bound operation');
    }
    return pending;
  }

  private async auditExpired(
    ids: { workspaceId: string; userId: string; threadId?: string; goalId?: string },
    askId: string,
    errorCode: 'approval_expired' | 'approval_mismatch',
    runId?: string,
    status?: string
  ): Promise<void> {
    if (!this.options.audit) return;
    await this.options.audit.emit(
      {
        action: 'approval.expired',
        outcome: 'denied',
        userId: ids.userId,
        workspaceId: ids.workspaceId,
        threadId: ids.threadId,
        goalId: ids.goalId,
        target: { type: 'ask', id: askId },
        errorCode,
        details: {
          reason: errorCode,
          ...(runId ? { runId } : {}),
          ...(status ? { status } : {}),
        },
      },
      { bestEffort: true }
    );
  }

  private async buildRequest(
    command: CommandEnvelope,
    context: BrainContext,
    ids: { workspaceId: string; userId: string; threadId?: string; goalId?: string }
  ): Promise<GatewayRunRequest> {
    const stepType = (context.stepType ?? mapCommandToStepType(command)) as StepType;
    const stepId = context.stepId ?? randomUUID();
    const traceId = currentTrace()?.traceId ?? command.clientMsgId;
    const rawUserSuppliedInput = context.userSuppliedInput ?? userSuppliedInputFromCommand(command);
    const connectedPlatforms = this.options.getConnectedPlatforms
      ? await this.options.getConnectedPlatforms(ids.workspaceId).catch(() => [])
      : [];
    const userSuppliedInput =
      rawUserSuppliedInput && connectedPlatforms.length > 0
        ? { ...rawUserSuppliedInput, connectedPlatforms }
        : rawUserSuppliedInput;
    return {
      traceId,
      workspaceId: ids.workspaceId,
      userId: ids.userId,
      ...(ids.goalId ? { goalId: ids.goalId } : {}),
      ...(ids.threadId ? { threadId: ids.threadId } : {}),
      stepId,
      stepType,
      command: scopedCommand(command, ids.workspaceId),
      idempotencyKey: command.clientMsgId,
      ...(userSuppliedInput ? { userSuppliedInput } : {}),
      ...(this.options.budget ? { budget: this.options.budget } : {}),
    };
  }

  private async maybeMintActAs(ids: {
    workspaceId: string;
    userId: string;
    goalId?: string;
    threadId?: string;
  }): Promise<string | undefined> {
    if (!this.options.assertions || !ids.goalId || !ids.threadId) return undefined;
    const { token } = await this.options.assertions.mint({
      userId: ids.userId,
      workspaceId: ids.workspaceId,
      goalId: ids.goalId,
      threadId: ids.threadId,
      scopes: ['context:build'],
    });
    return token;
  }
}

function resumeFromCommand(command: CommandEnvelope): GatewayRunRequest['resume'] | undefined {
  if (command.type === 'answer_ask') {
    const payload = command.payload as {
      askId?: string;
      choice?: string;
      values?: Record<string, unknown>;
      edit?: string;
      askType?: string;
    };
    if (typeof payload.askId !== 'string') return undefined;
    if (payload.askType && !RESUME_ASK_TYPES.has(payload.askType) && payload.askType !== 'clarify') {
      return undefined;
    }
    if (payload.askType === 'clarify') return undefined;
    const choice = payload.choice === 'approve' || payload.choice === 'reject' || payload.choice === 'edit' ? payload.choice : undefined;
    if (!choice) return undefined;
    return {
      askId: payload.askId,
      choice,
      ...(payload.values ? { values: payload.values } : {}),
      ...(typeof payload.edit === 'string' ? { edit: payload.edit } : {}),
    };
  }
  if (command.type === 'approve_plan') {
    const payload = command.payload as { planId?: string; approved?: boolean };
    if (typeof payload.planId !== 'string') return undefined;
    return {
      askId: payload.planId,
      choice: payload.approved === false ? 'reject' : 'approve',
      planId: payload.planId,
      approved: payload.approved !== false,
    };
  }
  return undefined;
}

/**
 * On an approval resume the stored request is replayed, but the operator may have saved
 * post copy / targeting for the goal since the run was created (PUT /v1/goals/:id/creative).
 * Carry the goal's current creative/targeting; the landing URL stays the stored one (a new
 * URL is an edit, a new input revision). The gateway binds everything else on resume.
 */
export function withCurrentOperatorScope(
  stored: GatewayRunRequest,
  current: BrainContext['userSuppliedInput']
): GatewayRunRequest {
  const storedInput = stored.userSuppliedInput;
  if (!storedInput || !current || current.landingPageUrl !== storedInput.landingPageUrl) return stored;
  const { creative: _creative, targeting: _targeting, ...rest } = storedInput;
  return {
    ...stored,
    userSuppliedInput: {
      ...rest,
      ...(current.creative ? { creative: current.creative } : {}),
      ...(current.targeting ? { targeting: current.targeting } : {}),
    },
  };
}

function scopedCommand(command: CommandEnvelope, workspaceId: string): CommandEnvelope {
  const payload = command.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return command;
  const record = payload as Record<string, unknown>;
  if (!('workspaceId' in record) || record.workspaceId === workspaceId) return command;
  const next = { ...record };
  delete next.workspaceId;
  return { ...command, payload: next } as CommandEnvelope;
}

function outputsOf(snapshot: GatewayRunSnapshot): BrainOutput[] {
  const askId = approvalAskIdFromSnapshot(snapshot);
  const researchReview = researchReviewFromSnapshot(snapshot);
  const raw = snapshot.outputs ?? [];
  const outputs = raw
    .filter((item): item is BrainOutput => isBrainOutput(item))
    .map((item) => {
      if (!(askId && item.type === 'tool_call' && 'needsApproval' in item && item.needsApproval)) return item;
      if (item.tool === RESEARCH_ACCEPT_VERB) {
        return { ...item, askId, ...(researchReview ? { researchReview } : {}) };
      }
      return { ...item, askId };
    });
  if (askId && snapshot.status === 'awaiting_approval' && !outputs.some((item) => item.type === 'tool_call')) {
    const verb = firstApprovalVerb(snapshot);
    outputs.push({
      type: 'tool_call',
      tool: verb,
      parameters: researchReview && verb === RESEARCH_ACCEPT_VERB ? { ...researchReview } : {},
      needsApproval: true,
      risk: verb === RESEARCH_ACCEPT_VERB ? 'high' : 'medium',
      askId,
      ...(researchReview && verb === RESEARCH_ACCEPT_VERB ? { researchReview } : {}),
    } as BrainOutput);
  }
  return outputs;
}

function firstApprovalVerb(snapshot: GatewayRunSnapshot): string {
  const needs = snapshot.needs;
  if (!Array.isArray(needs)) return 'action';
  for (const item of needs) {
    if (item && typeof item === 'object') {
      const verb = (item as { verb?: unknown }).verb;
      if (typeof verb === 'string' && verb.trim()) return verb;
    }
  }
  return 'action';
}
