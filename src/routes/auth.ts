import type { FastifyInstance } from 'fastify';
import { pool } from '../db/client.js';
import type { User } from '../types.js';

interface DevLoginRequest {
  email: string;
  name?: string;
}

interface DevLoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
  };
}

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: DevLoginRequest; Reply: DevLoginResponse }>(
    '/dev/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email' },
            name: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, name = 'Dev User' } = request.body;
      
      let user: User;
      const existing = await pool.query<User>(
        'SELECT id, email, name, created_at as "createdAt", updated_at as "updatedAt" FROM users WHERE email = $1',
        [email]
      );
      
      if (existing.rows.length > 0) {
        user = existing.rows[0];
      } else {
        const created = await pool.query<User>(
          'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id, email, name, created_at as "createdAt", updated_at as "updatedAt"',
          [email, name]
        );
        user = created.rows[0];
      }
      
      const token = fastify.jwt.sign(
        { userId: user.id },
        { expiresIn: '7d' }
      );
      
      await pool.query(
        'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'7 days\')',
        [user.id, token]
      );
      
      reply.send({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      });
    }
  );
}
