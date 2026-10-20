/**
 * Fixed-window, in-memory limiter for sign-in attempts. Good enough for a
 * single Hub instance; a multi-instance deployment should move this to Redis.
 */
export interface RateLimitOptions {
  /** Max attempts per key per window. */
  max: number;
  windowMs: number;
  now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(private readonly options: RateLimitOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Seconds until the key may try again, or 0 if it is under the limit. */
  retryAfter(key: string): number {
    const bucket = this.live(key);
    if (!bucket || bucket.count < this.options.max) return 0;
    return Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1000));
  }

  hit(key: string): void {
    const bucket = this.live(key);
    if (bucket) {
      bucket.count++;
    } else {
      this.buckets.set(key, { count: 1, resetAt: this.now() + this.options.windowMs });
    }
    if (this.buckets.size > 10_000) this.sweep();
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private live(key: string): Bucket | undefined {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt <= this.now()) {
      this.buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
