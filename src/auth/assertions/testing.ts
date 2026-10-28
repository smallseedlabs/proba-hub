import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from 'jose';
import { ACT_AS_DEFAULT_AUDIENCES, CONTEXT_HUB_AUDIENCE, CONTEXT_READER_ROLE, CONTEXT_SERVICE_ISSUER } from './constants.js';

/**
 * Signers for automated checks: a locally generated Ed25519 key pair per signer.
 * Nothing here is a credential of a real deployment.
 */

export interface TokenSigner {
  kid: string;
  jwks: { keys: JWK[] };
  privateKey: CryptoKey;
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
  writeJwks(dir?: string): Promise<string>;
  writePrivatePem(dir?: string): Promise<string>;
}

export async function createTokenSigner(kid = `key-${randomUUID().slice(0, 8)}`): Promise<TokenSigner> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' }] };
  return {
    kid,
    jwks,
    privateKey,
    sign: (claims, header = {}) =>
      new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT', ...header }).sign(privateKey),
    async writeJwks(dir) {
      const target = dir ?? (await mkdtemp(join(tmpdir(), 'proba-keys-')));
      const file = join(target, `${kid}.jwks.json`);
      await writeFile(file, JSON.stringify(jwks), { mode: 0o644 });
      return file;
    },
    async writePrivatePem(dir) {
      const { exportPKCS8 } = await import('jose');
      const target = dir ?? (await mkdtemp(join(tmpdir(), 'proba-keys-')));
      const file = join(target, `${kid}.private.pem`);
      await writeFile(file, await exportPKCS8(privateKey), { mode: 0o600 });
      return file;
    },
  };
}

export interface ServiceTokenOptions {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  jti?: string | null;
  iatOffset?: number;
  ttl?: number;
  expOffset?: number;
}

export interface AssertionOptions {
  iss?: string;
  aud?: string[];
  sub?: string;
  workspaceId?: string;
  goalId?: string;
  threadId?: string;
  scopes?: string[];
  jti?: string;
  iatOffset?: number;
  ttl?: number;
  expOffset?: number;
  nbfOffset?: number;
}

export interface ContextBridgeSigners {
  service: TokenSigner;
  hub: TokenSigner;
  mintServiceToken(options?: ServiceTokenOptions, signer?: TokenSigner): Promise<string>;
  mintAssertion(options?: AssertionOptions, signer?: TokenSigner): Promise<string>;
}

export async function createContextBridgeSigners(now: () => Date = () => new Date()): Promise<ContextBridgeSigners> {
  const service = await createTokenSigner('bridge-key-1');
  const hub = await createTokenSigner('hub-key-1');
  const seconds = (): number => Math.floor(now().getTime() / 1000);
  return {
    service,
    hub,
    async mintServiceToken(o = {}, signer = service) {
      const iat = seconds() + (o.iatOffset ?? 0);
      const claims: Record<string, unknown> = {
        iss: o.iss ?? CONTEXT_SERVICE_ISSUER,
        aud: o.aud ?? CONTEXT_HUB_AUDIENCE,
        sub: o.sub ?? CONTEXT_READER_ROLE,
        iat,
        exp: o.expOffset !== undefined ? seconds() + o.expOffset : iat + (o.ttl ?? 60),
      };
      if (o.jti !== null) claims.jti = o.jti ?? randomUUID();
      return signer.sign(claims);
    },
    async mintAssertion(o = {}, signer = hub) {
      const iat = seconds() + (o.iatOffset ?? 0);
      const claims: Record<string, unknown> = {
        iss: o.iss ?? 'proba-hub',
        aud: o.aud ?? [...ACT_AS_DEFAULT_AUDIENCES],
        sub: o.sub ?? randomUUID(),
        workspaceId: o.workspaceId ?? 'seedbed',
        goalId: o.goalId ?? randomUUID(),
        threadId: o.threadId ?? randomUUID(),
        scopes: o.scopes ?? ['context:build'],
        iat,
        exp: o.expOffset !== undefined ? seconds() + o.expOffset : iat + (o.ttl ?? 120),
        jti: o.jti ?? randomUUID(),
      };
      if (o.nbfOffset !== undefined) claims.nbf = seconds() + o.nbfOffset;
      return signer.sign(claims);
    },
  };
}
