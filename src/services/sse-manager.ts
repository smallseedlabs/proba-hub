import { logger } from '../logger.js';
import type { SSEConnection } from '../types.js';
import type { EventEnvelope } from '@smallseedlabs/proba-protocol';

/**
 * Registry of live SSE connections. A user may have several concurrent
 * connections (tabs/devices); each is tracked and removed individually.
 */
class SSEManager {
  private connections = new Map<string, Set<SSEConnection>>();

  addConnection(connection: SSEConnection): void {
    let set = this.connections.get(connection.userId);
    if (!set) {
      set = new Set();
      this.connections.set(connection.userId, set);
    }
    set.add(connection);
    logger.debug({ userId: connection.userId, count: set.size }, 'SSE connection added');
  }

  /** Remove exactly this connection (never another connection of the same user). */
  removeConnection(connection: SSEConnection): void {
    const set = this.connections.get(connection.userId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) {
      this.connections.delete(connection.userId);
    }
    logger.debug({ userId: connection.userId, count: set.size }, 'SSE connection removed');
  }

  sendToUser(userId: string, event: EventEnvelope): boolean {
    const set = this.connections.get(userId);
    if (!set || set.size === 0) return false;
    for (const connection of set) {
      connection.send(event);
    }
    return true;
  }

  hasConnection(userId: string): boolean {
    return (this.connections.get(userId)?.size ?? 0) > 0;
  }

  /** Number of live connections, for one user or in total. */
  getConnectionCount(userId?: string): number {
    if (userId !== undefined) {
      return this.connections.get(userId)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.connections.values()) total += set.size;
    return total;
  }
}

export const sseManager = new SSEManager();
