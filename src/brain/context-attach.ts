import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  BrainOutput,
  CommandEnvelope,
  ContextNeed,
  ContextPacket,
  ContextRequest,
  StepType,
} from '@smallseedlabs/proba-protocol';
import type { AssertionMinter } from '../auth/assertions/mint.js';
import { config, DEFAULT_WORKSPACE_ID, type ContextBridgeOnFailure } from '../config.js';
import { getAudit } from '../audit/service.js';
import { currentTrace, type Span } from '../audit/trace.js';
import { logger } from '../logger.js';
import type { BrainContext, BrainPort, BrainStepResult } from '../types.js';
import { normalizeBrainStepResult } from '../types.js';
import { ContextClientError, type ContextClient } from './context-client.js';
import { mapCommandToStepType, type HubStepEvent } from './step-type.js';

export interface ContextBridgeRuntime {
  enabled: boolean;
  client: ContextClient;
  minter: AssertionMinter | null;
  maxNeedRounds: number;
  onFailure: ContextBridgeOnFailure;
  workspaceId: string;
}

export interface AttachedStepContext {
  stepId: string;
  stepType: StepType;
  packet: ContextPacket;
  /** Packet ids from each bridge round (first = Phase A, then hybrid). */
  packetIds: string[];
}

export interface AttachContextInput {
  client: PoolClient;
  scope: { userId: string; threadId?: string; commandType: string };
  envelope: CommandEnvelope;
  context: BrainContext;
  brainSpan: Span;
  askType?: string;
  hubEvent?: HubStepEvent;
  /** Pre-allocated goal id (create_goal before the row exists). */
  goalId?: string;
  needs?: ContextNeed[];
  /** Same stepId across hybrid rounds. */
  stepId?: string;
  stepType?: StepType;
}

/**
 * Mint an act-as assertion and call POST /v1/context/build. Never builds context
 * in-process: the bridge is the only source.
 */
export async function buildContextPacket(
  runtime: ContextBridgeRuntime,
  input: AttachContextInput
): Promise<AttachedStepContext> {
  const stepId = input.stepId ?? randomUUID();
  const stepType =
    input.stepType ??
    mapCommandToStepType(input.envelope, { askType: input.askType, hubEvent: input.hubEvent });

  const goalId = input.goalId ?? input.context.goals?.[input.context.goals.length - 1]?.id;
  const threadId = input.context.threadId ?? input.envelope.threadId;
  const traceId = currentTrace()?.traceId;

  if (!goalId || !threadId || !traceId) {
    throw new ContextClientError(
      'rejected',
      !goalId
        ? 'No goal is available for the context bridge request'
        : !threadId
          ? 'No thread is available for the context bridge request'
          : 'No traceId is available for the context bridge request'
    );
  }
  if (!runtime.minter) {
    throw new ContextClientError('rejected', 'Act-as assertion minting is not configured');
  }

  const { token } = await runtime.minter.mint({
    userId: input.scope.userId,
    workspaceId: runtime.workspaceId,
    goalId,
    threadId,
    scopes: ['context:build'],
  });

  const request: ContextRequest = {
    traceId,
    workspaceId: runtime.workspaceId,
    userId: input.scope.userId,
    goalId,
    threadId,
    stepId,
    stepType,
    ...(input.needs?.length ? { needs: input.needs } : {}),
  };

  const packet = await runtime.client.build(request, { assertion: token });
  return { stepId, stepType, packet, packetIds: [packet.packetId] };
}

/** Emit brain.context_attached on the step span before brain output events. */
export async function emitContextAttached(
  client: PoolClient,
  scope: { userId: string; threadId?: string },
  brainSpan: Span,
  attached: AttachedStepContext,
  goalId?: string
): Promise<void> {
  await getAudit().emit(
    {
      action: 'brain.context_attached',
      outcome: 'success',
      userId: scope.userId,
      threadId: scope.threadId,
      ...(goalId ? { goalId } : {}),
      spanId: brainSpan.spanId,
      parentSpanId: brainSpan.parentSpanId,
      details: {
        packetId: attached.packet.packetId,
        packetHash: attached.packet.packetHash,
        stepId: attached.stepId,
        stepType: attached.stepType,
        configVersion: attached.packet.configVersion,
      },
    },
    { tx: client }
  );
}

/** Emit context.build_failed when the bridge cannot supply a packet. */
export async function emitContextBuildFailed(
  client: PoolClient,
  scope: { userId: string; threadId?: string; commandType: string },
  brainSpan: Span,
  error: unknown,
  meta: { stepId: string; stepType: StepType; goalId?: string }
): Promise<void> {
  const code = error instanceof ContextClientError ? error.code : 'http_error';
  const message = error instanceof Error ? error.message : String(error);
  await getAudit().emit(
    {
      action: 'context.build_failed',
      outcome: 'failure',
      userId: scope.userId,
      threadId: scope.threadId,
      ...(meta.goalId ? { goalId: meta.goalId } : {}),
      spanId: brainSpan.spanId,
      parentSpanId: brainSpan.parentSpanId,
      errorCode: code,
      errorMessage: message.slice(0, 500),
      details: {
        stepId: meta.stepId,
        stepType: meta.stepType,
        trigger: scope.commandType,
      },
    },
    { tx: client }
  );
}

