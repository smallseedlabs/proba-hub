import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import {
  actAsAssertionClaimsSchema,
  type ActAsAssertionClaims,
  ACT_AS_ASSERTION_MAX_TTL_SECONDS,
} from '@smallseedlabs/proba-protocol';
import { ACT_AS_DEFAULT_AUDIENCES, ACT_AS_ISSUER } from './constants.js';
import type { AssertionSigningKey } from './private-key.js';

export interface MintAssertionInput {
  /** Acting user id (JWT `sub`). */
  userId: string;
  workspaceId: string;
  goalId: string;
  threadId: string;
  scopes?: string[];
  /** Lifetime in seconds after iat. Capped at 5 minutes. Default 120. */
  ttlSeconds?: number;
  jti?: string;
}

export interface AssertionMinter {
  readonly kid: string;
  mint(input: MintAssertionInput): Promise<{ token: string; claims: ActAsAssertionClaims }>;
}

export interface CreateAssertionMinterOptions {
  signingKey: AssertionSigningKey;
  now?: () => Date;
}

/**
 * Mints Hub act-as assertions (EdDSA, iss=proba-hub, aud lists the four bridge
 * audiences, TTL ≤ 5 minutes, kid in the header).
 */
export function createAssertionMinter(options: CreateAssertionMinterOptions): AssertionMinter {
  const now = options.now ?? (() => new Date());
  const { signingKey } = options;

  return {
    kid: signingKey.kid,
    async mint(input) {
      const iat = Math.floor(now().getTime() / 1000);
      const ttl = Math.min(
        Math.max(1, input.ttlSeconds ?? 120),
        ACT_AS_ASSERTION_MAX_TTL_SECONDS
      );
      const claims: ActAsAssertionClaims = actAsAssertionClaimsSchema.parse({
        iss: ACT_AS_ISSUER,
        aud: [...ACT_AS_DEFAULT_AUDIENCES],
        sub: input.userId,
        workspaceId: input.workspaceId,
        goalId: input.goalId,
        threadId: input.threadId,
        scopes: input.scopes?.length ? input.scopes : ['context:build'],
        iat,
        exp: iat + ttl,
        jti: input.jti ?? randomUUID(),
      });

      const token = await new SignJWT({ ...claims })
        .setProtectedHeader({ alg: 'EdDSA', kid: signingKey.kid, typ: 'JWT' })
        .sign(signingKey.privateKey);

      return { token, claims };
    },
  };
}
