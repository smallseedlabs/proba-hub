/**
 * Map a gateway research.accept snapshot to the protocol research_review body.
 *
 * Identity (artifactId / version / inputRevision / landingPageUrl) comes from
 * snapshot.needs (gateway-authored). Findings / assumptions / unknowns / sources
 * come from the matching tool_call parameters (also gateway-authored from the
 * artifact). Context packets are not research. Model-invented fields are not used.
 */

import {
  RESEARCH_ACCEPT_VERB,
  validateResearchReviewAsk,
  type ResearchReviewAsk,
} from '@smallseedlabs/proba-protocol';
import type { GatewayRunSnapshot } from './gateway-client.js';

export interface GatewayResearchNeed {
  type: 'approval';
  askId: string;
  verb: typeof RESEARCH_ACCEPT_VERB;
  research: {
    artifactId: string;
    version: number;
    inputRevision: string;
    landingPageUrl: string;
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function researchAcceptNeedFromSnapshot(snapshot: GatewayRunSnapshot): GatewayResearchNeed | undefined {
  if (!Array.isArray(snapshot.needs)) return undefined;
  for (const item of snapshot.needs) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (row.type !== 'approval' || row.verb !== RESEARCH_ACCEPT_VERB) continue;
    if (typeof row.askId !== 'string' || !UUID_RE.test(row.askId)) continue;
    const research = row.research;
    if (!research || typeof research !== 'object' || Array.isArray(research)) continue;
    const ident = research as Record<string, unknown>;
    if (typeof ident.artifactId !== 'string' || !UUID_RE.test(ident.artifactId)) continue;
    if (typeof ident.version !== 'number' || !Number.isInteger(ident.version) || ident.version < 1) continue;
    if (typeof ident.inputRevision !== 'string' || ident.inputRevision.length === 0) continue;
    if (typeof ident.landingPageUrl !== 'string' || ident.landingPageUrl.length === 0) continue;
    return {
      type: 'approval',
      askId: row.askId,
      verb: RESEARCH_ACCEPT_VERB,
      research: {
        artifactId: ident.artifactId,
        version: ident.version,
        inputRevision: ident.inputRevision,
        landingPageUrl: ident.landingPageUrl,
      },
    };
  }
  return undefined;
}

function toolParametersForResearchAccept(snapshot: GatewayRunSnapshot): Record<string, unknown> | undefined {
  if (!Array.isArray(snapshot.outputs)) return undefined;
  for (const item of snapshot.outputs) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { type?: unknown; tool?: unknown; parameters?: unknown };
    if (row.type !== 'tool_call' || row.tool !== RESEARCH_ACCEPT_VERB) continue;
    if (!row.parameters || typeof row.parameters !== 'object' || Array.isArray(row.parameters)) continue;
    return row.parameters as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Build and validate the Hub-authored research_review body from a gateway snapshot.
 * Returns undefined when the snapshot is not a sourced research.accept (fail closed;
 * never invent citations or copy Context).
 */
export function researchReviewFromSnapshot(
  snapshot: GatewayRunSnapshot,
  expectedLandingPageUrl?: string
): ResearchReviewAsk | undefined {
  const need = researchAcceptNeedFromSnapshot(snapshot);
  const parameters = toolParametersForResearchAccept(snapshot);
  if (!need || !parameters) return undefined;

  const candidate = {
    verb: RESEARCH_ACCEPT_VERB,
    artifactId: need.research.artifactId,
    version: need.research.version,
    inputRevision: need.research.inputRevision,
    landingPageUrl: need.research.landingPageUrl,
    status: 'awaiting_acceptance' as const,
    findings: parameters.findings,
    assumptions: Array.isArray(parameters.assumptions) ? parameters.assumptions : [],
    unknowns: Array.isArray(parameters.unknowns) ? parameters.unknowns : [],
    sources: parameters.sources,
  };

  if (
    typeof parameters.artifactId === 'string' &&
    parameters.artifactId !== need.research.artifactId
  ) {
    return undefined;
  }
  if (typeof parameters.version === 'number' && parameters.version !== need.research.version) {
    return undefined;
  }
  if (
    typeof parameters.inputRevision === 'string' &&
    parameters.inputRevision !== need.research.inputRevision
  ) {
    return undefined;
  }
  if (
    typeof parameters.landingPageUrl === 'string' &&
    parameters.landingPageUrl !== need.research.landingPageUrl
  ) {
    return undefined;
  }
  if (expectedLandingPageUrl && need.research.landingPageUrl !== expectedLandingPageUrl) {
    return undefined;
  }

  const parsed = validateResearchReviewAsk(candidate);
  return parsed.success ? parsed.data : undefined;
}

export function researchReviewFromBrainOutput(output: unknown): ResearchReviewAsk | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const row = output as { type?: unknown; tool?: unknown; researchReview?: unknown };
  if (row.type !== 'tool_call' || row.tool !== RESEARCH_ACCEPT_VERB) return undefined;
  const parsed = validateResearchReviewAsk(row.researchReview);
  return parsed.success ? parsed.data : undefined;
}
