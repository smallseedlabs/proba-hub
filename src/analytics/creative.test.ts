import { describe, expect, it } from 'vitest';
import { parseApprovedCreative, parseApprovedTargeting } from './creative.js';

describe('approved creative', () => {
  it('accepts operator TEXT and IMAGE creative and rejects model-ish extras', () => {
    expect(parseApprovedCreative({ type: 'TEXT', headline: 'Hi', body: 'Body' })).toEqual({
      ok: true,
      creative: { type: 'TEXT', headline: 'Hi', body: 'Body' },
    });
    const image = parseApprovedCreative({ type: 'IMAGE', headline: 'Hi', mediaUrl: 'https://cdn.example.com/a.png' });
    expect(image.ok).toBe(true);
    expect(parseApprovedCreative({ type: 'TEXT', headline: 'Hi', body: 'b', landingPageUrl: 'https://x.example' }).ok).toBe(false);
    expect(parseApprovedCreative({ type: 'VIDEO', headline: 'Hi' }).ok).toBe(false);
    expect(parseApprovedCreative({ type: 'IMAGE', headline: 'Hi', mediaUrl: 'http://127.0.0.1/a.png' }).ok).toBe(false);
    expect(parseApprovedCreative({ type: 'TEXT', headline: '', body: 'b' }).ok).toBe(false);
  });

  it('targeting is optional and must be an object', () => {
    expect(parseApprovedTargeting(undefined)).toEqual({ ok: true });
    expect(parseApprovedTargeting(['x']).ok).toBe(false);
  });
});
