import type { EventEnvelope } from '@smallseedlabs/proba-protocol';

export interface EventRow {
  seq: number;
  type: string;
  thread_id?: string | null;
  payload: unknown;
  created_at: Date;
  component?: string | null;
  version?: string | null;
  props?: unknown;
  actions?: unknown;
  fallback_text?: string | null;
}

/** Build the wire envelope for an events row (joined with ui_payloads). Single source of truth. */
export function buildEventEnvelope(row: EventRow): EventEnvelope {
  const envelope: EventEnvelope = {
    kind: 'event',
    seq: row.seq,
    type: row.type as EventEnvelope['type'],
    threadId: row.thread_id ?? undefined,
    payload: row.payload,
    at: row.created_at.toISOString(),
  };

  if (row.component && row.version && row.props) {
    const ui = {
      component: row.component,
      version: row.version,
      props: row.props,
    };
    if (row.actions) {
      Object.assign(ui, { actions: row.actions });
    }
    envelope.ui = ui as EventEnvelope['ui'];
  }

  if (row.fallback_text) {
    envelope.fallbackText = row.fallback_text;
  }

  return envelope;
}

/** SELECT list + joins used everywhere events are read for delivery. */
export const EVENT_SELECT = `
  SELECT e.id, e.user_id, e.seq, e.type, e.thread_id, e.payload,
         u.component, u.version, u.props, u.actions,
         e.fallback_text, e.created_at
  FROM events e
  LEFT JOIN ui_payloads u ON e.ui_payload_id = u.id`;
