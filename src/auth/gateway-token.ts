import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { AssertionSigningKey } from './assertions/private-key.js';

export const GATEWAY_TOKEN_ISSUER = 'proba-hub';
export const GATEWAY_TOKEN_AUDIENCE = 'proba-gateway';
export const GATEWAY_TOKEN_SUBJECT = 'hub';
export const GATEWAY_TOKEN_MAX_TTL_SECONDS = 120;

export interface MintGatewayTokenInput {
  workspaceId: string;
  ttlSeconds?: number;
  jti?: string;
}

export interface GatewayTokenMinter {
  readonly kid: string;
  mint(input: MintGatewayTokenInput): Promise<string>;
}

export function createGatewayTokenMinter(options: {
  signingKey: AssertionSigningKey;
  now?: () => Date;
}): GatewayTokenMinter {
  const now = options.now ?? (() => new Date());
  const { signingKey } = options;

  return {
    kid: signingKey.kid,
    async mint(input) {
      const iat = Math.floor(now().getTime() / 1000);
      const ttl = Math.min(Math.max(1, input.ttlSeconds ?? GATEWAY_TOKEN_MAX_TTL_SECONDS), GATEWAY_TOKEN_MAX_TTL_SECONDS);
      return new SignJWT({
        iss: GATEWAY_TOKEN_ISSUER,
        aud: GATEWAY_TOKEN_AUDIENCE,
        sub: GATEWAY_TOKEN_SUBJECT,
        workspaceId: input.workspaceId,
        iat,
        exp: iat + ttl,
        jti: input.jti ?? randomUUID(),
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: signingKey.kid, typ: 'JWT' })
        .sign(signingKey.privateKey);
    },
  };
}
