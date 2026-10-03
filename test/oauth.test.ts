import { exports } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { oauthOptions } from '../src/oauth';
import {
  accessToken,
  callJson,
  decide,
  googleClaims,
  mcp,
  ORIGIN,
  OWNER,
  REDIRECT,
  signIn,
  startConsent,
} from './helpers';

function redirectParams(res: Response): URLSearchParams {
  return new URL(res.headers.get('Location') ?? 'http://invalid/').searchParams;
}

// Opens /authorize for a metadata-document client whose document lists only a foreign redirect URI.
async function authorizeForeignCimd(params: Record<string, string>): Promise<Response> {
  const clientId = 'https://apps.example/fitbridge-client.json';
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({
      client_id: clientId,
      client_name: 'Lookalike',
      redirect_uris: ['https://evil.example/cb'],
      token_endpoint_auth_method: 'none',
    }),
  );
  const url = new URL(`${ORIGIN}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'https://evil.example/cb',
    state: 's',
    ...params,
  }).toString();
  const res = await exports.default.fetch(url.toString(), { redirect: 'manual' });
  spy.mockRestore();
  return res;
}

describe('discovery', () => {
  it('challenges an unauthenticated MCP call and publishes metadata', async () => {
    const res = await exports.default.fetch(`${ORIGIN}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    const resource = await (await exports.default.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(resource).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const server = await (await exports.default.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();
    expect(server).toMatchObject({
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    });
  });

  it('issues access tokens for 1 hour and refresh tokens for 30 days', () => {
    const options = oauthOptions(ORIGIN);
    expect(options.accessTokenTTL).toBe(3600);
    expect(options.refreshTokenTTL).toBe(2_592_000);
  });
});

describe('client registration', () => {
  it('accepts the allowed redirect hosts and refuses any other', async () => {
    const register = (uris: string[]) =>
      exports.default.fetch(`${ORIGIN}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: uris, token_endpoint_auth_method: 'none', client_name: 'x' }),
      });
    for (const uri of [
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'https://claude.ai/api/mcp/auth_callback',
      'https://claude.com/cb',
      'http://localhost:9/cb',
      'http://127.0.0.1:9/cb',
    ]) {
      expect((await register([uri])).status, uri).toBe(201);
    }
    const refused = await register(['https://chatgpt.com/cb', 'https://evil.example/cb']);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'redirect URI host not allowed: https://evil.example/cb',
    });
  });

  it('refuses a metadata-document client whose redirect host is not allowed', async () => {
    const res = await authorizeForeignCimd({
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Redirect URI host evil.example is not allowed.');
  });

  it.each([
    [
      'a resource that is not this server',
      {
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
        resource: 'https://elsewhere.example/',
      },
    ],
    ['no PKCE challenge', {}],
  ])('answers a foreign-host metadata-document client sending %s without redirecting', async (_label, params) => {
    const res = await authorizeForeignCimd(params);
    expect(res.headers.get('Location')).toBeNull();
    expect(res.status).toBe(400);
  });

  it('still sends a request error back to an allowed redirect URI', async () => {
    const reg = await exports.default.fetch(`${ORIGIN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', client_name: 'x' }),
    });
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const url = new URL(`${ORIGIN}/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      state: 's',
    }).toString();
    const res = await exports.default.fetch(url.toString(), { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')?.startsWith(`${REDIRECT}?`)).toBe(true);
    expect(redirectParams(res).get('error')).toBe('invalid_request');
  });
});

describe('consent and Google sign-in', () => {
  it('shows a consent page naming the client and its redirect URI', async () => {
    const flow = await signIn();
    const html = await flow.consent.text();
    expect(flow.consent.headers.get('X-Frame-Options')).toBe('DENY');
    expect(html).toContain('<strong>Claude Code</strong>');
    expect(html).toContain(`Access will be sent to <strong>${REDIRECT}</strong>`);
    expect(html).toContain('Access goes to an app on this computer.');
  });

  it('escapes a client name that carries HTML', async () => {
    const reg = await exports.default.fetch(`${ORIGIN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        client_name: '<img src=x onerror=alert(1)>',
      }),
    });
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const url = new URL(`${ORIGIN}/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      state: 's',
    }).toString();
    const html = await (await exports.default.fetch(url.toString())).text();
    expect(html).not.toContain('<img');
    expect(html).toContain('&#60;img src=x onerror=alert(1)&#62;');
  });

  it('escapes a redirect URI that carries HTML', async () => {
    const redirect = 'https://claude.ai/cb?next=<script>alert(1)</script>';
    const reg = await exports.default.fetch(`${ORIGIN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none', client_name: 'x' }),
    });
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const url = new URL(`${ORIGIN}/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      state: 's',
    }).toString();
    const html = await (await exports.default.fetch(url.toString())).text();
    expect(html).not.toContain('<script');
    expect(html).toContain(
      'Access will be sent to <strong>https://claude.ai/cb?next=&#60;script&#62;alert(1)&#60;/script&#62;</strong>',
    );
  });

  it('gives the client a code after consent and the owner signing in, and the code a working token', async () => {
    const flow = await signIn();
    expect(flow.callback.status).toBe(302);
    const params = redirectParams(flow.callback);
    expect(flow.callback.headers.get('Location')?.startsWith(REDIRECT)).toBe(true);
    expect(params.get('state')).toBe('client-state');
    expect(params.get('code')).toBeTruthy();
    const client = await mcp();
    const overview = await callJson<{ time_zone: string }>(client, 'get_overview');
    expect(overview.time_zone).toBe('Asia/Kolkata');
  });

  it.each([
    ['another account', { email: 'someone@example.com' }],
    ['an unverified email', { email_verified: false }],
    ['a token for another client', { aud: 'other.apps.googleusercontent.com' }],
    ['an expired token', { exp: 1 }],
  ])('refuses %s', async (_label, overrides) => {
    const flow = await signIn(googleClaims(overrides));
    const params = redirectParams(flow.callback);
    expect(params.get('error')).toBe('access_denied');
    expect(params.get('code')).toBeNull();
  });

  it('refuses an approval posted without the consent page cookie', async () => {
    const consent = await startConsent();
    expect((await decide(consent, 'approve', false)).status).toBe(400);
  });

  it('refuses a Google callback that skipped consent', async () => {
    const res = await exports.default.fetch(`${ORIGIN}/callback?code=x&state=forged`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  it('sends a denial back to the client', async () => {
    const res = await decide(await startConsent(), 'deny');
    expect(res.status).toBe(302);
    expect(redirectParams(res).get('error')).toBe('access_denied');
  });

  it('sends the browser to Google with openid email and PKCE, and never names the owner, after approval', async () => {
    const res = await decide(await startConsent(), 'approve');
    const location = res.headers.get('Location') ?? '';
    const google = new URL(location);
    expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(google.searchParams.get('scope')).toBe('openid email');
    expect(google.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/callback`);
    expect(google.searchParams.get('code_challenge_method')).toBe('S256');
    expect(google.searchParams.has('login_hint')).toBe(false);
    expect(decodeURIComponent(location)).not.toContain(OWNER);
  });

  it('refuses a token request with a wrong PKCE verifier', async () => {
    const flow = await signIn();
    const code = redirectParams(flow.callback).get('code') ?? '';
    const res = await exports.default.fetch(`${ORIGIN}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: flow.clientId,
        code_verifier: 'x'.repeat(43),
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('accepts a bearer token on /mcp', async () => {
    const token = await accessToken();
    const res = await exports.default.fetch(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).not.toBe(401);
  });
});
