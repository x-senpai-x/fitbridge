import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { hashSecret, signedIn } from '../src/owner';
import { ORIGIN, SECRET, sign } from './helpers';
import { handleIngest } from '../src/ingest';

const passkeyEnv: Env = { ...env, AUTH_MODE: 'passkey' };
const setupCode = 'local-only-test-setup-code-please-never-deploy';
async function request(path: string, data?: object, headers: Record<string,string> = {}): Promise<Response> {
  const req = new Request(`${ORIGIN}${path}`, data === undefined ? {headers} : {method:'POST',
    headers:{'Content-Type':'application/json',Origin:ORIGIN,...headers},body:JSON.stringify(data)});
  const ctx = createExecutionContext();
  const response = await worker.fetch(req,passkeyEnv,ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('owner bootstrap and private setup', () => {
  it('exposes no settings, pairing key or diagnostics to an unsigned-in visitor', async () => {
    expect(await (await request('/api/state')).json()).toEqual({registered:false,signed_in:false});
    expect((await request('/api/pairing')).status).toBe(401);
    expect((await request('/api/status')).status).toBe(401);
  });
  it('fails closed on a missing or weak deployment setup code', async () => {
    for (const code of ['', 'short']) {
      const response = await worker.fetch(new Request(`${ORIGIN}/api/register/options`,{method:'POST',
        headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({code:setupCode})}),
        {...passkeyEnv,SETUP_CODE:code},createExecutionContext());
      expect(response.status).toBe(503);
    }
  });
  it('refuses a wrong setup code and cross-origin bootstrap', async () => {
    expect((await request('/api/register/options',{code:'wrong'})).status).toBe(401);
    expect((await request('/api/register/options',{code:setupCode},{Origin:'https://attacker.example'})).status).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_challenges').first('n')).toBe(0);
  });
  it('issues a user-verified resident challenge only after correct bootstrap proof', async () => {
    const response = await request('/api/register/options',{code:setupCode});
    expect(response.status).toBe(200);
    const body = await response.json() as {options:{authenticatorSelection:{userVerification:string;residentKey:string};rp:{id:string}}};
    expect(body.options.authenticatorSelection).toMatchObject({userVerification:'required',residentKey:'required'});
    expect(body.options.rp.id).toBe('fitbridge.test');
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(response.headers.get('Set-Cookie')).toContain('Secure');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('requires the browser flow cookie, consumes challenges even on invalid proofs, and rejects replay', async () => {
    const options = await request('/api/register/options',{code:setupCode});
    expect((await request('/api/register/verify',{response:{}})).status).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_challenges').first('n')).toBe(1);
    const cookie = options.headers.get('Set-Cookie')!.split(';')[0]!;
    expect((await request('/api/register/verify',{response:{}},{Cookie:cookie})).status).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_challenges').first('n')).toBe(0);
    expect((await request('/api/register/verify',{response:{}},{Cookie:cookie})).status).toBe(400);
  });
  it('stops repeated unauthenticated attempts without continually incrementing the limiter', async () => {
    for (let i=0;i<20;i++) expect((await request('/api/register/options',{code:'wrong'})).status).toBe(401);
    expect((await request('/api/register/options',{code:'wrong'})).status).toBe(429);
    expect(await env.DB.prepare("SELECT MAX(attempts) FROM auth_attempts WHERE bucket NOT LIKE 'owner:%'").first('MAX(attempts)')).toBe(20);
  });
  it('invalidates expired and old-version sessions', async () => {
    const token = 'a'.repeat(43);
    await env.DB.prepare(`INSERT INTO owner (id,credential,rp_id,recovery_hash,ingest_secret,timezone,primary_source)
      VALUES (1,'{}','fitbridge.test','hash','key','UTC','example.source')`).run();
    await env.DB.prepare('INSERT INTO owner_sessions VALUES (?1,1,?2)').bind(await hashSecret(token),Date.now()+60000).run();
    const req = new Request(`${ORIGIN}/`,{headers:{Cookie:`__Host-fitbridge-session=${token}`}});
    expect(await signedIn(req,passkeyEnv)).not.toBeNull();
    await env.DB.prepare('UPDATE owner SET version=2').run();
    expect(await signedIn(req,passkeyEnv)).toBeNull();
    await env.DB.prepare('UPDATE owner_sessions SET owner_version=2, expires_ms=0').run();
    expect(await signedIn(req,passkeyEnv)).toBeNull();
  });
  it('serves setup with restrictive headers and no third-party scripts', async () => {
    const response = await request('/setup');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(await response.text()).toContain('src="/app.js"');
  });
  it('rejects arbitrary API paths without spending authentication writes', async () => {
    for (let i=0;i<25;i++) expect((await request(`/api/unknown-${i}`,{})).status).toBe(404);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_attempts').first('n')).toBe(0);
  });
  it.each(['/api/recovery-code', '/api/rotate-secret'])('atomically refuses %s when recovery revokes the session during the request', async path => {
    const token = 'r'.repeat(43);
    await env.DB.prepare(`INSERT INTO owner (id,credential,rp_id,recovery_hash,ingest_secret,timezone,primary_source)
      VALUES (1,'{}','fitbridge.test','new-owner-recovery','new-owner-key','UTC','example.source')`).run();
    await env.DB.prepare('INSERT INTO owner_sessions VALUES (?1,1,?2)').bind(await hashSecret(token),Date.now()+1800_000).run();
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith('SELECT 1 AS fresh')) return statement;
        const wrap = (current: D1PreparedStatement): D1PreparedStatement => new Proxy(current, { get(inner, method) {
          if (method === 'bind') return (...values: unknown[]) => wrap(inner.bind(...values));
          if (method === 'first') return async () => {
            const result = await inner.first();
            // Model a completed recovery between session validation and mutation.
            await env.DB.prepare('UPDATE owner SET version = 2').run();
            return result;
          };
          const value = Reflect.get(inner, method);
          return typeof value === 'function' ? value.bind(inner) : value;
        } });
        return wrap(statement);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, {method:'POST',
      headers:{'Content-Type':'application/json',Origin:ORIGIN,Cookie:`__Host-fitbridge-session=${token}`},
      body:JSON.stringify({confirm:'rotate'})}),{...passkeyEnv,DB:db},createExecutionContext());
    expect(response.status).toBe(401);
    expect(await env.DB.prepare('SELECT recovery_hash, ingest_secret FROM owner').first()).toEqual({
      recovery_hash:'new-owner-recovery',ingest_secret:'new-owner-key'});
  });
  it('refuses a first import with a stale time-zone snapshot, then locks the current zone', async () => {
    const token = 't'.repeat(43);
    await env.DB.prepare(`INSERT INTO owner (id,credential,rp_id,recovery_hash,ingest_secret,timezone,primary_source)
      VALUES (1,'{}','fitbridge.test','hash',?1,'Europe/London','com.fitbit.FitbitMobile')`).bind(SECRET).run();
    await env.DB.prepare('INSERT INTO owner_sessions VALUES (?1,1,?2)').bind(await hashSecret(token),Date.now()+1800_000).run();
    const body = JSON.stringify({timestamp:'2026-10-01T12:00:00Z',app_version:'synthetic',source:'health_connect',steps:[{
      uuid:'race-steps',source:'com.fitbit.FitbitMobile',count:1,start_time:'2026-10-01T11:00:00Z',end_time:'2026-10-01T12:00:00Z'}]});
    const headers = {'Content-Type':'application/json','X-Signature':await sign(body)};
    expect((await handleIngest(new Request(`${ORIGIN}/ingest`,{method:'POST',body,headers}),{...passkeyEnv,TIMEZONE:'UTC'})).status).toBe(409);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM records').first('n')).toBe(0);
    expect((await handleIngest(new Request(`${ORIGIN}/ingest`,{method:'POST',body,headers}),{...passkeyEnv,TIMEZONE:'Europe/London'})).status).toBe(200);
    // The lock outlives records, so deleting records cannot reopen the date convention.
    await env.DB.prepare('DELETE FROM records').run();
    expect((await request('/api/settings',{timezone:'UTC',primary_source:'com.fitbit.FitbitMobile',birth_year:''},
      {Cookie:`__Host-fitbridge-session=${token}`})).status).toBe(409);
  });
  it('keeps authenticated rotation and logout usable after the public daily allowance is exhausted', async () => {
    const token = 'm'.repeat(43);
    await env.DB.prepare(`INSERT INTO owner (id,credential,rp_id,recovery_hash,ingest_secret,timezone,primary_source)
      VALUES (1,'{}','fitbridge.test','hash','key','UTC','example.source')`).run();
    await env.DB.prepare('INSERT INTO owner_sessions VALUES (?1,1,?2)').bind(await hashSecret(token),Date.now()+1800_000).run();
    await env.DB.prepare('INSERT INTO auth_attempts VALUES (?1,500,?2)').bind(`owner:${new Date().toISOString().slice(0,10)}`,Date.now()+86400_000).run();
    expect((await request('/api/register/options',{code:'wrong'})).status).toBe(429);
    const headers = {Cookie:`__Host-fitbridge-session=${token}`};
    expect((await request('/api/recovery-code',{},headers)).status).toBe(200);
    expect((await request('/api/rotate-secret',{confirm:'rotate'},headers)).status).toBe(200);
    expect((await request('/api/logout',{},headers)).status).toBe(200);
    expect((await request('/api/pairing',undefined,headers)).status).toBe(401);
  });
});
