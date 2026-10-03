// Local end-to-end run: wrangler dev on a fresh local D1, a signed exporter payload, the full OAuth flow
// with a local stand-in for Google's token endpoint, then MCP calls. Touches no remote service.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const DEV_PORT = 8787;
const BASE = `http://localhost:${DEV_PORT}`;
const GOOGLE_PORT = 8789;
const PERSIST = '.wrangler/smoke';
const SECRET = '3f9a1c0e5b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a2c4e6b8d0f';
const OWNER = 'owner@example.com';
const CLIENT_ID = 'smoke-client.apps.googleusercontent.com';
const REDIRECT = 'http://127.0.0.1:33418/callback';

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`smoke check failed: ${what}`);
}

function idToken(): string {
  const part = (o: object): string => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    email: OWNER,
    email_verified: true,
  };
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

function cookies(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

// Binding can succeed beside a listener on another address of the same port, so this probes by connecting.
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not answer /health within 60 s');
}

async function signIn(): Promise<string> {
  const reg = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      client_name: 'smoke script',
    }),
  });
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const authorize = new URL(`${BASE}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'smoke',
    resource: `${BASE}/mcp`,
  }).toString();
  const consent = await fetch(authorize, { redirect: 'manual' });
  const html = await consent.text();
  console.log(`consent page: HTTP ${consent.status}, names the client: ${html.includes('smoke script')}`);
  check(consent.status === 200 && html.includes('smoke script'), 'consent page');
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const approve = await fetch(`${BASE}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookies(consent), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ handle, decision: 'approve' }),
  });
  const google = new URL(approve.headers.get('Location') ?? '');
  console.log(
    `approve: HTTP ${approve.status} to ${google.origin}${google.pathname} scope="${google.searchParams.get('scope')}"`,
  );
  check(approve.status === 302 && google.searchParams.get('scope') === 'openid email', 'redirect to Google');
  const callback = await fetch(`${BASE}/callback?code=smoke-code&state=${google.searchParams.get('state')}`, {
    redirect: 'manual',
    headers: { Cookie: cookies(approve) },
  });
  const code = new URL(callback.headers.get('Location') ?? '').searchParams.get('code') ?? '';
  console.log(`callback: HTTP ${callback.status}, code issued: ${code !== ''}`);
  check(code !== '', 'authorization code');
  const token = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  const tokens = (await token.json()) as { access_token: string; expires_in: number };
  console.log(`token: HTTP ${token.status}, expires_in ${tokens.expires_in}`);
  check(token.status === 200 && tokens.expires_in === 3600, 'access token');
  return tokens.access_token;
}

async function main(): Promise<void> {
  for (const port of [DEV_PORT, GOOGLE_PORT]) {
    if (await portInUse(port)) {
      throw new Error(`port ${port} is in use; stop what listens there (lsof -nP -iTCP:${port} -sTCP:LISTEN) and run again`);
    }
  }
  rmSync(PERSIST, { recursive: true, force: true });
  const migrate = spawnSync(
    'npx',
    ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', PERSIST],
    {
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
    },
  );
  if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stdout}${migrate.stderr}`);
  console.log('migrations: applied to a fresh local D1');

  const google = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const ok = new URLSearchParams(body).get('client_id') === CLIENT_ID;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { id_token: idToken() } : { error: 'invalid_client' }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    google.once('error', reject);
    google.listen(GOOGLE_PORT, '127.0.0.1', resolve);
  });

  const vars = [
    `GOOGLE_TOKEN_URL:http://127.0.0.1:${GOOGLE_PORT}/token`,
    `INGEST_SECRET:${SECRET}`,
    `GOOGLE_CLIENT_ID:${CLIENT_ID}`,
    'GOOGLE_CLIENT_SECRET:smoke-secret',
    'AUTH_MODE:google',
    'SETUP_CODE:local-only-smoke-setup-code-do-not-deploy',
    `OWNER_EMAIL:${OWNER}`,
    'BIRTH_YEAR:1990',
  ].flatMap((v) => ['--var', v]);
  const dev: ChildProcess = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(DEV_PORT), '--persist-to', PERSIST, ...vars],
    {
      stdio: 'ignore',
      detached: true,
    },
  );
  const stop = (): void => {
    try {
      if (dev.pid !== undefined) process.kill(-dev.pid, 'SIGTERM');
    } catch {
      // the group has already exited
    }
    google.close();
  };
  // wrangler dev runs in its own process group, so Ctrl-C never reaches it, and Node's default exit skips finally.
  process.on('SIGINT', () => {
    stop();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    stop();
    process.exit(143);
  });
  try {
    await waitForHealth();
    const body = readFileSync('test/fixtures/ldc-payload-sync.composed.min.json');
    const signature =
      /X-Signature: (\S+)/.exec(readFileSync('test/fixtures/ldc-payload-sync.composed.min.json.sig', 'utf8'))?.[1] ??
      '';
    const ingest = await fetch(`${BASE}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Signature': signature },
      body,
    });
    console.log(`ingest: HTTP ${ingest.status} ${await ingest.text()}`);
    check(ingest.status === 200, 'signed ingest');
    const unsigned = await fetch(`${BASE}/ingest`, { method: 'POST', body });
    console.log(`ingest without signature: HTTP ${unsigned.status}`);
    check(unsigned.status === 401, 'unsigned ingest refused');
    const unauthenticated = await fetch(`${BASE}/mcp`, { method: 'POST', body: '{}' });
    console.log(`mcp without token: HTTP ${unauthenticated.status}`);
    check(unauthenticated.status === 401, 'MCP without a token refused');

    const token = await signIn();
    const client = new Client({ name: 'fitbridge-smoke', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const { tools } = await client.listTools();
    console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);
    check(tools.length === 9, 'nine tools');
    const calls: [string, Record<string, string>][] = [
      ['get_daily_summary', { start: '2026-09-22', end: '2026-09-23' }],
      ['get_sleep', { start: '2026-09-23', end: '2026-09-23' }],
      ['search', { query: 'sleep 2026-09-23' }],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      const block = result.content[0];
      const text = block?.type === 'text' ? block.text : '';
      console.log(`\n${name} ${JSON.stringify(args)}\n${text}`);
      check(result.isError !== true && text.startsWith('{'), `${name} answered`);
      if (name === 'get_daily_summary') check(text.includes('["2026-09-23",150,'), 'steps for 2026-09-23 are 150');
    }
    console.log('\nsmoke run passed');
    await client.close();
  } finally {
    stop();
  }
}

await main();
