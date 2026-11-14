import { describe, expect, it } from 'vitest';
import { parseApprovedCreative, parseApprovedTargeting } from './creative.js';
import { creativeFromDraftAnswer, draftFromParameters } from './creative-draft.js';

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

  it('maps the legacy subreddits key to Ads communities (names, r/ prefix dropped)', () => {
    expect(parseApprovedTargeting({ subreddits: ['r/UKhiking', 'hiking', ' '] })).toEqual({ ok: true, targeting: { communities: ['UKhiking', 'hiking'] } });
    expect(parseApprovedTargeting({ subreddits: ['a'], communities: ['b'] })).toEqual({ ok: true, targeting: { communities: ['b'] } });
    expect(parseApprovedTargeting({ subreddits: [1] }).ok).toBe(false);
  });

  it('preserves validated landing-page imageUrl on a draft and lets the operator keep or remove it', () => {
    const draft = draftFromParameters({
      headline: 'Waterproof boots',
      body: 'Tested on muddy trails.',
      landingPageUrl: 'https://example.com/offer',
      imageUrl: 'https://example.com/og.png',
    });
    expect(draft).toMatchObject({
      type: 'TEXT',
      headline: 'Waterproof boots',
      body: 'Tested on muddy trails.',
      landingPageUrl: 'https://example.com/offer',
      imageUrl: 'https://example.com/og.png',
    });
    expect(creativeFromDraftAnswer(draft!, undefined)).toEqual({
      ok: true,
      creative: {
        type: 'IMAGE',
        headline: 'Waterproof boots',
        body: 'Tested on muddy trails.',
        mediaUrl: 'https://example.com/og.png',
      },
      edited: false,
    });
    expect(creativeFromDraftAnswer(draft!, { useImage: false })).toEqual({
      ok: true,
      creative: {
        type: 'TEXT',
        headline: 'Waterproof boots',
        body: 'Tested on muddy trails.',
      },
      edited: true,
    });
  });
});
