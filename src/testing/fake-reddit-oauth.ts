import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

/**
 * FAKE Reddit OAuth + Ads API server for tests (127.0.0.1, random port). Implements just
 * enough of /api/v1/access_token, /api/v1/revoke_token, /me/businesses and
 * /businesses/:id/ad_accounts. It issues random fake tokens and never talks to Reddit.
 */
export const FAKE_REDDIT_LABEL = 'FAKE Reddit OAuth server (no network, no spend)';

export interface FakeRedditOptions {
  clientId: string;
  clientSecret: string;
  scope?: string;
  accounts?: Array<{ id: string; name: string; currency?: string }>;
  expiresIn?: number;
}

export class FakeRedditOAuthServer {
  readonly label = FAKE_REDDIT_LABEL;
  readonly codes = new Set<string>();
  readonly refreshTokens = new Set<string>();
  readonly accessTokens = new Set<string>();
  readonly revoked: string[] = [];
  calls: Array<{ path: string; grant?: string }> = [];
  /** Next refresh answers invalid_grant (as Reddit does for a revoked grant). */
  failNextRefresh: 'invalid_grant' | '500' | null = null;
  /** Make the Ads API answer like Reddit does when the app or login has no Ads API access. */
  /** Ads API refusal in Reddit's v3 shape {error:{message, code}}; code is an integer on 404 ("Member ID not found"). */
  adsApiRefusal: { status: number; code: string | number; message: string } | null = null;
  /** Add a second business the member cannot read ad accounts in (403 on its ad_accounts). */
  forbiddenBusiness = false;
  private server?: Server;
  baseUrl = '';

  constructor(private readonly options: FakeRedditOptions) {}

  issueCode(): string {
    const code = `fake-code-${randomBytes(6).toString('hex')}`;
    this.codes.add(code);
    return code;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private basicOk(req: IncomingMessage): boolean {
    const expected = `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64')}`;
    return req.headers.authorization === expected && typeof req.headers['user-agent'] === 'string';
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const url = new URL(req.url ?? '/', 'http://fake');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    this.calls.push({ path: url.pathname, ...(form.get('grant_type') ? { grant: form.get('grant_type')! } : {}) });

    if (url.pathname === '/api/v1/access_token' && req.method === 'POST') {
      if (!this.basicOk(req)) return json(401, { message: 'Unauthorized', error: 401 });
      const grant = form.get('grant_type');
      const accessToken = `fake-access-${randomBytes(8).toString('hex')}`;
      if (grant === 'authorization_code') {
        const code = form.get('code') ?? '';
        if (!this.codes.delete(code)) return json(400, { error: 'invalid_grant' });
        const refreshToken = `fake-refresh-${randomBytes(8).toString('hex')}`;
        this.refreshTokens.add(refreshToken);
        this.accessTokens.add(accessToken);
        return json(200, {
          access_token: accessToken,
          token_type: 'bearer',
          expires_in: this.options.expiresIn ?? 3600,
          scope: this.options.scope ?? 'adsread adsedit',
          refresh_token: refreshToken,
        });
      }
      if (grant === 'refresh_token') {
        if (this.failNextRefresh === '500') {
          this.failNextRefresh = null;
          return json(503, { message: 'unavailable' });
        }
        if (this.failNextRefresh === 'invalid_grant' || !this.refreshTokens.has(form.get('refresh_token') ?? '')) {
          this.failNextRefresh = null;
          return json(400, { error: 'invalid_grant' });
        }
        this.accessTokens.add(accessToken);
        return json(200, {
          access_token: accessToken,
          token_type: 'bearer',
          expires_in: this.options.expiresIn ?? 3600,
          scope: this.options.scope ?? 'adsread adsedit',
        });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/api/v1/revoke_token' && req.method === 'POST') {
      if (!this.basicOk(req)) return json(401, {});
      const token = form.get('token') ?? '';
      this.revoked.push(token);
      this.refreshTokens.delete(token);
      res.writeHead(204);
      return res.end();
    }
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!this.accessTokens.has(bearer)) return json(401, { error: { message: 'bad token' } });
    if (url.pathname.startsWith('/api/v3/')) {
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!this.accessTokens.has(bearer)) return json(401, {
          success: false,
          error: { reason: 'UNAUTHORIZED', explanation: 'This server could not verify that you are authorized to access the document you requested.' },
        });
      if (this.adsApiRefusal) {
        const r = this.adsApiRefusal;
        return json(r.status, { error: { code: r.code, message: r.message } });
      }
    }
    if (url.pathname === '/api/v3/me/businesses') {
      const data = [{ id: 'biz-1', name: 'Fake Business', industry: 'OTHER' }];
      if (this.forbiddenBusiness) data.push({ id: 'biz-x', name: 'No Access Business', industry: 'OTHER' });
      return json(200, { data, pagination: { next_url: null, previous_url: null } });
    }
    if (url.pathname === '/api/v3/businesses/biz-x/ad_accounts') {
      return json(403, { error: { code: 'FORBIDDEN', message: 'member lacks permission on this business' } });
    }
    if (url.pathname === '/api/v3/businesses/biz-1/ad_accounts') {
      return json(200, {
        data: (this.options.accounts ?? [{ id: 'a2_fake1', name: 'Fake Account', currency: 'USD' }]).map((a) => ({
          ...a,
          business_id: 'biz-1',
          type: 'MANAGED',
        })),
      });
    }
    return json(404, { error: { message: 'not found' } });
  }
}
