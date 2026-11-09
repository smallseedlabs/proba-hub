import { pool } from '../db/client.js';
import { logger } from '../logger.js';
import { runAsJob } from '../audit/trace.js';
import type { AnalyticsService } from './service.js';

/** pg_advisory_lock key so only one Hub replica runs a scheduler pass at a time. */
const SCHEDULER_LOCK_KEY = 727274008;

let timer: NodeJS.Timeout | null = null;
let running = false;

/** One locked pass. Exported for tests; the unique review row still coalesces across replicas. */
export async function runAnalyticsSchedulerPass(service: AnalyticsService): Promise<boolean> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [SCHEDULER_LOCK_KEY]);
    if (!lock.rows[0]?.ok) return false;
    try {
      await service.scheduleTick();
      return true;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export function startAnalyticsScheduler(service: AnalyticsService, tickMs: number): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void runAsJob(async () => {
      try {
        await runAnalyticsSchedulerPass(service);
      } catch (error) {
        logger.error({ err: error instanceof Error ? error.message : error }, 'analytics scheduler pass failed');
      } finally {
        running = false;
      }
    });
  }, tickMs);
  timer.unref();
  logger.info({ tickMs }, 'analytics review scheduler started (proposals still need owner approval)');
}

export function stopAnalyticsScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
