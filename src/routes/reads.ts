import type { FastifyInstance } from 'fastify';
import { pool } from '../db/client.js';
import type { Thread, Message, InboxItem, Goal } from '../types.js';

interface ThreadsResponse {
  threads: Array<Thread & { unreadCount: number; lastMessageAt?: string }>;
}

interface MessagesQuery {
  threadId: string;
  limit?: string;
  before?: string;
}

interface MessagesResponse {
  messages: Message[];
  hasMore: boolean;
}

interface InboxResponse {
  items: InboxItem[];
}

interface GoalsResponse {
  goals: Goal[];
}

export async function readRoutes(fastify: FastifyInstance) {
  fastify.get<{ Reply: ThreadsResponse }>(
    '/threads',
    {
      onRequest: [(fastify as any).authenticate],
    },
    async (request, reply) => {
      const userId = request.user!.id;

      const result = await pool.query(
        `SELECT t.id, t.user_id as "userId", t.title, t.status,
                t.created_at as "createdAt", t.updated_at as "updatedAt",
                ts.last_message_at as "lastMessageAt",
                ts.unread_count as "unreadCount"
         FROM threads t
         LEFT JOIN thread_summaries ts ON t.id = ts.thread_id
         WHERE t.user_id = $1
         ORDER BY COALESCE(ts.last_message_at, t.created_at) DESC
         LIMIT 50`,
        [userId]
      );

      const threads = result.rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        title: row.title,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        unreadCount: row.unreadCount || 0,
        lastMessageAt: row.lastMessageAt?.toISOString(),
      }));

      reply.send({ threads });
    }
  );

  fastify.get<{ Querystring: MessagesQuery; Reply: MessagesResponse }>(
    '/messages',
    {
      onRequest: [(fastify as any).authenticate],
      schema: {
        querystring: {
          type: 'object',
          required: ['threadId'],
          properties: {
            threadId: { type: 'string', format: 'uuid' },
            limit: { type: 'string' },
            before: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { threadId, limit = '50', before } = request.query;

      const threadCheck = await pool.query(
        'SELECT id FROM threads WHERE id = $1 AND user_id = $2',
        [threadId, userId]
      );

      if (threadCheck.rows.length === 0) {
        return reply.code(404).send({ error: 'thread_not_found' });
      }

      const limitNum = Math.min(parseInt(limit, 10), 100);

      let query = `
        SELECT id, thread_id as "threadId", text, source, created_at as "createdAt"
        FROM messages
        WHERE thread_id = $1
      `;
      const params: (string | number)[] = [threadId];

      if (before) {
        query += ' AND created_at < (SELECT created_at FROM messages WHERE id = $2)';
        params.push(before);
      }

      query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
      params.push(limitNum + 1);

      const result = await pool.query<Message>(query, params);

      const hasMore = result.rows.length > limitNum;
      const messages = result.rows.slice(0, limitNum).reverse();

      reply.send({ messages, hasMore });
    }
  );

  fastify.get<{ Reply: InboxResponse }>(
    '/inbox',
    {
      onRequest: [(fastify as any).authenticate],
    },
    async (request, reply) => {
      const userId = request.user!.id;

      const result = await pool.query<InboxItem>(
        `SELECT id, user_id as "userId", thread_id as "threadId", type, title,
                description, priority, status, related_ask_id as "relatedAskId",
                metadata, created_at as "createdAt", updated_at as "updatedAt"
         FROM inbox_items
         WHERE user_id = $1 AND status != 'resolved'
         ORDER BY 
           CASE priority 
             WHEN 'high' THEN 1 
             WHEN 'normal' THEN 2 
             ELSE 3 
           END,
           created_at DESC
         LIMIT 50`,
        [userId]
      );

      reply.send({ items: result.rows });
    }
  );

  fastify.get<{ Reply: GoalsResponse }>(
    '/goals',
    {
      onRequest: [(fastify as any).authenticate],
    },
    async (request, reply) => {
      const userId = request.user!.id;

      const result = await pool.query<Goal>(
        `SELECT id, user_id as "userId", thread_id as "threadId", title, description,
                constraints, budget, status, progress, metrics,
                created_at as "createdAt", updated_at as "updatedAt"
         FROM goals
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [userId]
      );

      reply.send({ goals: result.rows });
    }
  );
}
