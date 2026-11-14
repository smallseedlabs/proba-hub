import type { ConnectionsService } from '../connections/service.js';
import { PROVIDER_DISPLAY_NAMES, type ConnectionProviderId } from '../connections/provider.js';
import { META_GRAPH_API_BASE } from '../connections/meta.js';
import { REDDIT_ADS_API_BASE } from '../connections/reddit.js';
import type { AdPlatform } from './service.js';

export type CampaignDeliveryState =
  | 'delivering'
  | 'in_moderation'
  | 'paused'
  | 'rejected'
  | 'not_delivering'
  | 'unknown';

export interface CampaignDeliveryStatus {
  state: CampaignDeliveryState;
  label: string;
  summary: string;
  causes: string[];
  campaignConfiguredStatus: string | null;
  campaignEffectiveStatus: string | null;
  adGroupEffectiveStatus: string | null;
  adEffectiveStatus: string | null;
  rejectionReason: string | null;
  postUrl: string | null;
  previewUrl: string | null;
  commentsAllowed?: boolean | null;
  nativeMetrics?: Record<string, number> | null;
  checkedAt: string;
}

export interface ResolveCampaignDeliveryInput {
  workspaceId: string;
  userId: string;
  probaCampaignId: string;
  platform: AdPlatform;
  accountId: string | null;
  providerCampaignId: string | null;
}

export interface CampaignDeliveryResolver {
  resolve(input: ResolveCampaignDeliveryInput): Promise<CampaignDeliveryStatus | null>;
  pauseCampaign?(input: ResolveCampaignDeliveryInput): Promise<{ ok: boolean; adsPaused: number; error?: string }>;
}

export interface RedditEntityRecord {
  id?: string | null;
  campaign_id?: string | null;
  ad_group_id?: string | null;
  post_id?: string | null;
  allow_comments?: boolean | null;
  configured_status?: string | null;
  effective_status?: string | null;
  delivery_status?: string[] | null;
  rejection_reason?: string | null;
  post_url?: string | null;
  preview_url?: string | null;
}

const DELIVERY_CAUSE_LABELS: Record<string, string> = {
  AD_PENDING_ADMIN_APPROVAL: 'Ad is pending Reddit moderation approval',
  PENDING_APPROVAL: 'Ad is pending moderation approval',
  PENDING_REVIEW: 'Ad is pending moderation review',
  IN_MODERATION: 'Ad is in moderation review',
  UNDER_REVIEW: 'Ad is under moderation review',
  AD_REJECTED: 'Ad was rejected by platform moderation',
  AD_DISAPPROVED: 'Ad was disapproved by platform moderation',
  REJECTED: 'Ad was rejected by platform moderation',
  DISAPPROVED: 'Ad was disapproved by platform moderation',
  CAMPAIGN_PAUSED: 'Campaign is paused',
  AD_GROUP_PAUSED: 'Ad group is paused',
  ADGROUP_PAUSED: 'Ad group is paused',
  AD_PAUSED: 'Ad is paused',
  CAMPAIGN_NOT_FUNDED: 'Ad account funding or payment method verification is pending',
  NO_ACTIVE_CHILDREN: 'Ad group has no active delivering ads yet',
  CAMPAIGN_ENDED: 'Campaign end date has passed',
  AD_GROUP_ENDED: 'Ad group end date has passed',
  BUDGET_EXHAUSTED: 'Campaign or ad group budget is exhausted',
};

function normUpper(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function strOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => normUpper(v))
    .filter((v): v is string => Boolean(v));
}

function isModerationCode(code: string | null): boolean {
  if (!code) return false;
  return (
    code === 'PENDING_APPROVAL' ||
    code === 'AD_PENDING_ADMIN_APPROVAL' ||
    code === 'PENDING_REVIEW' ||
    code === 'IN_REVIEW' ||
    code === 'IN_MODERATION' ||
    code === 'UNDER_REVIEW' ||
    code === 'EDITORIAL_PENDING'
  );
}

