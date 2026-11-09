import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RESEARCH_ACCEPT_VERB } from '@smallseedlabs/proba-protocol';
import { fakeResearchSnapshot } from '../testing/fake-research-gateway.js';
import { researchReviewFromBrainOutput, researchReviewFromSnapshot } from './research-snapshot.js';

const LANDING = 'https://operator-entered.example/path';

describe('researchReviewFromSnapshot', () => {
  it('copies gateway-authored findings/sources/assumptions/unknowns, not Context', () => {
    const askId = randomUUID();
    const artifactId = randomUUID();
    const snapshot = fakeResearchSnapshot({ runId: randomUUID(), askId, artifactId, landingPageUrl: LANDING });
    const review = researchReviewFromSnapshot(snapshot, LANDING);
    expect(review).toMatchObject({
      verb: RESEARCH_ACCEPT_VERB,
      artifactId,
      landingPageUrl: LANDING,
      status: 'awaiting_acceptance',
    });
    expect(review?.findings[0]?.sourceIds).toEqual(['page-1']);
    expect(review?.sources[0]?.kind).toBe('http_url');
    expect(review?.assumptions[0]?.basis).toBe('user_input');
    expect(review?.unknowns.length).toBeGreaterThan(0);
    expect(JSON.stringify(review)).not.toMatch(/smallseedlabs\.com/);
  });

  it('fails closed on unsourced findings, URL mismatch, or missing need identity', () => {
    const askId = randomUUID();
    const artifactId = randomUUID();
    const snapshot = fakeResearchSnapshot({ runId: randomUUID(), askId, artifactId, landingPageUrl: LANDING });
    expect(researchReviewFromSnapshot(snapshot, 'https://other.example/')).toBeUndefined();

    const unsourced = structuredClone(snapshot);
    (unsourced.outputs?.[0] as { parameters: { findings: Array<{ sourceIds: string[] }> } }).parameters.findings[0].sourceIds =
      [];
    expect(researchReviewFromSnapshot(unsourced, LANDING)).toBeUndefined();

    const noNeed = { ...snapshot, needs: [] };
    expect(researchReviewFromSnapshot(noNeed, LANDING)).toBeUndefined();
  });

  it('reads a Hub-attached researchReview extra and ignores other tools', () => {
    const askId = randomUUID();
    const artifactId = randomUUID();
    const snapshot = fakeResearchSnapshot({ runId: randomUUID(), askId, artifactId, landingPageUrl: LANDING });
    const review = researchReviewFromSnapshot(snapshot);
    expect(researchReviewFromBrainOutput({ type: 'tool_call', tool: RESEARCH_ACCEPT_VERB, researchReview: review })).toEqual(
      review
    );
    expect(
      researchReviewFromBrainOutput({ type: 'tool_call', tool: 'ads.create_campaign', researchReview: review })
    ).toBeUndefined();
  });
});
