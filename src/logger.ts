import pino from 'pino';
import { config } from './config.js';

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
