import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { addWrites, writesToday, LIVE_LIMIT } from './budget';
import { base64url, randomVerifier } from './google';
import { SCHEMAS } from './records';

export interface Owner {
  id: number;
  credential: string;
  rp_id: string;
  recovery_hash: string;
  ingest_secret: string;
  timezone: string;
  primary_source: string;
  birth_year: string;
  version: number;
  ingest_started: number;
}
interface Challenge {
  id: string;
  kind: 'setup' | 'login' | 'recover';
  challenge: string;
  origin: string;
  recovery_hash: string | null;
  expires_ms: number;
}
interface StoredCredential { id: string; publicKey: string; counter: number; transports?: WebAuthnCredential['transports'] }

const SESSION_SECONDS = 1800;
const CHALLENGE_SECONDS = 300;
const MAX_AUTH_BODY = 32 * 1024;
const POST_ROUTES = new Set(['/api/register/options', '/api/register/verify', '/api/recover/options',
  '/api/recover/verify', '/api/login/options', '/api/login/verify', '/api/settings', '/api/logout',
  '/api/rotate-secret', '/api/recovery-code']);

export async function reservePublicAuth(env: Env, kind: 'owner' | 'dcr' | 'manage'): Promise<boolean> {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  // A global, atomic daily cap protects storage quotas even against distributed callers.
  const limit = kind === 'dcr' ? 100 : 500;
  const result = await env.DB.prepare(`INSERT INTO auth_attempts (bucket, attempts, expires_ms) VALUES (?1, 1, ?2)
    ON CONFLICT (bucket) DO UPDATE SET attempts = attempts + 1 WHERE attempts < ?3 RETURNING attempts`)
    .bind(`${kind}:${day}`, now + 86400_000, limit).all<{attempts: number}>();
  await addWrites(env.DB, now, [result]);
  return result.results.length > 0;
}

export function googleMode(env: Env): boolean { return env.AUTH_MODE === 'google'; }

export async function readOwner(env: Env): Promise<Owner | null> {
  return env.DB.withSession('first-primary').prepare('SELECT * FROM owner WHERE id = 1').first<Owner>();
}

export async function runtimeEnv(env: Env): Promise<Env> {
  if (googleMode(env)) return env;
  const owner = await readOwner(env);
  if (owner === null) return env;
  return { ...env, TIMEZONE: owner.timezone, PRIMARY_SOURCE: owner.primary_source,
    BIRTH_YEAR: owner.birth_year, INGEST_SECRET: owner.ingest_secret };
}

export async function hashSecret(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

async function equalSecret(expected: string, supplied: string): Promise<boolean> {
  // Let Web Crypto compare MACs; do not compare secret strings directly.
  const key = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(expected));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(supplied));
}

function cookieName(request: Request, kind: string): string {
  return `${new URL(request.url).protocol === 'https:' ? '__Host-' : ''}fitbridge-${kind}`;
}

