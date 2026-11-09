const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Gateway pending-approval askId carried on a BrainOutput extra field. */
export function askIdFromBrainOutput(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const askId = (output as { askId?: unknown }).askId;
  return typeof askId === 'string' && UUID_RE.test(askId) ? askId : undefined;
}

export function approvalAskIdFromSnapshot(snapshot: {
  needs?: unknown;
}): string | undefined {
  const needs = snapshot.needs;
  if (!Array.isArray(needs)) return undefined;
  for (const item of needs) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { type?: unknown; askId?: unknown };
    if (row.type === 'approval' && typeof row.askId === 'string' && UUID_RE.test(row.askId)) {
      return row.askId;
    }
  }
  return undefined;
}

/**
 * Protocol mapping mints a fresh askId. When the gateway already bound one,
 * reuse it so Hub answer_ask / approve_plan match resume.askId.
 */
export function applyBoundAskId<
  T extends {
    type: string;
    payload?: unknown;
    ui?: { actions?: Array<{ command?: { payload?: Record<string, unknown> } }> };
  },
>(envelope: T, askId: string): T {
  if (envelope.type !== 'ask' || !envelope.payload || typeof envelope.payload !== 'object') return envelope;
  const payload = envelope.payload as { askId?: string };
  const previous = payload.askId;
  payload.askId = askId;
  const actions = envelope.ui?.actions;
  if (previous && actions) {
    for (const action of actions) {
      const commandPayload = action.command?.payload;
      if (!commandPayload) continue;
      if (commandPayload.planId === previous) commandPayload.planId = askId;
      if (commandPayload.askId === previous) commandPayload.askId = askId;
    }
  }
  return envelope;
}
