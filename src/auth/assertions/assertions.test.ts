import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { actAsAssertionClaimsSchema } from '@smallseedlabs/proba-protocol';
import { createAssertionMinter } from './mint.js';
import { loadAssertionPrivateKey } from './private-key.js';
import { createAssertionRuntime } from './runtime.js';
import { createContextBridgeSigners, createTokenSigner } from './testing.js';
import { ActAsAssertionVerifier, ContextServiceTokenVerifier } from './verify.js';
import { createLocalJWKSet } from 'jose';
import { TokenVerificationError } from './errors.js';

describe('act-as assertion mint and verify', () => {
  it('round-trips with the protocol schema', async () => {
    const signers = await createContextBridgeSigners();
    const pem = await signers.hub.writePrivatePem();
    const signingKey = await loadAssertionPrivateKey(pem, { kid: signers.hub.kid, nodeEnv: 'test' });
    const minter = createAssertionMinter({ signingKey });
    const userId = '660e8400-e29b-41d4-a716-446655440001';
    const goalId = '770e8400-e29b-41d4-a716-446655440002';
    const threadId = '880e8400-e29b-41d4-a716-446655440003';

    const { token, claims } = await minter.mint({
      userId,
      workspaceId: 'seedbed',
      goalId,
      threadId,
      ttlSeconds: 300,
    });
    expect(actAsAssertionClaimsSchema.safeParse(claims).success).toBe(true);
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.aud).toContain('proba-hub');

    const verifier = new ActAsAssertionVerifier({ keys: createLocalJWKSet(signers.hub.jwks) });
    const verified = await verifier.verify(token);
    expect(verified).toMatchObject({ sub: userId, workspaceId: 'seedbed', goalId, threadId });
  });

  it('caps TTL at five minutes', async () => {
    const signers = await createContextBridgeSigners();
    const pem = await signers.hub.writePrivatePem();
    const signingKey = await loadAssertionPrivateKey(pem, { kid: signers.hub.kid, nodeEnv: 'test' });
    const minter = createAssertionMinter({ signingKey });
    const { claims } = await minter.mint({
      userId: '660e8400-e29b-41d4-a716-446655440001',
      workspaceId: 'seedbed',
      goalId: '770e8400-e29b-41d4-a716-446655440002',
      threadId: '880e8400-e29b-41d4-a716-446655440003',
      ttlSeconds: 10_000,
    });
    expect(claims.exp - claims.iat).toBe(300);
  });

  it('refuses expired and wrong-audience assertions', async () => {
    const signers = await createContextBridgeSigners();
    const verifier = new ActAsAssertionVerifier({ keys: createLocalJWKSet(signers.hub.jwks) });

    const expired = await signers.mintAssertion({ ttl: -10 });
    await expect(verifier.verify(expired)).rejects.toBeInstanceOf(TokenVerificationError);

    const wrongAud = await signers.mintAssertion({ aud: ['proba-audit'] });
    await expect(verifier.verify(wrongAud)).rejects.toBeInstanceOf(TokenVerificationError);
  });

  it('refuses a service token with the wrong audience or too long a life', async () => {
    const signers = await createContextBridgeSigners();
    const verifier = new ContextServiceTokenVerifier({ keys: createLocalJWKSet(signers.service.jwks) });

    await expect(verifier.verify(await signers.mintServiceToken({ aud: 'proba-audit' }))).rejects.toBeInstanceOf(
      TokenVerificationError
    );
    await expect(verifier.verify(await signers.mintServiceToken({ ttl: 600 }))).rejects.toBeInstanceOf(
      TokenVerificationError
    );
    const ok = await signers.mintServiceToken({ ttl: 60 });
    await expect(verifier.verify(ok)).resolves.toMatchObject({ jti: expect.any(String) });
  });
});

describe('assertion production guards', () => {
  it('refuses to start in production without a private key when CONTEXT_BRIDGE_URL is set', async () => {
    await expect(
      createAssertionRuntime({
        env: 'production',
        contextReaderEnabled: false,
        contextBridgeUrl: 'http://127.0.0.1:3500',
        assertionPrivateKeyFile: '',
        assertionKeyId: '',
        assertionPublicKeyFile: '',
        contextServicePublicKeyFile: '',
      })
    ).rejects.toThrow(/HUB_ASSERTION_PRIVATE_KEY_FILE is required/);
  });

  it('refuses a private key under a temporary directory in production', async () => {
    const hub = await createTokenSigner('hub-prod');
    const pem = await hub.writePrivatePem();
    await expect(
      loadAssertionPrivateKey(pem, { kid: hub.kid, nodeEnv: 'production' })
    ).rejects.toThrow(/temporary directory/);
  });

  it('refuses private key material in a public JWKS file', async () => {
    const hub = await createTokenSigner('hub-bad');
    const dir = await mkdtemp(join(tmpdir(), 'proba-jwks-'));
    const file = join(dir, 'bad.jwks.json');
    await writeFile(file, JSON.stringify({ keys: [{ ...hub.jwks.keys[0], d: 'c2VjcmV0' }] }));
    const { loadPublicKeySet } = await import('./public-key-set.js');
    await expect(loadPublicKeySet(file, { envName: 'HUB_ASSERTION_PUBLIC_KEY_FILE', nodeEnv: 'test' })).rejects.toThrow(
      /private key material/
    );
  });
});
