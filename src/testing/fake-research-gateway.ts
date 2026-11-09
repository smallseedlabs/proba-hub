/**
 * FAKE in-process gateway used by Hub tests.
 *
 * This is not a research provider, not a model, and not a live URL fetcher.
 * It never opens a network destination, never spends, and never invents a
 * default landing URL. Snapshots are labelled so a reader cannot mistake them
 * for production gather.
 */

import { createHash, randomUUID } from 'node:crypto';
import { RESEARCH_ACCEPT_VERB, RESEARCH_SOURCE_KIND } from '@smallseedlabs/proba-protocol';
import type { GatewayClient, GatewayRunRequest, GatewayRunSnapshot } from '../brain/gateway-client.js';
import { GatewayClientError } from '../brain/gateway-client.js';

export const FAKE_RESEARCH_GATEWAY_LABEL =
  'FAKE: in-process research gateway (no network, no paid provider, no page crawl)';

const SHA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export function fakeInputRevision(landingPageUrl: string): string {
  return createHash('sha256').update(JSON.stringify({ landingPageUrl })).digest('hex');
}

export function fakeResearchSnapshot(input: {
  runId: string;
  askId: string;
  artifactId: string;
  landingPageUrl: string;
  version?: number;
  inputRevision?: string;
}): GatewayRunSnapshot {
  const version = input.version ?? 1;
  const inputRevision = input.inputRevision ?? fakeInputRevision(input.landingPageUrl);
  const sources = [
    {
      sourceId: 'page-1',
      kind: RESEARCH_SOURCE_KIND,
      url: input.landingPageUrl,
      sha256: SHA,
    },
  ];
  const findings = [
    {
      id: 'f1',
      text: `${FAKE_RESEARCH_GATEWAY_LABEL}: page describes an operator-entered offer`,
      sourceIds: ['page-1'],
    },
  ];
  const assumptions = [
    {
      id: 'a1',
      text: `Operator supplied ${input.landingPageUrl}`,
      basis: 'user_input' as const,
    },
  ];
  const unknowns = [{ id: 'u1', text: 'Audience was not verified; this fake did not fetch the page.' }];
  return {
    runId: input.runId,
    status: 'awaiting_approval',
    iteration: 1,
    outputs: [
      {
        type: 'tool_call',
        tool: RESEARCH_ACCEPT_VERB,
        parameters: {
          artifactId: input.artifactId,
          version,
          inputRevision,
          landingPageUrl: input.landingPageUrl,
          findings,
          assumptions,
          unknowns,
          sources,
        },
        needsApproval: true,
        risk: 'high',
      },
    ],
    needs: [
      {
        type: 'approval',
        askId: input.askId,
        verb: RESEARCH_ACCEPT_VERB,
        argsHash: inputRevision,
        workspaceId: 'seedbed',
        research: {
          artifactId: input.artifactId,
          version,
          inputRevision,
          landingPageUrl: input.landingPageUrl,
        },
      },
    ],
  };
}

/** FAKE GatewayClient: scripted research.accept snapshots, no network. */
export class FakeResearchGatewayClient implements GatewayClient {
  readonly label = FAKE_RESEARCH_GATEWAY_LABEL;
  readonly calls: GatewayRunRequest[] = [];
  readonly snapshots = new Map<string, GatewayRunSnapshot>();
  readonly artifacts = new Map<string, { status: string; version: number }>();

  async createRun(request: GatewayRunRequest): Promise<GatewayRunSnapshot> {
    this.calls.push(request);
    const existing = this.snapshots.get(request.idempotencyKey);
    if (existing && !request.resume) return existing;

    if (request.resume) {
      const prior = existing ?? [...this.snapshots.values()].find((row) => {
        const need = Array.isArray(row.needs) ? row.needs[0] : undefined;
        return Boolean(need && typeof need === 'object' && (need as { askId?: string }).askId === request.resume?.askId);
      });
      if (!prior) {
        throw new GatewayClientError('approval_expired', 'no awaiting approval bound to this ask');
      }
      const need = Array.isArray(prior.needs) ? (prior.needs[0] as { askId?: string; research?: { artifactId?: string } }) : undefined;
      if (need?.askId !== request.resume.askId) {
        throw new GatewayClientError('approval_mismatch', 'askId does not match bound operation');
      }
      const artifactId = need?.research?.artifactId ?? '';
      if (request.resume.choice === 'approve') {
        this.artifacts.set(artifactId, { status: 'accepted', version: this.artifacts.get(artifactId)?.version ?? 1 });
      } else if (request.resume.choice === 'edit') {
        this.artifacts.set(artifactId, { status: 'invalidated', version: this.artifacts.get(artifactId)?.version ?? 1 });
      } else {
        this.artifacts.set(artifactId, { status: 'awaiting_acceptance', version: this.artifacts.get(artifactId)?.version ?? 1 });
      }
      const done: GatewayRunSnapshot = {
        runId: prior.runId,
        status: 'completed',
        iteration: prior.iteration + 1,
        outputs: [
          {
            type: 'reply',
            text:
              request.resume.choice === 'approve'
                ? 'FAKE: research artifact accepted for this revision. Spend policies still apply.'
                : request.resume.choice === 'edit'
                  ? 'FAKE: research acceptance invalidated. Create stays blocked until gather+accept of the current URL revision.'
                  : 'FAKE: research left unaccepted. ads.create_campaign stays blocked.',
          },
        ],
      };
      this.snapshots.set(request.idempotencyKey, done);
      return done;
    }

    const landingPageUrl = request.userSuppliedInput?.landingPageUrl;
    if (!landingPageUrl) {
      const blocked: GatewayRunSnapshot = {
        runId: randomUUID(),
        status: 'blocked',
        iteration: 0,
        error: {
          code: 'user_input',
          message:
            'Hub userSuppliedInput.landingPageUrl is required; model/tool text is not a user-supplied URL and there is no default landing page',
          retryable: true,
        },
      };
      this.snapshots.set(request.idempotencyKey, blocked);
      return blocked;
    }

    const artifactId = randomUUID();
    const askId = randomUUID();
    const snapshot = fakeResearchSnapshot({
      runId: randomUUID(),
      askId,
      artifactId,
      landingPageUrl,
    });
    this.artifacts.set(artifactId, { status: 'awaiting_acceptance', version: 1 });
    this.snapshots.set(request.idempotencyKey, snapshot);
    return snapshot;
  }

  async getRun(runId: string): Promise<GatewayRunSnapshot> {
    for (const row of this.snapshots.values()) {
      if (row.runId === runId) return row;
    }
    throw new GatewayClientError('not_found', 'run not found');
  }

  async cancelRun(runId: string, reason: 'hub_cancel' | 'hub_pause' | 'emergency_stop'): Promise<GatewayRunSnapshot> {
    return {
      runId,
      status: reason === 'emergency_stop' ? 'stopped' : 'paused',
      iteration: 0,
    };
  }
}
