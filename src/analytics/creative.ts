/**
 * Operator-approved Reddit creative (copy/media) on a goal. The gateway forwards
 * it to Ads, which creates the structured post and uses its id for the ad.
 * Never model text. Media must be an operator-entered public URL; no default.
 */

import { parseLandingPageUrl } from '@smallseedlabs/proba-protocol';
import type { ApprovedCreative } from '../brain/gateway-client.js';

export const CALL_TO_ACTION_MAX = 64;

/** Media must be https on a public host name (no localhost, no IP literals). */
function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return false;
  return true;
}

export function parseApprovedCreative(raw: unknown): { ok: true; creative: ApprovedCreative } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'creative must be an object' };
  const r = raw as Record<string, unknown>;
  const allowed = new Set(['type', 'headline', 'body', 'mediaUrl', 'callToAction']);
  for (const key of Object.keys(r)) if (!allowed.has(key)) return { ok: false, error: `creative.${key} is not allowed` };
  const headline = typeof r.headline === 'string' ? r.headline.trim() : '';
  if (!headline || headline.length > 300) return { ok: false, error: 'creative.headline is required (1-300 chars)' };
  const body = typeof r.body === 'string' ? r.body.trim() : undefined;
  if (body !== undefined && (body.length === 0 || body.length > 40_000)) {
    return { ok: false, error: 'creative.body must be 1-40000 chars' };
  }
  if (r.type === 'TEXT') {
    if (!body) return { ok: false, error: 'TEXT creative needs a body' };
    if (r.mediaUrl !== undefined || r.callToAction !== undefined) {
      return { ok: false, error: 'TEXT creative has no mediaUrl or callToAction' };
    }
    return { ok: true, creative: { type: 'TEXT', headline, body } };
  }
  if (r.type === 'IMAGE') {
    const media = parseLandingPageUrl(r.mediaUrl);
    if (!media.ok || !isPublicHttpsUrl(media.url)) return { ok: false, error: 'creative.mediaUrl must be a public https URL you entered' };
    const cta = typeof r.callToAction === 'string' ? r.callToAction.trim() : undefined;
    if (cta !== undefined && (cta.length === 0 || cta.length > CALL_TO_ACTION_MAX)) {
      return { ok: false, error: 'creative.callToAction is invalid' };
    }
    return {
      ok: true,
      creative: { type: 'IMAGE', headline, ...(body ? { body } : {}), mediaUrl: media.url, ...(cta ? { callToAction: cta } : {}) },
    };
  }
  return { ok: false, error: 'creative.type must be TEXT or IMAGE' };
}

export function parseApprovedTargeting(raw: unknown): { ok: true; targeting?: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'targeting must be an object' };
  if (JSON.stringify(raw).length > 20_000) return { ok: false, error: 'targeting is too large' };
  return { ok: true, targeting: raw as Record<string, unknown> };
}
