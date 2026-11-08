import { randomUUID } from 'node:crypto';
import { isBrainOutput, type BrainOutput, type CommandEnvelope, type StepType } from '@smallseedlabs/proba-protocol';
import type { AssertionMinter } from '../auth/assertions/mint.js';
import type { GatewayTokenMinter } from '../auth/gateway-token.js';
import { currentTrace } from '../audit/trace.js';
import { logger } from '../logger.js';
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
}

const RESUME_ASK_TYPES = new Set(['action_approval', 'plan_approval']);

export class GatewayBrain extends BaseBrainPort implements BrainPort {
  readonly ownsExternalContext = true;

  constructor(private readonly options: GatewayBrainOptions) {
    super();
  }

  async process(command: CommandEnvelope, context: BrainContext): Promise<BrainOutput[]> {
    const workspaceId = this.options.workspaceId;
    const userId = context.userId;
    const threadId = context.threadId ?? command.threadId;
    const goalId = context.goals?.[context.goals.length - 1]?.id;
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

    const base = pending ? pending.request : this.buildRequest(command, context, { workspaceId, userId, threadId, goalId });
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

    if (snapshot.status === 'awaiting_approval' || snapshot.status === 'completed') {
      return outputsOf(snapshot);
    }
    if (snapshot.status === 'blocked' || snapshot.status === 'failed' || snapshot.status === 'ambiguous') {
      throw new GatewayClientError(
        snapshot.error?.code ?? snapshot.status,
        snapshot.error?.message ?? `gateway run ${snapshot.status}`,
        undefined,
        snapshot.error?.retryable ?? snapshot.status === 'blocked'
      );
    }
    if (snapshot.status === 'cancelled' || snapshot.status === 'paused' || snapshot.status === 'stopped') {
      return outputsOf(snapshot);
    }
    throw new GatewayClientError('gateway_error', `gateway run status ${snapshot.status} is not a Hub brain result`);
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

  private buildRequest(
    command: CommandEnvelope,
    context: BrainContext,
    ids: { workspaceId: string; userId: string; threadId?: string; goalId?: string }
  ): GatewayRunRequest {
    const stepType = (context.stepType ?? mapCommandToStepType(command)) as StepType;
    const stepId = context.stepId ?? randomUUID();
    const traceId = currentTrace()?.traceId ?? command.clientMsgId;
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
  const raw = snapshot.outputs ?? [];
  const outputs = raw
    .filter((item): item is BrainOutput => isBrainOutput(item))
    .map((item) =>
      askId && item.type === 'tool_call' && 'needsApproval' in item && item.needsApproval
        ? { ...item, askId }
        : item
    );
  if (askId && snapshot.status === 'awaiting_approval' && !outputs.some((item) => item.type === 'tool_call')) {
    const verb = firstApprovalVerb(snapshot);
    outputs.push({
      type: 'tool_call',
      tool: verb,
      parameters: {},
      needsApproval: true,
      risk: 'medium',
      askId,
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
