/**
 * Fixed-window throttle for audit events that unauthenticated callers can
 * trigger at will (auth.denied). The first hit per key and window is emitted;
 * later hits are counted and reported on the next emitted event as `suppressed`.
 * In memory and per replica: it bounds write amplification, it is not a ledger.
 */
export interface Throttle {
  hit(key: string, now?: number): { emit: boolean; suppressed: number };
}

export function createThrottle(options: { windowMs: number; maxKeys?: number }): Throttle {
  const maxKeys = options.maxKeys ?? 10_000;
  const entries = new Map<string, { windowStart: number; suppressed: number }>();

  return {
    hit(key, now = Date.now()) {
      const entry = entries.get(key);
      if (entry && now - entry.windowStart < options.windowMs) {
        entry.suppressed += 1;
        return { emit: false, suppressed: 0 };
      }
      const suppressed = entry?.suppressed ?? 0;
      entries.delete(key);
      entries.set(key, { windowStart: now, suppressed: 0 });
      if (entries.size > maxKeys) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      return { emit: true, suppressed };
    },
  };
}
