import { pool } from './client.js';
import { logger } from '../logger.js';

async function seed(): Promise<void> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const demoEmail = 'demo@proba.example';
    
    const userResult = await client.query(
      `INSERT INTO users (email, name)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [demoEmail, 'Demo User']
    );
    const userId = userResult.rows[0].id;

    const threadResult = await client.query(
      `INSERT INTO threads (user_id, title, status)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [userId, 'Q4 Product Campaign', 'active']
    );
    const threadId = threadResult.rows[0].id;

    const goalResult = await client.query(
      `INSERT INTO goals (user_id, thread_id, title, description, constraints, budget, status, progress, metrics)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        userId,
        threadId,
        'Launch Q4 Product Campaign',
        'Promote our new product feature to existing users',
        JSON.stringify(['family-friendly', 'no-clickbait']),
        JSON.stringify({
          daily: 100,
          total: 3000,
          currency: 'USD',
        }),
        'active',
        JSON.stringify({
          completed: 5,
          total: 30,
          milestones: [
            { name: 'Campaign launched', completed: true },
            { name: 'Reach 10k impressions', completed: false },
            { name: 'Achieve 100 conversions', completed: false },
          ],
        }),
        JSON.stringify({
          spend: 522.50,
          impressions: 8432,
          clicks: 270,
          conversions: 42,
        }),
      ]
    );
    const goalId = goalResult.rows[0].id;

    await client.query(
      `INSERT INTO messages (thread_id, text, source)
       VALUES ($1, $2, $3)`,
      [threadId, 'I want to launch a Q4 campaign for our new product feature', 'user']
    );

    await client.query(
      `INSERT INTO messages (thread_id, text, source)
       VALUES ($1, $2, $3)`,
      [threadId, 'Great! I can help you with that. Let me create a campaign plan.', 'brain']
    );

    await client.query(
      `INSERT INTO thread_summaries (thread_id, summary, last_message_at, message_count, unread_count)
       VALUES ($1, $2, NOW(), 2, 0)`,
      [threadId, 'Discussion about Q4 product campaign launch']
    );

    await client.query('COMMIT');

    logger.info(
      {
        userId,
        threadId,
        goalId,
        email: demoEmail,
      },
      'Seed data created successfully'
    );

    // eslint-disable-next-line no-console
    console.log('\n=== Seed Data Created ===');
    // eslint-disable-next-line no-console
    console.log(`Demo User ID: ${userId}`);
    // eslint-disable-next-line no-console
    console.log(`Demo Email: ${demoEmail}`);
    // eslint-disable-next-line no-console
    console.log(`Thread ID: ${threadId}`);
    // eslint-disable-next-line no-console
    console.log(`Goal ID: ${goalId}`);
    // eslint-disable-next-line no-console
    console.log('\nUse this email to login via POST /dev/login');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({ error }, 'Seed failed');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