function isRejectedCode(code: string | null): boolean {
  if (!code) return false;
  return (
    code === 'REJECTED' ||
    code === 'AD_REJECTED' ||
    code === 'DISAPPROVED' ||
    code === 'AD_DISAPPROVED' ||
    code === 'EDITORIAL_REJECTED'
  );
}

function isPausedCode(code: string | null): boolean {
  if (!code) return false;
  return (
    code === 'PAUSED' ||
    code === 'CAMPAIGN_PAUSED' ||
    code === 'AD_GROUP_PAUSED' ||
    code === 'ADGROUP_PAUSED' ||
    code === 'AD_PAUSED'
  );
}

/**
 * Pure mapping from Reddit Ads API v3 (and normalized multi-provider) campaign / ad group / ad
 * entities to a user-facing CampaignDeliveryStatus with explicit moderation & non-delivery causes.
 */
export function deriveProviderDeliveryStatus(input: {
  platform: AdPlatform;
  campaign: RedditEntityRecord | null;
  adGroups: RedditEntityRecord[];
  ads: RedditEntityRecord[];
  checkedAt: string;
}): CampaignDeliveryStatus {
  const providerName = PROVIDER_DISPLAY_NAMES[input.platform as ConnectionProviderId] ?? input.platform;
  const { campaign, adGroups, ads, checkedAt } = input;

  if (!campaign) {
    return {
      state: 'unknown',
      label: 'Status unavailable',
      summary: `Could not load campaign status from ${providerName}.`,
      causes: [],
      campaignConfiguredStatus: null,
      campaignEffectiveStatus: null,
      adGroupEffectiveStatus: null,
      adEffectiveStatus: null,
      rejectionReason: null,
      postUrl: null,
      previewUrl: null,
      checkedAt,
    };
  }

  const primaryAdGroup = adGroups[0] ?? null;
  const primaryAd = ads[0] ?? null;

  const campaignConfiguredStatus = normUpper(campaign.configured_status);
  const campaignEffectiveStatus = normUpper(campaign.effective_status);
  const adGroupConfiguredStatus = normUpper(primaryAdGroup?.configured_status);
  const adGroupEffectiveStatus = normUpper(primaryAdGroup?.effective_status);
  const adConfiguredStatus = normUpper(primaryAd?.configured_status);
  const adEffectiveStatus = normUpper(primaryAd?.effective_status);
  const rejectionReason = strOrNull(primaryAd?.rejection_reason);
  const postUrl = strOrNull(primaryAd?.post_url);
  const previewUrl = strOrNull(primaryAd?.preview_url);

  const rawCodes = new Set<string>();
  for (const code of strList(campaign.delivery_status)) rawCodes.add(code);
  for (const ag of adGroups) {
    for (const code of strList(ag.delivery_status)) rawCodes.add(code);
  }
  for (const ad of ads) {
    for (const code of strList(ad.delivery_status)) rawCodes.add(code);
    const eff = normUpper(ad.effective_status);
    if (eff && eff !== 'ACTIVE') rawCodes.add(eff);
  }

  const inModeration =
    isModerationCode(adEffectiveStatus) ||
    isModerationCode(adGroupEffectiveStatus) ||
    isModerationCode(campaignEffectiveStatus) ||
    [...rawCodes].some((c) => isModerationCode(c));

  const isRejected =
    Boolean(rejectionReason) ||
    isRejectedCode(adEffectiveStatus) ||
    isRejectedCode(adGroupEffectiveStatus) ||
    isRejectedCode(campaignEffectiveStatus) ||
    [...rawCodes].some((c) => isRejectedCode(c));

  const explicitlyPaused =
    isPausedCode(campaignConfiguredStatus) ||
    isPausedCode(adGroupConfiguredStatus) ||
    isPausedCode(adConfiguredStatus) ||
    campaignEffectiveStatus === 'CAMPAIGN_PAUSED' ||
    rawCodes.has('CAMPAIGN_PAUSED') ||
    rawCodes.has('AD_GROUP_PAUSED') ||
    rawCodes.has('AD_PAUSED');

  const causes: string[] = [];
  const addCause = (text: string) => {
    if (!causes.includes(text)) causes.push(text);
  };

  if (rejectionReason) {
    addCause(`Rejected by ${providerName} moderation: ${rejectionReason}`);
  } else if (isRejected) {
    addCause(DELIVERY_CAUSE_LABELS.AD_REJECTED!);
  }

  if (inModeration) {
    addCause(
      input.platform === 'reddit'
        ? 'Ad is in Reddit moderation review (pending admin approval)'
        : `Ad is in ${providerName} moderation review`
    );
  }

  if (explicitlyPaused) {
    if (isPausedCode(campaignConfiguredStatus) || campaignEffectiveStatus === 'CAMPAIGN_PAUSED' || rawCodes.has('CAMPAIGN_PAUSED')) {
      addCause('Campaign is paused');
    }
    if (isPausedCode(adGroupConfiguredStatus) || rawCodes.has('AD_GROUP_PAUSED') || rawCodes.has('ADGROUP_PAUSED')) {
      addCause('Ad group is paused');
    }
    if (isPausedCode(adConfiguredStatus) || rawCodes.has('AD_PAUSED')) {
      addCause('Ad creative is paused');
    }
  }

  if (rawCodes.has('CAMPAIGN_NOT_FUNDED')) {
    addCause(DELIVERY_CAUSE_LABELS.CAMPAIGN_NOT_FUNDED!);
  }

  if (ads.length === 0 && adGroups.length > 0) {
    addCause('No active ad creative is attached to the ad group yet');
  } else if (rawCodes.has('NO_ACTIVE_CHILDREN') && !inModeration) {
    addCause(DELIVERY_CAUSE_LABELS.NO_ACTIVE_CHILDREN!);
  } else if (rawCodes.has('NO_ACTIVE_CHILDREN') && inModeration) {
    addCause('Ad group is waiting for its ad creative to pass moderation before serving');
  }

  for (const code of rawCodes) {
    if (
      code === 'AD_HAS_ACTIVE_PREVIEW' ||
      isModerationCode(code) ||
      isRejectedCode(code) ||
      isPausedCode(code) ||
      code === 'CAMPAIGN_NOT_FUNDED' ||
      code === 'NO_ACTIVE_CHILDREN'
    ) {
      continue;
    }
    addCause(DELIVERY_CAUSE_LABELS[code] ?? `Platform status: ${code.replace(/_/g, ' ').toLowerCase()}`);
  }

  // Decide high-level delivery state and summary in priority order:
  if (isRejected) {
    return {
      state: 'rejected',
      label: 'Rejected by moderation',
      summary: rejectionReason
        ? `Ad is not running on ${providerName} because it was rejected during moderation: ${rejectionReason}.`
        : `Ad is not running on ${providerName} because it was disapproved by platform moderation.`,
      causes,
      campaignConfiguredStatus,
      campaignEffectiveStatus,
      adGroupEffectiveStatus,
      adEffectiveStatus,
      rejectionReason,
      postUrl,
      previewUrl,
      checkedAt,
    };
  }

  if (explicitlyPaused) {
    return {
      state: 'paused',
      label: inModeration ? 'Paused · In moderation' : 'Paused',
      summary: inModeration
        ? `Campaign is currently paused on ${providerName}, and its ad creative is also in moderation review.`
        : `Campaign is paused on ${providerName} and is not serving impressions.`,
      causes,
      campaignConfiguredStatus,
      campaignEffectiveStatus,
      adGroupEffectiveStatus,
      adEffectiveStatus,
      rejectionReason,
      postUrl,
      previewUrl,
      checkedAt,
    };
  }

  if (inModeration) {
    return {
      state: 'in_moderation',
      label: 'In moderation',
      summary: `Ad is not running yet because it is in ${providerName} moderation review. Delivery starts automatically once approved.`,
      causes,
      campaignConfiguredStatus,
      campaignEffectiveStatus,
      adGroupEffectiveStatus,
      adEffectiveStatus,
      rejectionReason,
      postUrl,
      previewUrl,
      checkedAt,
    };
  }

  if (ads.length === 0) {
    return {
      state: 'not_delivering',
      label: 'Not delivering · No active ads',
      summary: `Campaign is configured on ${providerName}, but no ad creative is attached to the ad group.`,
      causes,
      campaignConfiguredStatus,
      campaignEffectiveStatus,
      adGroupEffectiveStatus,
      adEffectiveStatus,
      rejectionReason,
      postUrl,
      previewUrl,
      checkedAt,
    };
  }

  if (rawCodes.has('CAMPAIGN_NOT_FUNDED') || causes.length > 0) {
    return {
      state: 'not_delivering',
      label: rawCodes.has('CAMPAIGN_NOT_FUNDED') ? 'Not delivering · Funding pending' : 'Not delivering',
      summary: `Campaign is active on ${providerName}, but delivery is blocked: ${causes[0]}.`,
      causes,
      campaignConfiguredStatus,
      campaignEffectiveStatus,
      adGroupEffectiveStatus,
      adEffectiveStatus,
      rejectionReason,
      postUrl,
      previewUrl,
      checkedAt,
    };
  }

  if (campaignConfiguredStatus === 'ACTIVE' && (adEffectiveStatus === 'ACTIVE' || campaignEffectiveStatus === 'ACTIVE')) {
    return {
      state: 'delivering',
      label: 'Active · Delivering',
      summary: `Campaign and ad creative are approved and actively delivering on ${providerName}.`,
      causes: [],
      campaignConfiguredStatus,
      campaignEffectiveStatus,
      adGroupEffectiveStatus,
      adEffectiveStatus,
      rejectionReason,
      postUrl,
      previewUrl,
      checkedAt,
    };
  }

  return {
    state: 'not_delivering',
    label: 'Not delivering',
    summary: `Campaign is not currently delivering impressions on ${providerName}.`,
    causes,
    campaignConfiguredStatus,
    campaignEffectiveStatus,
    adGroupEffectiveStatus,
    adEffectiveStatus,
    rejectionReason,
    postUrl,
    previewUrl,
    checkedAt,
  };
}

