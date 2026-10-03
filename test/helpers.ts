import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { vi } from 'vitest';
import worker from '../src/index';

export const ORIGIN = 'https://fitbridge.test';
export const SECRET = '3f9a1c0e5b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a2c4e6b8d0f';

export async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// Calls the Worker with its own execution context and waits for its waitUntil work, so assertions see it.
export async function post(payload: object | string, signature?: string): Promise<Response> {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const request = new Request(`${ORIGIN}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Signature': signature ?? (await sign(body)) },
    body,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

// Runs one Cron Trigger invocation of the Worker, as Cloudflare does every hour.
export function cron(): Promise<void> {
  return worker.scheduled(createScheduledController({ cron: '0 * * * *' }), env);
}

export function withTimestamp<T extends object>(payload: T, timestamp: string): T & { timestamp: string } {
  return { ...payload, timestamp };
}

export const OWNER = 'owner@example.com';
export const REDIRECT = 'http://localhost:33418/callback';

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function idToken(claims: Record<string, string | number | boolean>): string {
  const part = (o: object) => base64url(new TextEncoder().encode(JSON.stringify(o)));
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.c2lnbmF0dXJl`;
}

export function googleClaims(
  overrides: Record<string, string | number | boolean> = {},
): Record<string, string | number | boolean> {
  return {
    iss: 'https://accounts.google.com',
    aud: 'test-client.apps.googleusercontent.com',
    exp: Math.floor(Date.now() / 1000) + 600,
    email: OWNER,
    email_verified: true,
    ...overrides,
  };
}

export function cookies(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

export interface Consent {
  clientId: string;
  verifier: string;
  consent: Response;
  handle: string;
}

export interface Flow extends Consent {
  callback: Response;
}

// Registers a client and opens the consent page, as an MCP client would.
export async function startConsent(): Promise<Consent> {
  const reg = await exports.default.fetch(`${ORIGIN}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', client_name: 'Claude Code' }),
  });
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const authorize = new URL(`${ORIGIN}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    scope: 'read',
    resource: `${ORIGIN}/mcp`,
  }).toString();
  const consent = await exports.default.fetch(authorize.toString());
  const handle = /name="handle" value="([^"]+)"/.exec(await consent.clone().text())?.[1] ?? '';
  return { clientId, verifier, consent, handle };
}

export function decide(consent: Consent, decision: 'approve' | 'deny', withCookie = true): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...(withCookie ? { Cookie: cookies(consent.consent) } : {}),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ handle: consent.handle, decision }).toString(),
  });
}

// Approves consent and answers Google's token endpoint with these claims.
export async function signIn(claims = googleClaims()): Promise<Flow> {
  const consent = await startConsent();
  const approve = await decide(consent, 'approve');
  const google = new URL(approve.headers.get('Location') ?? '');
  // A Response must be built inside the Worker's request, so the stub makes a new one per call.
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => Response.json({ id_token: idToken(claims) }));
  const callback = await exports.default.fetch(
    `${ORIGIN}/callback?code=google-code&state=${google.searchParams.get('state')}`,
    {
      redirect: 'manual',
      headers: { Cookie: cookies(approve) },
    },
  );
  spy.mockRestore();
  return { ...consent, callback };
}

export async function accessToken(): Promise<string> {
  const flow = await signIn();
  const code = new URL(flow.callback.headers.get('Location') ?? '').searchParams.get('code') ?? '';
  const res = await exports.default.fetch(`${ORIGIN}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: flow.clientId,
      code_verifier: flow.verifier,
    }).toString(),
  });
  const { access_token: token } = (await res.json()) as { access_token: string };
  return token;
}

export async function mcp(): Promise<Client> {
  const token = await accessToken();
  const client = new Client({ name: 'fitbridge-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: (input, init) => exports.default.fetch(new Request(input, init)),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

export interface ToolText {
  text: string;
  isError: boolean;
  blocks: number;
  structured: boolean;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, string | string[] | number>,
): Promise<ToolText> {
  const result = await client.callTool({ name, arguments: args });
  const block = result.content[0];
  if (block?.type !== 'text') throw new Error(`${name} did not answer with a text block`);
  return {
    text: block.text,
    isError: result.isError === true,
    blocks: result.content.length,
    structured: result.structuredContent !== undefined,
  };
}

export async function callJson<T>(
  client: Client,
  name: string,
  args: Record<string, string | string[] | number> = {},
): Promise<T> {
  const result = await callTool(client, name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.text}`);
  return JSON.parse(result.text) as T;
}

// Counts the D1 calls made while it watches: every statement run, all, first or raw, and every batch.
// Rows read are summed from run, all and batch results; first and raw do not return them.
export function watchD1(): { queries: () => number; rowsRead: () => Promise<number> } {
  const statement: D1PreparedStatement = Object.getPrototypeOf(env.DB.prepare('SELECT 1'));
  const all = vi.spyOn(statement, 'all');
  const run = vi.spyOn(statement, 'run');
  const first = vi.spyOn(statement, 'first');
  const raw = vi.spyOn(statement, 'raw');
  const batch = vi.spyOn(env.DB, 'batch');
  return {
    queries: () =>
      all.mock.calls.length +
      run.mock.calls.length +
      first.mock.calls.length +
      raw.mock.calls.length +
      batch.mock.calls.length,
    rowsRead: async () => {
      let rows = 0;
      for (const r of all.mock.results) if (r.type === 'return') rows += (await r.value).meta.rows_read;
      for (const r of run.mock.results) if (r.type === 'return') rows += (await r.value).meta.rows_read;
      for (const r of batch.mock.results) {
        if (r.type === 'return') for (const result of await r.value) rows += result.meta.rows_read;
      }
      return rows;
    },
  };
}
