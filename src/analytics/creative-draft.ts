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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The checked draft from a gateway tool_call output; undefined when it is not a well-formed draft. */
export function draftFromParameters(parameters: unknown): CreativeDraft | undefined {
  if (!isRecord(parameters)) return undefined;
  const { headline, body, landingPageUrl, rationale, claims, researchArtifactId, researchVersion } = parameters;
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
  };
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
