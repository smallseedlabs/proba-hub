import { randomUUID } from 'node:crypto';
import type { Logger as PinoLogger } from 'pino';
import type { Clock, IdGenerator, Logger, LogFields } from './vendor/proba-audit/index.js';
import { generateSpanId } from './vendor/proba-audit/index.js';

export const systemClock: Clock = {
  now: () => new Date(),
  isoNow: () => new Date().toISOString(),
};

export const systemIds: IdGenerator = {
  uuid: () => randomUUID(),
  spanId: () => generateSpanId(),
};

/** Adapt the Hub's pino logger to proba-audit's Logger port (msg first, fields second). */
export function toAuditLogger(base: Pick<PinoLogger, 'debug' | 'info' | 'warn' | 'error' | 'child'>): Logger {
  const wrap = (pino: Pick<PinoLogger, 'debug' | 'info' | 'warn' | 'error' | 'child'>): Logger => ({
    debug: (msg: string, fields?: LogFields) => pino.debug(fields ?? {}, msg),
    info: (msg: string, fields?: LogFields) => pino.info(fields ?? {}, msg),
    warn: (msg: string, fields?: LogFields) => pino.warn(fields ?? {}, msg),
    error: (msg: string, fields?: LogFields) => pino.error(fields ?? {}, msg),
    child: (bindings: LogFields) => wrap(pino.child(bindings)),
  });
  return wrap(base);
}