export interface HubCampaignDeliveryResolverOptions {
  connections: ConnectionsService | null;
  redditAdsApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  timeoutMs?: number;
  now?: () => Date;
}

const USER_AGENT = 'web:proba-hub:0.1.0 (Proba delivery status resolver)';

export class HubCampaignDeliveryResolver implements CampaignDeliveryResolver {
  private readonly cache = new Map<string, { status: CampaignDeliveryStatus; expiresAt: number }>();
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: HubCampaignDeliveryResolverOptions) {
    this.apiBase = (options.redditAdsApiBaseUrl || REDDIT_ADS_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? (() => new Date());
  }

  async resolve(input: ResolveCampaignDeliveryInput): Promise<CampaignDeliveryStatus | null> {
    const now = this.now();
    const checkedAt = now.toISOString();
    const providerName = PROVIDER_DISPLAY_NAMES[input.platform as ConnectionProviderId] ?? input.platform;

    if (!input.providerCampaignId) {
      return {
        state: 'unknown',
        label: 'Awaiting platform launch',
        summary: `This campaign does not have a ${providerName} campaign ID yet.`,
        causes: [],
        campaignConfiguredStatus: null,
        campaignEffectiveStatus: null,
        adGroupEffectiveStatus: null,
        adEffectiveStatus: null,
        rejectionReason: null,
        postUrl: null,
        previewUrl: null,
        checkedAt,
      };
    }

    const cacheKey = `${input.workspaceId}:${input.platform}:${input.providerCampaignId}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > now.getTime()) {
      return hit.status;
    }

    if (!this.options.connections) {
      return {
        state: 'unknown',
        label: 'Connection unavailable',
        summary: `${providerName} connection broker is not configured on this Hub.`,
        causes: [],
        campaignConfiguredStatus: null,
        campaignEffectiveStatus: null,
        adGroupEffectiveStatus: null,
        adEffectiveStatus: null,
        rejectionReason: null,
        postUrl: null,
        previewUrl: null,
        checkedAt,
      };
    }

    let issued;
    try {
      issued = await this.options.connections.issueAccessToken({
        workspaceId: input.workspaceId,
        provider: input.platform as ConnectionProviderId,
        purpose: 'metrics',
        userId: input.userId,
        initiatedBy: 'system',
      });
    } catch {
      return {
        state: 'unknown',
        label: 'Reconnect required',
        summary: `Connect ${providerName} in Marketing to inspect live ad moderation and delivery status.`,
        causes: [],
        campaignConfiguredStatus: null,
        campaignEffectiveStatus: null,
        adGroupEffectiveStatus: null,
        adEffectiveStatus: null,
        rejectionReason: null,
        postUrl: null,
        previewUrl: null,
        checkedAt,
      };
    }

    if (input.platform === 'meta') {
      try {
        const status = await this.resolveMetaDelivery(issued.accessToken, input.providerCampaignId, checkedAt);
        this.cache.set(cacheKey, { status, expiresAt: now.getTime() + this.cacheTtlMs });
        return status;
      } catch {
        return {
          state: 'unknown',
          label: 'Status check unavailable',
          summary: `Could not reach ${providerName} to verify live delivery status right now.`,
          causes: [],
          campaignConfiguredStatus: null,
          campaignEffectiveStatus: null,
          adGroupEffectiveStatus: null,
          adEffectiveStatus: null,
          rejectionReason: null,
          postUrl: null,
          previewUrl: null,
          checkedAt,
        };
      }
    }

    if (input.platform !== 'reddit') {
      return {
        state: 'unknown',
        label: 'Connected',
        summary: `${providerName} campaign (${input.providerCampaignId}) is registered.`,
        causes: [],
        campaignConfiguredStatus: null,
        campaignEffectiveStatus: null,
        adGroupEffectiveStatus: null,
        adEffectiveStatus: null,
        rejectionReason: null,
        postUrl: null,
        previewUrl: null,
        checkedAt,
      };
    }

    const accountId = input.accountId || issued.accountId;
    try {
      const [campaignObj, adGroupsList, adsList] = await Promise.all([
        this.getObject(issued.accessToken, `/campaigns/${encodeURIComponent(input.providerCampaignId)}`),
        this.getList(issued.accessToken, `/ad_accounts/${encodeURIComponent(accountId)}/ad_groups`),
        this.getList(issued.accessToken, `/ad_accounts/${encodeURIComponent(accountId)}/ads`),
      ]);

      const matchingAdGroups = adGroupsList.filter(
        (ag) => String(ag.campaign_id ?? '') === input.providerCampaignId
      );
      const matchingAds = adsList.filter(
        (ad) => String(ad.campaign_id ?? '') === input.providerCampaignId
      );

      const postId = strOrNull(matchingAds[0]?.post_id);
      const [postObj, nativeMetrics] = await Promise.all([
        postId
          ? this.getObject(issued.accessToken, `/posts/${encodeURIComponent(postId)}`).catch(() => null)
          : Promise.resolve(null),
        this.fetchRedditCampaignMetrics(issued.accessToken, accountId, input.providerCampaignId, now).catch(() => null),
      ]);

      const baseStatus = deriveProviderDeliveryStatus({
        platform: input.platform,
        campaign: campaignObj,
        adGroups: matchingAdGroups,
        ads: matchingAds,
        checkedAt,
      });
      const status: CampaignDeliveryStatus = {
        ...baseStatus,
        commentsAllowed: typeof postObj?.allow_comments === 'boolean' ? postObj.allow_comments : null,
        nativeMetrics,
      };

      this.cache.set(cacheKey, { status, expiresAt: now.getTime() + this.cacheTtlMs });
      return status;
    } catch {
      return {
        state: 'unknown',
        label: 'Status check unavailable',
        summary: `Could not reach ${providerName} to verify live moderation status right now.`,
        causes: [],
        campaignConfiguredStatus: null,
        campaignEffectiveStatus: null,
        adGroupEffectiveStatus: null,
        adEffectiveStatus: null,
        rejectionReason: null,
        postUrl: null,
        previewUrl: null,
        checkedAt,
      };
    }
  }

  private async getObject(accessToken: string, path: string): Promise<RedditEntityRecord | null> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return null;
    const data = body.data;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as RedditEntityRecord) : null;
  }

  private async fetchRedditCampaignMetrics(
    accessToken: string,
    accountId: string,
    campaignId: string,
    now: Date
  ): Promise<Record<string, number> | null> {
    const endsAt = `${now.toISOString().slice(0, 13)}:00:00Z`;
    const startsAt = `${new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 13)}:00:00Z`;
    const res = await this.fetchImpl(
      `${this.apiBase}/ad_accounts/${encodeURIComponent(accountId)}/reports?page.size=100`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          data: {
            breakdowns: ['CAMPAIGN_ID'],
            fields: [
              'IMPRESSIONS',
              'CLICKS',
              'SPEND',
              'KEY_CONVERSION_TOTAL_COUNT',
              'REACH',
              'VIDEO_VIEWABLE_IMPRESSIONS',
            ],
            starts_at: startsAt,
            ends_at: endsAt,
          },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      }
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      data?: { metrics?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    } | null;
    if (!body || typeof body !== 'object') return null;
    const rows = Array.isArray(body.data)
      ? body.data
      : Array.isArray(body.data?.metrics)
        ? body.data.metrics
        : [];
    let impressions = 0;
    let clicks = 0;
    let spendMicros = 0;
    let conversions = 0;
    let reach = 0;
    let videoViews = 0;
    for (const row of rows) {
      if (String(row.campaign_id ?? '') !== campaignId) continue;
      impressions += Number(row.impressions ?? 0) || 0;
      clicks += Number(row.clicks ?? 0) || 0;
      spendMicros += Number(row.spend ?? 0) || 0;
      conversions += Number(row.key_conversion_total_count ?? 0) || 0;
      reach += Number(row.reach ?? 0) || 0;
      videoViews += Number(row.video_viewable_impressions ?? 0) || 0;
    }
    const spend = spendMicros / 1_000_000;
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
    const cpc = clicks > 0 ? spend / clicks : 0;
    const ecpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
    return {
      impressions,
      clicks,
      spend,
      ecpm,
      cpc,
      ctr,
      reach,
      video_viewable_impressions: videoViews,
      conversions,
    };
  }

  private async getList(accessToken: string, path: string): Promise<RedditEntityRecord[]> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) return [];
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || !Array.isArray(body.data)) return [];
    return body.data.filter((item): item is RedditEntityRecord => Boolean(item && typeof item === 'object'));
  }

  private async resolveMetaDelivery(
    accessToken: string,
    campaignId: string,
    checkedAt: string
  ): Promise<CampaignDeliveryStatus> {
    const headers = {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    };
    const [campRes, adsRes, insightsRes] = await Promise.all([
      this.fetchImpl(
        `${META_GRAPH_API_BASE}/${encodeURIComponent(campaignId)}?fields=id,status,effective_status,issues_info`,
        { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) }
      ),
      this.fetchImpl(
        `${META_GRAPH_API_BASE}/${encodeURIComponent(campaignId)}/ads?fields=id,status,effective_status,preview_shareable_link,issues_info&limit=10`,
        { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) }
      ).catch(() => null),
      this.fetchImpl(
        `${META_GRAPH_API_BASE}/${encodeURIComponent(campaignId)}/insights?fields=impressions,clicks,spend,reach,frequency,ctr,cpc,cpm,actions&date_preset=last_14d`,
        { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) }
      ).catch(() => null),
    ]);

    if (!campRes.ok) {
      throw new Error(`Meta campaign lookup failed: ${campRes.status}`);
    }
    const camp = (await campRes.json().catch(() => null)) as {
      status?: string;
      effective_status?: string;
      issues_info?: Array<{ error_summary?: string; error_message?: string }>;
    } | null;
    const adsBody = adsRes?.ok
      ? ((await adsRes.json().catch(() => null)) as {
          data?: Array<{
            effective_status?: string;
            preview_shareable_link?: string;
            issues_info?: Array<{ error_summary?: string; error_message?: string }>;
          }>;
        } | null)
      : null;
    const primaryAd = adsBody?.data?.[0];

    const campConfigured = normUpper(camp?.status);
    const campEffective = normUpper(camp?.effective_status);
    const adEffective = normUpper(primaryAd?.effective_status);
    const issues = [
      ...(camp?.issues_info ?? []),
      ...(primaryAd?.issues_info ?? []),
    ]
      .map((i) => strOrNull(i.error_summary) || strOrNull(i.error_message))
      .filter((x): x is string => Boolean(x));
    const causes = [...new Set(issues)];

    let nativeMetrics: Record<string, number> | null = null;
    if (insightsRes?.ok) {
      const insBody = (await insightsRes.json().catch(() => null)) as {
        data?: Array<Record<string, unknown>>;
      } | null;
      const row = insBody?.data?.[0];
      if (row) {
        const impressions = Number(row.impressions ?? 0) || 0;
        const clicks = Number(row.clicks ?? 0) || 0;
        const spend = Number(row.spend ?? 0) || 0;
        const reach = Number(row.reach ?? 0) || 0;
        const frequency = Number(row.frequency ?? 0) || 0;
        const ctr = Number(row.ctr ?? (impressions > 0 ? (clicks / impressions) * 100 : 0)) || 0;
        const cpc = Number(row.cpc ?? (clicks > 0 ? spend / clicks : 0)) || 0;
        const ecpm = Number(row.cpm ?? (impressions > 0 ? (spend / impressions) * 1000 : 0)) || 0;
        const actions = Array.isArray(row.actions) ? (row.actions as Array<{ action_type?: string; value?: string }>) : [];
        const conversions = actions.reduce((acc, a) => acc + (Number(a.value ?? 0) || 0), 0);
        nativeMetrics = { impressions, clicks, spend, reach, frequency, ctr, cpc, ecpm, conversions };
      }
    }

    const previewUrl = strOrNull(primaryAd?.preview_shareable_link);
    const isRejected = campEffective === 'DISAPPROVED' || adEffective === 'DISAPPROVED';
    const isPaused =
      campConfigured === 'PAUSED' ||
      campEffective === 'PAUSED' ||
      campEffective === 'CAMPAIGN_PAUSED' ||
      adEffective === 'PAUSED' ||
      adEffective === 'ADSET_PAUSED' ||
      adEffective === 'CAMPAIGN_PAUSED';
    const isModeration =
      campEffective === 'PENDING_REVIEW' ||
      campEffective === 'IN_PROCESS' ||
      adEffective === 'PENDING_REVIEW' ||
      adEffective === 'IN_PROCESS';

    let state: CampaignDeliveryState = 'unknown';
    let label = 'Status unknown';
    let summary = `Meta Ads reported campaign status ${campEffective ?? campConfigured ?? 'unknown'}.`;

    if (isRejected) {
      state = 'rejected';
      label = 'Rejected by moderation';
      summary = causes[0]
        ? `Meta Ads rejected the ad creative: ${causes[0]}`
        : 'Meta Ads rejected the ad creative during policy review.';
    } else if (isPaused) {
      state = 'paused';
      label = isModeration ? 'Paused · In review' : 'Paused';
      summary = 'Campaign is paused on Meta Ads and is not serving impressions.';
    } else if (isModeration) {
      state = 'in_moderation';
      label = 'In review';
      summary = 'Ad is in Meta Ads policy review. Delivery starts automatically once approved.';
    } else if (campEffective === 'WITH_ISSUES' || adEffective === 'WITH_ISSUES' || causes.length > 0) {
      state = 'not_delivering';
      label = 'Not delivering · Issues';
      summary = causes[0] ? `Meta Ads delivery issue: ${causes[0]}` : 'Meta Ads reported delivery issues.';
    } else if (campEffective === 'ACTIVE' && (!adEffective || adEffective === 'ACTIVE')) {
      state = 'delivering';
      label = 'Active · Delivering';
      summary = 'Campaign and ad creative are approved and actively delivering on Meta Ads.';
    }

    return {
      state,
      label,
      summary,
      causes,
      campaignConfiguredStatus: campConfigured,
      campaignEffectiveStatus: campEffective,
      adGroupEffectiveStatus: null,
      adEffectiveStatus: adEffective,
      rejectionReason: isRejected ? (causes[0] ?? null) : null,
      postUrl: null,
      previewUrl,
      nativeMetrics,
      checkedAt,
    };
  }

  /**
   * Emergency-stop pause for a live provider campaign and its ads. Clears cached delivery status.
   */
  async pauseCampaign(input: ResolveCampaignDeliveryInput): Promise<{ ok: boolean; adsPaused: number; error?: string }> {
    if (!input.providerCampaignId || !this.options.connections || (input.platform !== 'reddit' && input.platform !== 'meta')) {
      return { ok: false, adsPaused: 0, error: 'unsupported_or_missing_campaign' };
    }
    const cacheKey = `${input.workspaceId}:${input.platform}:${input.providerCampaignId}`;
    this.cache.delete(cacheKey);
    try {
      const issued = await this.options.connections.issueAccessToken({
        workspaceId: input.workspaceId,
        provider: input.platform as ConnectionProviderId,
        purpose: 'mutate',
        userId: input.userId,
        initiatedBy: 'user',
      });
      if (input.platform === 'meta') {
        const res = await this.fetchImpl(
          `${META_GRAPH_API_BASE}/${encodeURIComponent(input.providerCampaignId)}`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${issued.accessToken}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({ status: 'PAUSED' }),
            redirect: 'error',
            signal: AbortSignal.timeout(this.timeoutMs),
          }
        );
        return { ok: res.ok, adsPaused: res.ok ? 1 : 0 };
      }
      const campRes = await this.patchObject(
        issued.accessToken,
        `/campaigns/${encodeURIComponent(input.providerCampaignId)}`,
        { data: { configured_status: 'PAUSED' } }
      );
      const accountId = input.accountId || issued.accountId;
      const adsList = await this.getList(issued.accessToken, `/ad_accounts/${encodeURIComponent(accountId)}/ads`);
      const matchingAds = adsList.filter((ad) => String(ad.campaign_id ?? '') === input.providerCampaignId && ad.id);
      let adsPaused = 0;
      for (const ad of matchingAds) {
        const ok = await this.patchObject(issued.accessToken, `/ads/${encodeURIComponent(String(ad.id))}`, {
          data: { configured_status: 'PAUSED' },
        });
        if (ok) adsPaused += 1;
      }
      return { ok: campRes, adsPaused };
    } catch (err) {
      return { ok: false, adsPaused: 0, error: err instanceof Error ? err.message : 'pause_failed' };
    }
  }

  private async patchObject(accessToken: string, path: string, payload: unknown): Promise<boolean> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return res.ok;
  }
}
