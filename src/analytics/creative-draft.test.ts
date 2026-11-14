import { describe, expect, it } from 'vitest';
import { creativeFromDraftAnswer, draftFromParameters } from './creative-draft.js';

const params = {
  type: 'TEXT',
  headline: 'Waterproof boots for muddy UK trails',
  body: 'Light, grippy and dry on wet ground.',
  landingPageUrl: 'https://example.com/offer',
  rationale: 'Practical angle',
  claims: [{ text: 'light', findingId: 'f1' }],
  researchArtifactId: '00000000-0000-4000-8000-000000000001',
  researchVersion: 1,
};

describe('creative draft card', () => {
  it('reads a checked draft and rejects malformed ones', () => {
    expect(draftFromParameters(params)).toMatchObject({ headline: params.headline, landingPageUrl: params.landingPageUrl, claims: params.claims });
    expect(draftFromParameters({ ...params, headline: '' })).toBeUndefined();
    expect(draftFromParameters({ ...params, landingPageUrl: undefined })).toBeUndefined();
  });

  it('saves the draft as shown, or the operator edits', () => {
    const draft = draftFromParameters(params)!;
    expect(creativeFromDraftAnswer(draft, undefined)).toEqual({
      ok: true,
      edited: false,
      creative: { type: 'TEXT', headline: params.headline, body: params.body },
    });
    expect(creativeFromDraftAnswer(draft, { body: 'My own words.' })).toMatchObject({ ok: true, edited: true, creative: { body: 'My own words.' } });
    expect(creativeFromDraftAnswer(draft, { headline: 'x'.repeat(301) })).toMatchObject({ ok: false });
  });
});
