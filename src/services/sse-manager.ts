import { logger } from '../logger.js';
import type { SSEConnection } from '../types.js';
import type { EventEnvelope } from '@smallseedlabs/proba-protocol';

class SSEManager {
  private connections = new Map<string, SSEConnection>();

  addConnection(connection: SSEConnection): void {
    this.connections.set(connection.userId, connection);
    logger.info({ userId: connection.userId }, 'SSE connection added');
  }

  removeConnection(userId: string): void {
    this.connections.delete(userId);
    logger.info({ userId }, 'SSE connection removed');
  }

  sendToUser(userId: string, event: EventEnvelope): boolean {
    const connection = this.connections.get(userId);
    if (connection) {
      connection.send(event);
      return true;
    }
    return false;
  }

  hasConnection(userId: string): boolean {
    return this.connections.has(userId);
  }

  getConnectionCount(): number {
    return this.connections.size;
  }
}

export const sseManager = new SSEManager();
