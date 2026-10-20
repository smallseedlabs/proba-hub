import type { PoolClient } from 'pg';
import type {
  CommandEnvelope,
  EventEnvelope,
  BrainOutput,
} from '@smallseedlabs/proba-protocol';

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Thread {
  id: string;
  userId: string;
  title?: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  threadId: string;
  text: string;
  source: string;
  createdAt: Date;
}

export interface Ask {
  id: string;
  threadId: string;
  askType: string;
  title: string;
  description?: string;
  blocking: boolean;
  risk: string;
  costEffect?: Record<string, unknown>;
  questions: Record<string, unknown>[];
  status: string;
  expiresAt?: Date;
  onExpire?: string;
  answeredAt?: Date;
  answer?: Record<string, unknown>;
  createdAt: Date;
}

export interface Command {
  id: string;
  userId: string;
  clientMsgId: string;
  type: string;
  threadId?: string;
  payload: Record<string, unknown>;
  status: string;
  processedAt?: Date;
  createdAt: Date;
}

export interface Event {
  id: string;
  userId: string;
  seq: number;
  type: string;
  threadId?: string;
  payload: Record<string, unknown>;
  uiPayloadId?: string;
  fallbackText?: string;
  createdAt: Date;
}

export interface InboxItem {
  id: string;
  userId: string;
  threadId?: string;
  type: string;
  title: string;
  description?: string;
  priority: string;
  status: string;
  relatedAskId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Goal {
  id: string;
  userId: string;
  threadId: string;
  title: string;
  description?: string;
  constraints?: string[];
  budget?: Record<string, unknown>;
  status: string;
  progress?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommandResult {
  status: 'accepted' | 'rejected';
  clientMsgId: string;
  reason?: string;
}

export interface ProcessedCommand {
  command: Command;
  events: Event[];
}

/** Goal progress/metrics a brain reports alongside its outputs (optional). */
export interface BrainGoalUpdate {
  status?: 'active' | 'paused' | 'completed' | 'cancelled';
  progress?: {
    completed: number;
    total: number;
    milestones?: Array<{ name: string; completed: boolean }>;
  };
  metrics?: {
    spend?: number;
    impressions?: number;
    clicks?: number;
    conversions?: number;
  };
}

export interface BrainPort {
  process(command: CommandEnvelope, context: BrainContext): Promise<BrainOutput[]>;
  /**
   * Goal update produced by the last process() call for this thread, if any.
   * Returned once (consumed). Optional: brains that do not track goals omit it.
   */
  takeGoalUpdate?(threadId: string): BrainGoalUpdate | undefined;
}

export interface BrainContext {
  userId: string;
  threadId?: string;
  thread?: Thread;
  messages?: Message[];
  goals?: Goal[];
  client: PoolClient;
}

export interface SSEConnection {
  userId: string;
  /** Deliver a live event; the connection de-duplicates and fills gaps by seq. */
  send: (event: EventEnvelope) => void;
  close: () => void;
}

export interface OutboxMessage {
  id: string;
  userId: string;
  eventId: string;
  event: EventEnvelope;
  createdAt: Date;
}