function cookie(request: Request, kind: string, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${cookieName(request, kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function cookieValue(request: Request, kind: string): string {
  const name = cookieName(request, kind);
  return (request.headers.get('Cookie') ?? '').split(';').map(v => v.trim())
    .find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
}

export async function signedIn(request: Request, env: Env): Promise<Owner | null> {
  const token = cookieValue(request, 'session');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return env.DB.withSession('first-primary').prepare(`SELECT o.* FROM owner o JOIN owner_sessions s
    ON s.owner_version = o.version WHERE o.id = 1 AND s.token_hash = ?1 AND s.expires_ms > ?2`)
    .bind(await hashSecret(token), Date.now()).first<Owner>();
}

async function sessionResponse(request: Request, env: Env, owner: Owner, extra: object = {}): Promise<Response> {
  const token = randomVerifier();
  await env.DB.prepare('INSERT INTO owner_sessions (token_hash, owner_version, expires_ms) VALUES (?1, ?2, ?3)')
    .bind(await hashSecret(token), owner.version, Date.now() + SESSION_SECONDS * 1000).run();
  const response = Response.json({ ok: true, ...extra });
  response.headers.append('Set-Cookie', cookie(request, 'session', token, SESSION_SECONDS));
  response.headers.append('Set-Cookie', cookie(request, 'flow', '', 0));
  return response;
}

async function rateAllowed(request: Request, env: Env, management = false): Promise<boolean> {
  if (!(await reservePublicAuth(env, management ? 'manage' : 'owner'))) return false;
  const now = Date.now();
  const bucket = await hashSecret(`${new URL(request.url).pathname}:${request.headers.get('CF-Connecting-IP') ?? 'local'}:${Math.floor(now / 600_000)}`);
  const result = await env.DB.prepare(`INSERT INTO auth_attempts (bucket, attempts, expires_ms) VALUES (?1, 1, ?2)
    ON CONFLICT (bucket) DO UPDATE SET attempts = attempts + 1 WHERE attempts < 20 RETURNING attempts`)
    .bind(bucket, now + 600_000).all<{ attempts: number }>();
  await addWrites(env.DB, now, [result]);
  return result.results.length > 0;
}

async function requestBody(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get('Content-Type') ?? '').startsWith('application/json')) throw new Error('Use JSON');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request body');
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_AUTH_BODY) { await reader.cancel(); throw new Error('Request too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return z.record(z.string(), z.unknown()).parse(JSON.parse(new TextDecoder().decode(bytes)));
}

async function saveChallenge(request: Request, env: Env, kind: Challenge['kind'], challenge: string,
  options: object, recoveryHash: string | null = null): Promise<Response> {
  const id = randomVerifier();
  await env.DB.prepare(`INSERT INTO auth_challenges (id, kind, challenge, origin, recovery_hash, expires_ms)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(await hashSecret(id), kind, challenge, new URL(request.url).origin, recoveryHash,
      Date.now() + CHALLENGE_SECONDS * 1000).run();
  return Response.json({ options }, { headers: { 'Set-Cookie': cookie(request, 'flow', id, CHALLENGE_SECONDS) } });
}

async function consumeChallenge(request: Request, env: Env, kind: Challenge['kind']): Promise<Challenge | null> {
  const id = cookieValue(request, 'flow');
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  // RETURNING makes consumption atomic even with concurrent requests or D1 replicas.
  return env.DB.prepare(`DELETE FROM auth_challenges WHERE id = ?1 AND kind = ?2 AND origin = ?3
    AND expires_ms > ?4 RETURNING *`)
    .bind(await hashSecret(id), kind, new URL(request.url).origin, Date.now()).first<Challenge>();
}

function fromStored(value: string): WebAuthnCredential {
  const c: StoredCredential = JSON.parse(value);
  return { ...c, publicKey: Uint8Array.from(atob(c.publicKey.replace(/-/g, '+').replace(/_/g, '/')), v => v.charCodeAt(0)) };
}
function storeCredential(c: WebAuthnCredential): string {
  return JSON.stringify({ ...c, publicKey: base64url(c.publicKey) });
}

const settingsSchema = z.object({
  timezone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Choose a valid IANA time zone'),
  primary_source: z.string().min(1).max(200).regex(/^[a-zA-Z0-9._-]+$/, 'Enter the Health Connect source package'),
  birth_year: z.string().refine(v => v === '' || (/^\d{4}$/.test(v) && Number(v) >= 1901 && Number(v) <= new Date().getUTCFullYear()), 'Enter a valid birth year or leave it blank'),
});

export async function ownerApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (googleMode(env)) return Response.json({ error: 'This deployment uses legacy Google sign-in.' }, { status: 409 });
  if (request.method === 'GET' && url.pathname === '/api/state') {
    const exists = await readOwner(env);
    const session = await signedIn(request, env);
    return Response.json({ registered: exists !== null, signed_in: session !== null,
      ...(session ? { settings: { timezone: session.timezone, primary_source: session.primary_source, birth_year: session.birth_year } } : {}) });
  }
  if (request.method === 'GET' && url.pathname === '/api/status') {
    if (!(await signedIn(request, env))) return Response.json({ error: 'Sign in again.' }, { status: 401 });
    const last = await env.DB.prepare(`SELECT received_ms, status FROM ingest_log
      WHERE kind IN ('live', 'backfill') ORDER BY received_ms DESC, id DESC LIMIT 1`).first<{ received_ms: number; status: number }>();
    const successful = await env.DB.prepare(`SELECT received_ms FROM ingest_log WHERE status = 200
      AND kind IN ('live', 'backfill') ORDER BY received_ms DESC, id DESC LIMIT 1`).first<{ received_ms: number }>();
    const rejected = await env.DB.prepare(`SELECT type, COUNT(*) AS count FROM rejected_records
      WHERE received_ms > ?1 GROUP BY type ORDER BY count DESC LIMIT 20`).bind(Date.now() - 30 * 86400_000).all<{type: string; count: number}>();
    return Response.json({ version: '0.2.0-beta.3', last_received: successful?.received_ms ?? null,
      last_status: last?.status ?? null, writes_today: await writesToday(env.DB, Date.now()),
      rejected_types: rejected.results.map(row => ({ type: Object.hasOwn(SCHEMAS, row.type) ||
        ['active_calories','body_temperature','hydration','nutrition'].includes(row.type) ? row.type : 'unsupported', count: row.count })) });
  }
  if (request.method === 'GET' && url.pathname === '/api/pairing') {
    const owner = await signedIn(request, env);
    if (!owner) return Response.json({ error: 'Sign in again.' }, { status: 401 });
    const webhook = `${url.origin}/ingest`;
    const fragment = new URLSearchParams({ v: '1', url: webhook, secret: owner.ingest_secret, name: 'fitbridge', sources: 'health_connect' });
    return Response.json({ link: `lifedashboard://pair#${fragment}`, webhook, secret: owner.ingest_secret, mcp: `${url.origin}/mcp` });
  }
  if (request.method !== 'POST') return Response.json({ error: 'Not found.' }, { status: 404 });
  if (!POST_ROUTES.has(url.pathname)) return Response.json({ error: 'Not found.' }, { status: 404 });
  // Same-origin JSON, including for bootstrap and recovery. No permissive CORS.
  if (request.headers.get('Origin') !== url.origin) return Response.json({ error: 'Origin refused.' }, { status: 403 });
  const management = ['/api/settings','/api/logout','/api/rotate-secret','/api/recovery-code'].includes(url.pathname);
  if (management && !(await signedIn(request, env))) return Response.json({ error: 'Sign in again.' }, { status: 401 });
  const edgeLimit = await env.AUTH_RATE_LIMIT.limit({ key: `${management ? 'manage' : 'owner'}:${request.headers.get('CF-Connecting-IP') ?? 'local'}` });
  if (!edgeLimit.success) return Response.json({ error: 'Too many attempts. Retry in a minute.' }, { status: 429, headers: { 'Retry-After': '60' } });
  if (url.pathname !== '/api/logout' && !(await rateAllowed(request, env, management))) return Response.json({ error: 'Too many attempts. Retry in ten minutes.' }, { status: 429, headers: { 'Retry-After': '600' } });
  try {
    const body = await requestBody(request);
    const owner = await readOwner(env);
    if (url.pathname === '/api/register/options' || url.pathname === '/api/recover/options') {
      const recovering = url.pathname.includes('/recover/');
      if (recovering ? owner === null : owner !== null) return Response.json({ error: 'Start again from setup.' }, { status: 409 });
      const supplied = typeof body.code === 'string' ? body.code : '';
      if (recovering) {
        if (!owner || !(await equalSecret(owner.recovery_hash, await hashSecret(supplied)))) return Response.json({ error: 'Recovery code refused.' }, { status: 401 });
      } else if (!env.SETUP_CODE || env.SETUP_CODE.length < 24 || env.SETUP_CODE.length > 256) {
        return Response.json({ error: 'Set a private SETUP_CODE of 24 to 256 characters in Cloudflare, then redeploy.' }, { status: 503 });
      } else if (!(await equalSecret(env.SETUP_CODE, supplied))) {
        return Response.json({ error: 'Setup code refused. Use the code entered during deployment.' }, { status: 401 });
      }
      const options = await generateRegistrationOptions({ rpName: 'fitbridge', rpID: url.hostname,
        userName: 'owner', userID: crypto.getRandomValues(new Uint8Array(32)), attestationType: 'none',
        supportedAlgorithmIDs: [-7, -257], authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
      return saveChallenge(request, env, recovering ? 'recover' : 'setup', options.challenge, options, owner?.recovery_hash ?? null);
    }
    if (url.pathname === '/api/register/verify' || url.pathname === '/api/recover/verify') {
      const recovering = url.pathname.includes('/recover/');
      const challenge = await consumeChallenge(request, env, recovering ? 'recover' : 'setup');
      if (!challenge) return Response.json({ error: 'The registration expired or was already used. Start again.' }, { status: 400 });
      if (recovering ? owner === null : owner !== null) return Response.json({ error: 'Start again from setup.' }, { status: 409 });
      const verification = await verifyRegistrationResponse({ response: body.response as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge, expectedOrigin: url.origin, expectedRPID: url.hostname,
        requireUserVerification: true });
      if (!verification.verified || !verification.registrationInfo) throw new Error('Registration refused');
      const recovery = randomVerifier();
      const credential = storeCredential(verification.registrationInfo.credential);
      const recoveryHash = await hashSecret(recovery);
      let saved: Owner | null;
      if (recovering) {
        saved = await env.DB.prepare(`UPDATE owner SET credential = ?1, rp_id = ?2, recovery_hash = ?3,
          version = version + 1 WHERE id = 1 AND recovery_hash = ?4 RETURNING *`)
          .bind(credential, url.hostname, recoveryHash, challenge.recovery_hash).first<Owner>();
      } else {
        const secret = [...crypto.getRandomValues(new Uint8Array(32))].map(v => v.toString(16).padStart(2, '0')).join('');
        saved = await env.DB.prepare(`INSERT INTO owner (id, credential, rp_id, recovery_hash, ingest_secret,
          timezone, primary_source, birth_year) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
          ON CONFLICT (id) DO NOTHING RETURNING *`)
          .bind(credential, url.hostname, recoveryHash, secret, env.TIMEZONE, env.PRIMARY_SOURCE, env.BIRTH_YEAR).first<Owner>();
      }
      if (!saved) return Response.json({ error: 'Ownership changed. Sign in with the registered passkey.' }, { status: 409 });
      return sessionResponse(request, env, saved, { recovery_code: recovery });
    }
    if (url.pathname === '/api/login/options') {
      if (!owner || owner.rp_id !== url.hostname) return Response.json({ error: 'Use recovery to register a passkey on this hostname.' }, { status: 409 });
      const c = fromStored(owner.credential);
      const options = await generateAuthenticationOptions({ rpID: url.hostname, userVerification: 'required',
        allowCredentials: [{ id: c.id, ...(c.transports ? { transports: c.transports } : {}) }] });
      return saveChallenge(request, env, 'login', options.challenge, options);
    }
    if (url.pathname === '/api/login/verify') {
      const challenge = await consumeChallenge(request, env, 'login');
      if (!challenge || !owner || owner.rp_id !== url.hostname) throw new Error('Login expired');
      const credential = fromStored(owner.credential);
      const verification = await verifyAuthenticationResponse({ response: body.response as AuthenticationResponseJSON,
        expectedChallenge: challenge.challenge, expectedOrigin: url.origin, expectedRPID: owner.rp_id,
        credential, requireUserVerification: true });
      if (!verification.verified) throw new Error('Login refused');
      credential.counter = verification.authenticationInfo.newCounter;
      const updated = await env.DB.prepare('UPDATE owner SET credential = ?1 WHERE id = 1 AND credential = ?2 RETURNING *')
        .bind(storeCredential(credential), owner.credential).first<Owner>();
      if (!updated) throw new Error('Credential changed');
      return sessionResponse(request, env, updated);
    }
    const session = await signedIn(request, env);
    if (!session) return Response.json({ error: 'Sign in again.' }, { status: 401 });
    const sessionHash = await hashSecret(cookieValue(request, 'session'));
    if (url.pathname === '/api/rotate-secret' || url.pathname === '/api/recovery-code') {
      const fresh = await env.DB.prepare('SELECT 1 AS fresh FROM owner_sessions WHERE token_hash = ?1 AND expires_ms > ?2')
        .bind(await hashSecret(cookieValue(request, 'session')), Date.now() + (SESSION_SECONDS - 300) * 1000).first();
      if (!fresh) return Response.json({ error: 'Sign out and sign in with your passkey again before rotating keys.' }, { status: 403 });
      if (url.pathname === '/api/recovery-code') {
        const code = randomVerifier();
        const updated = await env.DB.prepare(`UPDATE owner SET recovery_hash = ?1 WHERE id = 1 AND version = ?2
          AND EXISTS (SELECT 1 FROM owner_sessions WHERE token_hash = ?3 AND owner_version = owner.version AND expires_ms > ?4)
          RETURNING id`).bind(await hashSecret(code), session.version, sessionHash,
            Date.now() + (SESSION_SECONDS - 300) * 1000).first();
        if (!updated) return Response.json({ error: 'Sign in again.' }, { status: 401 });
        return Response.json({ ok: true, recovery_code: code });
      }
      if (body.confirm !== 'rotate') return Response.json({ error: 'Confirm rotation, then pair your phone again.' }, { status: 400 });
      const secret = [...crypto.getRandomValues(new Uint8Array(32))].map(v => v.toString(16).padStart(2, '0')).join('');
      const updated = await env.DB.prepare(`UPDATE owner SET ingest_secret = ?1 WHERE id = 1 AND version = ?2
        AND EXISTS (SELECT 1 FROM owner_sessions WHERE token_hash = ?3 AND owner_version = owner.version AND expires_ms > ?4)
        RETURNING id`).bind(secret, session.version, sessionHash,
          Date.now() + (SESSION_SECONDS - 300) * 1000).first();
      if (!updated) return Response.json({ error: 'Sign in again.' }, { status: 401 });
      return Response.json({ ok: true });
    }
    if (url.pathname === '/api/logout') {
      await env.DB.prepare('DELETE FROM owner_sessions WHERE token_hash = ?1').bind(await hashSecret(cookieValue(request, 'session'))).run();
      return Response.json({ ok: true }, { headers: { 'Set-Cookie': cookie(request, 'session', '', 0) } });
    }
    if (url.pathname === '/api/settings') {
      const settings = settingsSchema.parse(body);
      const hasRecords = await env.DB.prepare('SELECT 1 AS present FROM records LIMIT 1').first();
      if ((hasRecords || session.ingest_started) && settings.timezone !== session.timezone) return Response.json({ error: 'Time zone is fixed after starting an import. See the migration guide.' }, { status: 409 });
      if ((await writesToday(env.DB, Date.now())) > LIVE_LIMIT) return Response.json({ error: 'Daily write budget used. Save tomorrow.' }, { status: 429 });
      const statements = [env.DB.prepare(`UPDATE owner SET timezone = ?1, primary_source = ?2, birth_year = ?3
        WHERE id = 1 AND version = ?4 AND (timezone = ?1 OR (ingest_started = 0 AND NOT EXISTS (SELECT 1 FROM records)))
        AND EXISTS (SELECT 1 FROM owner_sessions WHERE token_hash = ?5 AND owner_version = owner.version AND expires_ms > ?6)
        RETURNING id`).bind(settings.timezone, settings.primary_source, settings.birth_year,
          session.version, sessionHash, Date.now())];
      if (settings.primary_source !== session.primary_source || settings.birth_year !== session.birth_year) {
        statements.push(env.DB.prepare(`INSERT INTO dirty_days (local_date) SELECT DISTINCT local_date FROM records
          WHERE local_date <> '' AND EXISTS (SELECT 1 FROM owner o JOIN owner_sessions s ON s.owner_version = o.version
            WHERE o.version = ?1 AND s.token_hash = ?2 AND s.expires_ms > ?3 AND o.timezone = ?4 AND o.primary_source = ?5 AND o.birth_year = ?6)
          ON CONFLICT DO NOTHING`).bind(session.version, sessionHash, Date.now(), settings.timezone,
            settings.primary_source, settings.birth_year));
      }
      const results = await env.DB.batch(statements);
      await addWrites(env.DB, Date.now(), results);
      if (!results[0]?.results.length) return Response.json({ error: 'Ownership or stored dates changed. Sign in again and review settings.' }, { status: 409 });
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'Not found.' }, { status: 404 });
  } catch {
    return Response.json({ error: 'Could not verify this request. Check the fields or start the passkey step again.' }, { status: 400 });
  }
}

export async function cleanAuthState(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch(['auth_challenges', 'owner_sessions', 'auth_attempts'].map(table =>
    env.DB.prepare(`DELETE FROM ${table} WHERE expires_ms <= ?1`).bind(now)));
}
