/**
 * Brain-drafted Reddit post (gateway verb `creative.draft_post`). The gateway checks the draft (length,
 * banned phrases, claims cite accepted research, landing URL is the operator's) before it reaches Hub.
 * Hub shows it as an editable approval card. Only the operator's approve (optionally with edited
 * headline/body) writes goals.approved_creative; reject saves nothing. Never a default landing URL.
 */

import type { ApprovedCreative } from '../brain/gateway-client.js';
import { parseApprovedCreative } from './creative.js';

export const CREATIVE_DRAFT_VERB = 'creative.draft_post';

export interface CreativeDraft {
  type: 'TEXT';
  headline: string;
  body: string;
  landingPageUrl: string;
  rationale?: string;
  claims: Array<{ text: string; findingId: string }>;
  researchArtifactId?: string;
  researchVersion?: number;
  /** Proposed Reddit targeting (gateway-checked Ads shape). */
  targeting?: Record<string, unknown>;
  /** Success metric, platform, duration and the reasons they were chosen. */
  plan?: DraftPlan;
}

export const SUCCESS_METRICS = ['clicks', 'ctr', 'cpc', 'landing_page_views', 'signups', 'conversions'] as const;

export interface DraftPlan {
  platform: 'reddit';
  successMetric: (typeof SUCCESS_METRICS)[number];
  successTarget?: number;
  durationDays?: number;
  reasons: Record<string, string>;
}

function planFrom(raw: unknown): DraftPlan | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.successMetric !== 'string' || !(SUCCESS_METRICS as readonly string[]).includes(raw.successMetric)) return undefined;
  const reasons: Record<string, string> = {};
  if (isRecord(raw.reasons)) for (const [k, v] of Object.entries(raw.reasons).slice(0, 12)) if (typeof v === 'string') reasons[k.slice(0, 40)] = v.slice(0, 300);
  const target = typeof raw.successTarget === 'number' && Number.isFinite(raw.successTarget) && raw.successTarget > 0 ? raw.successTarget : undefined;
  const days = typeof raw.durationDays === 'number' && Number.isInteger(raw.durationDays) && raw.durationDays >= 1 && raw.durationDays <= 90 ? raw.durationDays : undefined;
  return {
    platform: 'reddit',
    successMetric: raw.successMetric as DraftPlan['successMetric'],
    ...(target ? { successTarget: target } : {}),
    ...(days ? { durationDays: days } : {}),
    reasons,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The checked draft from a gateway tool_call output; undefined when it is not a well-formed draft. */
export function draftFromParameters(parameters: unknown): CreativeDraft | undefined {
  if (!isRecord(parameters)) return undefined;
  const { headline, body, landingPageUrl, rationale, claims, researchArtifactId, researchVersion, targeting, plan } = parameters;
  if (typeof headline !== 'string' || typeof body !== 'string' || typeof landingPageUrl !== 'string') return undefined;
  const parsed = parseApprovedCreative({ type: 'TEXT', headline, body });
  if (!parsed.ok) return undefined;
  const cleanClaims = Array.isArray(claims)
    ? claims
        .filter((c): c is { text: string; findingId: string } => isRecord(c) && typeof c.text === 'string' && typeof c.findingId === 'string')
        .slice(0, 10)
        .map((c) => ({ text: c.text.slice(0, 300), findingId: c.findingId.slice(0, 128) }))
    : [];
  return {
    type: 'TEXT',
    headline: parsed.creative.headline,
    body: (parsed.creative as { body: string }).body,
    landingPageUrl,
    ...(typeof rationale === 'string' && rationale.trim() ? { rationale: rationale.trim().slice(0, 1000) } : {}),
    claims: cleanClaims,
    ...(typeof researchArtifactId === 'string' ? { researchArtifactId: researchArtifactId.slice(0, 64) } : {}),
    ...(typeof researchVersion === 'number' ? { researchVersion } : {}),
    ...(isRecord(targeting) && Object.keys(targeting).length > 0 ? { targeting } : {}),
    ...(planFrom(plan) ? { plan: planFrom(plan) } : {}),
  };
}

/**
 * Targeting and plan to save for an approved plan card. The operator may override communities
 * (`values.communities`, list or comma text), the success metric and its target; everything else is as proposed.
 */
export function planFromDraftAnswer(
  draft: CreativeDraft,
  values: Record<string, unknown> | undefined
): { ok: true; targeting?: Record<string, unknown>; plan?: DraftPlan; edited: boolean } | { ok: false; error: string } {
  let targeting = draft.targeting ? { ...draft.targeting } : undefined;
  let plan = draft.plan ? { ...draft.plan, reasons: { ...draft.plan.reasons } } : undefined;
  let edited = false;
  if (values?.communities !== undefined) {
    const list = Array.isArray(values.communities)
      ? values.communities
      : typeof values.communities === 'string'
        ? values.communities.split(',')
        : null;
    if (!list || list.some((c) => typeof c !== 'string')) return { ok: false, error: 'communities must be subreddit names' };
    const names = (list as string[]).map((c) => c.trim().replace(/^\/?r\//i, '')).filter(Boolean);
    if (names.some((n) => !/^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/.test(n)) || names.length > 25) return { ok: false, error: 'communities must be up to 25 subreddit names' };
    targeting = { ...(targeting ?? {}) };
    if (names.length > 0) targeting.communities = names;
    else delete targeting.communities;
    edited = true;
  }
  if (values?.successMetric !== undefined || values?.successTarget !== undefined) {
    const metric = values.successMetric ?? plan?.successMetric;
    if (typeof metric !== 'string' || !(SUCCESS_METRICS as readonly string[]).includes(metric)) return { ok: false, error: 'unknown success metric' };
    const target = values.successTarget === undefined || values.successTarget === '' ? plan?.successTarget : Number(values.successTarget);
    if (target !== undefined && !(Number.isFinite(target) && target > 0)) return { ok: false, error: 'success target must be a positive number' };
    plan = { platform: 'reddit', reasons: plan?.reasons ?? {}, ...(plan?.durationDays ? { durationDays: plan.durationDays } : {}), successMetric: metric as DraftPlan['successMetric'], ...(target ? { successTarget: target } : {}) };
    edited = true;
  }
  return { ok: true, ...(targeting && Object.keys(targeting).length > 0 ? { targeting } : {}), ...(plan ? { plan } : {}), edited };
}

/**
 * The creative to save for an approved draft card: the operator's edited headline/body when sent in
 * `values`, otherwise the draft as shown. Edited copy is the operator's own words (same rules as the
 * Campaigns post form override).
 */
export function creativeFromDraftAnswer(
  draft: CreativeDraft,
  values: Record<string, unknown> | undefined
): { ok: true; creative: ApprovedCreative; edited: boolean } | { ok: false; error: string } {
  const headline = typeof values?.headline === 'string' ? values.headline : draft.headline;
  const body = typeof values?.body === 'string' ? values.body : draft.body;
  const parsed = parseApprovedCreative({ type: 'TEXT', headline, body });
  if (!parsed.ok) return parsed;
  const p = parsed.creative as { headline: string; body: string };
  const edited = p.headline !== draft.headline || p.body !== draft.body;
  return { ok: true, creative: parsed.creative, edited };
}
