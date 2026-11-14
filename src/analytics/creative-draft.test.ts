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

describe('plan card', () => {
  const planParams = {
    ...params,
    targeting: { communities: ['UKhiking'], geolocations: ['GB'] },
    plan: { platform: 'reddit', successMetric: 'clicks', successTarget: 200, durationDays: 14, reasons: { successMetric: 'chose clicks because no signup form' } },
  };
  it('keeps proposed targeting and plan; operator can override communities and the metric', async () => {
    const { planFromDraftAnswer } = await import('./creative-draft.js');
    const draft = draftFromParameters(planParams)!;
    expect(draft.plan).toMatchObject({ successMetric: 'clicks', successTarget: 200, durationDays: 14 });
    expect(planFromDraftAnswer(draft, undefined)).toMatchObject({ ok: true, edited: false, targeting: planParams.targeting, plan: { successMetric: 'clicks' } });
    expect(planFromDraftAnswer(draft, { communities: 'r/hiking, CampingGear', successMetric: 'ctr', successTarget: '1.5' })).toMatchObject({
      ok: true,
      edited: true,
      targeting: { communities: ['hiking', 'CampingGear'], geolocations: ['GB'] },
      plan: { successMetric: 'ctr', successTarget: 1.5, durationDays: 14 },
    });
    expect(planFromDraftAnswer(draft, { communities: 't5_x!' }).ok).toBe(false);
    expect(planFromDraftAnswer(draft, { successMetric: 'vibes' }).ok).toBe(false);
  });
});
