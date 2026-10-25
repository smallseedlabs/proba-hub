import { describe, expect, it } from 'vitest';
import { createThrottle } from './throttle.js';

describe('createThrottle', () => {
  it('emits the first hit per key and window and reports what was suppressed', () => {
    const t = createThrottle({ windowMs: 1000 });
    expect(t.hit('a', 0)).toEqual({ emit: true, suppressed: 0 });
    expect(t.hit('a', 10).emit).toBe(false);
    expect(t.hit('a', 20).emit).toBe(false);
    expect(t.hit('b', 30)).toEqual({ emit: true, suppressed: 0 });
    expect(t.hit('a', 1000)).toEqual({ emit: true, suppressed: 2 });
    expect(t.hit('a', 1001).emit).toBe(false);
  });

  it('bounds memory', () => {
    const t = createThrottle({ windowMs: 1000, maxKeys: 2 });
    t.hit('a', 0);
    t.hit('b', 0);
    t.hit('c', 0); // evicts a
    expect(t.hit('a', 1).emit).toBe(true);
  });
});
