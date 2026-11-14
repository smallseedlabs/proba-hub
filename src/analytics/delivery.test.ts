import { describe, expect, it, vi } from 'vitest';
import { deriveProviderDeliveryStatus, HubCampaignDeliveryResolver } from './delivery.js';

describe('deriveProviderDeliveryStatus', () => {
  const checkedAt = '2026-11-14T16:30:00.000Z';

  it('reports in_moderation with explicit causes when Reddit ad is PENDING_APPROVAL', () => {
    const status = deriveProviderDeliveryStatus({
      platform: 'reddit',
      campaign: {
        id: '2635168666659267454',
        configured_status: 'ACTIVE',
        effective_status: 'PAUSED',
        delivery_status: null,
      },
      adGroups: [
        {
          id: '2635168668632479849',
          campaign_id: '2635168666659267454',
          configured_status: 'ACTIVE',
          effective_status: 'PAUSED',
          delivery_status: ['CAMPAIGN_NOT_FUNDED', 'NO_ACTIVE_CHILDREN', 'AD_HAS_ACTIVE_PREVIEW'],
        },
      ],
      ads: [
        {
          id: '2635168671558760290',
          campaign_id: '2635168666659267454',
          ad_group_id: '2635168668632479849',
          configured_status: 'ACTIVE',
          effective_status: 'PENDING_APPROVAL',
          delivery_status: ['AD_PENDING_ADMIN_APPROVAL', 'AD_HAS_ACTIVE_PREVIEW'],
          rejection_reason: null,
          post_url: 'https://www.reddit.com/comments/1xw4s5r',
          preview_url: 'https://www.reddit.com/?ad=preview',
        },
      ],
      checkedAt,
    });

    expect(status.state).toBe('in_moderation');
    expect(status.label).toBe('In moderation');
    expect(status.summary).toContain('Reddit Ads moderation review');
    expect(status.causes).toEqual([
      'Ad is in Reddit moderation review (pending admin approval)',
      'Ad account funding or payment method verification is pending',
      'Ad group is waiting for its ad creative to pass moderation before serving',
    ]);
    expect(status.adEffectiveStatus).toBe('PENDING_APPROVAL');
    expect(status.postUrl).toBe('https://www.reddit.com/comments/1xw4s5r');
    expect(status.previewUrl).toBe('https://www.reddit.com/?ad=preview');
  });

  it('reports paused · in moderation when campaign is PAUSED and ad is PENDING_APPROVAL', () => {
    const status = deriveProviderDeliveryStatus({
      platform: 'reddit',
      campaign: {
        id: '2635139908417816834',
        configured_status: 'PAUSED',
        effective_status: 'CAMPAIGN_PAUSED',
      },
      adGroups: [
        {
          id: '2635139910742644788',
          configured_status: 'ACTIVE',
          effective_status: 'CAMPAIGN_PAUSED',
          delivery_status: ['CAMPAIGN_PAUSED', 'NO_ACTIVE_CHILDREN'],
        },
      ],
      ads: [
        {
          id: '2635144948929653118',
          configured_status: 'ACTIVE',
          effective_status: 'PENDING_APPROVAL',
          delivery_status: ['CAMPAIGN_PAUSED', 'AD_PENDING_ADMIN_APPROVAL'],
        },
      ],
      checkedAt,
    });

    expect(status.state).toBe('paused');
    expect(status.label).toBe('Paused · In moderation');
    expect(status.causes).toContain('Campaign is paused');
    expect(status.causes).toContain('Ad is in Reddit moderation review (pending admin approval)');
  });

  it('reports rejected when moderation rejects the ad creative', () => {
    const status = deriveProviderDeliveryStatus({
      platform: 'reddit',
      campaign: {
        id: '1',
        configured_status: 'ACTIVE',
        effective_status: 'PAUSED',
      },
      adGroups: [{ id: '2', configured_status: 'ACTIVE', effective_status: 'PAUSED' }],
      ads: [
        {
          id: '3',
          configured_status: 'ACTIVE',
          effective_status: 'REJECTED',
          rejection_reason: 'Destination URL does not match promoted brand',
        },
      ],
      checkedAt,
    });

    expect(status.state).toBe('rejected');
    expect(status.label).toBe('Rejected by moderation');
    expect(status.summary).toContain('Destination URL does not match promoted brand');
    expect(status.rejectionReason).toBe('Destination URL does not match promoted brand');
  });

  it('reports delivering when campaign and ad are ACTIVE with no blocking codes', () => {
    const status = deriveProviderDeliveryStatus({
      platform: 'reddit',
      campaign: { id: '1', configured_status: 'ACTIVE', effective_status: 'ACTIVE' },
      adGroups: [{ id: '2', configured_status: 'ACTIVE', effective_status: 'ACTIVE', delivery_status: [] }],
      ads: [{ id: '3', configured_status: 'ACTIVE', effective_status: 'ACTIVE', delivery_status: [] }],
      checkedAt,
    });

    expect(status.state).toBe('delivering');
    expect(status.label).toBe('Active · Delivering');
    expect(status.causes).toEqual([]);
  });

  it('resolves commentsAllowed from Reddit post and extended nativeMetrics from reports', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/campaigns/cmp_1')) {
        return new Response(JSON.stringify({ data: { id: 'cmp_1', configured_status: 'ACTIVE', effective_status: 'ACTIVE' } }), { status: 200 });
      }
      if (url.endsWith('/ad_groups')) {
        return new Response(JSON.stringify({ data: [{ id: 'grp_1', campaign_id: 'cmp_1', configured_status: 'ACTIVE', effective_status: 'ACTIVE' }] }), { status: 200 });
      }
      if (url.endsWith('/ads')) {
        return new Response(JSON.stringify({ data: [{ id: 'ad_1', campaign_id: 'cmp_1', post_id: 't3_abc', configured_status: 'ACTIVE', effective_status: 'ACTIVE' }] }), { status: 200 });
      }
      if (url.includes('/posts/t3_abc')) {
        return new Response(JSON.stringify({ data: { id: 't3_abc', allow_comments: true } }), { status: 200 });
      }
      if (url.includes('/reports')) {
        return new Response(
          JSON.stringify({
            data: {
              metrics: [
                {
                  campaign_id: 'cmp_1',
                  impressions: 1000,
                  clicks: 25,
                  spend: 5_000_000,
                  key_conversion_total_count: 3,
                  reach: 800,
                  video_viewable_impressions: 120,
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    });

    const resolver = new HubCampaignDeliveryResolver({
      connections: {
        issueAccessToken: async () => ({
          accessToken: 'tok_1',
          accountId: 'acc_1',
        }),
      } as never,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const status = await resolver.resolve({
      workspaceId: 'ws_1',
      userId: 'u_1',
      probaCampaignId: 'pc_1',
      platform: 'reddit',
      accountId: 'acc_1',
      providerCampaignId: 'cmp_1',
    });

    expect(status?.commentsAllowed).toBe(true);
    expect(status?.nativeMetrics).toEqual({
      impressions: 1000,
      clicks: 25,
      spend: 5,
      ecpm: 5,
      cpc: 0.2,
      ctr: 2.5,
      reach: 800,
      video_viewable_impressions: 120,
      conversions: 3,
    });
  });
});
