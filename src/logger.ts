import pino from 'pino';
import { config } from './config.js';
import { traceMixin } from './audit/trace.js';

const SECRET_QUERY_PARAMS = /([?&](?:token|access_token)=)[^&#]*/gi;

/** Strip bearer tokens passed in the query string (EventSource cannot send headers). */
export function redactUrl(url: string | undefined): string | undefined {
  return url?.replace(SECRET_QUERY_PARAMS, '$1[REDACTED]');
}

interface LoggedRequest {
  method?: string;
  url?: string;
  hostname?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

export const logger = pino({
  level: config.log.level,
  transport: config.isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  // Adds the request's traceId to EVERY line logged inside a request or job
  // (child loggers inherit the mixin). Lines outside any trace (startup) have none.
  mixin: traceMixin,
  serializers: {
    // Overrides Fastify's default request serializer (same fields, redacted URL).
    req: (req: LoggedRequest) => ({
      method: req.method,
      url: redactUrl(req.url),
      hostname: req.hostname,
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    }),
  },
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  base: config.isProduction
    ? {
        env: config.env,
        service: 'proba-hub',
      }
    : undefined,
});
