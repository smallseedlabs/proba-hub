import { describe, it, expect } from 'vitest';
import { redactUrl } from './logger.js';

describe('redactUrl', () => {
  it('redacts token query parameters', () => {
    expect(redactUrl('/v1/events?token=abc.def.ghi')).toBe('/v1/events?token=[REDACTED]');
    expect(redactUrl('/v1/events?after=3&token=abc&x=1')).toBe('/v1/events?after=3&token=[REDACTED]&x=1');
    expect(redactUrl('/v1/threads')).toBe('/v1/threads');
    expect(redactUrl(undefined)).toBeUndefined();
  });
});