export function bridgeFailureOutputs(onFailure: ContextBridgeOnFailure): BrainOutput[] {
  if (onFailure === 'hold') return [];
  return [
    {
      type: 'clarify',
      reason: 'I could not load the workspace context for this step. Please try again in a moment.',
      questions: [
        {
          id: 'retry_context',
          text: 'Should I try again once the context service is available?',
          type: 'confirm',
        },
      ],
    },
  ];
}

/**
 * Build (and optionally rebuild) context via the bridge, then run the brain with
 * the packet as its only context input. Caps hybrid needs rounds.
 */
export async function runBrainWithBridge(options: {
  runtime: ContextBridgeRuntime;
  brain: BrainPort;
  client: PoolClient;
  scope: { userId: string; threadId?: string; commandType: string };
  envelope: CommandEnvelope;
  context: BrainContext;
  brainSpan: Span;
  askType?: string;
  hubEvent?: HubStepEvent;
  goalId?: string;
}): Promise<{ outputs: BrainOutput[]; attached: AttachedStepContext | null; held: boolean }> {
  const { runtime, brain, client, scope, envelope, context, brainSpan } = options;
  const stepId = randomUUID();
  const stepType = mapCommandToStepType(envelope, {
    askType: options.askType,
    hubEvent: options.hubEvent,
  });
  const goalId = options.goalId ?? context.goals?.[context.goals.length - 1]?.id;

  let attached: AttachedStepContext;
  try {
    attached = await buildContextPacket(runtime, {
      client,
      scope,
      envelope,
      context,
      brainSpan,
      askType: options.askType,
      hubEvent: options.hubEvent,
      goalId,
      stepId,
      stepType,
    });
  } catch (error) {
    logger.warn({ error, stepType, stepId }, 'Context bridge build failed');
    await emitContextBuildFailed(client, scope, brainSpan, error, { stepId, stepType, goalId });
    const outputs = bridgeFailureOutputs(runtime.onFailure);
    return { outputs, attached: null, held: runtime.onFailure === 'hold' };
  }

  await emitContextAttached(client, scope, brainSpan, attached, goalId);

  // Packet is the only context input when the bridge is on.
  let packet = attached.packet;
  const brainContextBase: BrainContext = {
    userId: context.userId,
    threadId: context.threadId,
    client: context.client,
    contextPacket: packet,
    stepId: attached.stepId,
    stepType: attached.stepType,
    needsRound: 0,
  };

  let result: BrainStepResult = normalizeBrainStepResult(
    await brain.process(envelope, brainContextBase)
  );
  let rounds = 0;

  while (result.needs?.length && rounds < runtime.maxNeedRounds) {
    rounds += 1;
    try {
      const rebuilt = await buildContextPacket(runtime, {
        client,
        scope,
        envelope,
        context,
        brainSpan,
        askType: options.askType,
        hubEvent: options.hubEvent,
        goalId,
        stepId: attached.stepId,
        stepType: attached.stepType,
        needs: result.needs,
      });
      packet = rebuilt.packet;
      attached = {
        ...attached,
        packet,
        packetIds: [...attached.packetIds, packet.packetId],
      };
      await emitContextAttached(client, scope, brainSpan, attached, goalId);
    } catch (error) {
      logger.warn({ error, stepType, stepId, round: rounds }, 'Context bridge hybrid rebuild failed');
      await emitContextBuildFailed(client, scope, brainSpan, error, {
        stepId: attached.stepId,
        stepType: attached.stepType,
        goalId,
      });
      return {
        outputs: bridgeFailureOutputs(runtime.onFailure),
        attached,
        held: runtime.onFailure === 'hold',
      };
    }

    result = normalizeBrainStepResult(
      await brain.process(envelope, {
        ...brainContextBase,
        contextPacket: packet,
        needsRound: rounds,
      })
    );
  }

  if (result.needs?.length) {
    logger.warn(
      { stepId: attached.stepId, rounds, max: runtime.maxNeedRounds },
      'Brain needs exceeded CONTEXT_BRIDGE_MAX_NEED_ROUNDS; using last outputs'
    );
  }

  // Persist packet metadata on the caller's context for the step.
  context.contextPacket = packet;
  context.stepId = attached.stepId;
  context.stepType = attached.stepType;
  context.needsRound = rounds;

  return { outputs: result.outputs, attached, held: false };
}

export function contextBridgeRuntimeFromConfig(
  client: ContextClient,
  minter: AssertionMinter | null
): ContextBridgeRuntime {
  return {
    enabled: config.contextBridge.enabled,
    client,
    minter,
    maxNeedRounds: Math.max(0, config.contextBridge.maxNeedRounds),
    onFailure: config.contextBridge.onFailure,
    workspaceId: config.audit.workspaceId || DEFAULT_WORKSPACE_ID,
  };
}
