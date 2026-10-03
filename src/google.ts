import { z } from 'zod';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const TokenResponse = z.object({ id_token: z.string() });
const IdClaims = z.object({
  iss: z.string(),
  aud: z.string(),
  exp: z.number(),
  email: z.string(),
  email_verified: z.boolean(),
});

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function randomVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export async function googleAuthorizeUrl(env: Env, origin: string, state: string, verifier: string): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID) throw new Error('Google client is not configured');
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/callback`,
    response_type: 'code',
    scope: 'openid email',
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

export type Identity = { ok: true; email: string } | { ok: false; reason: string };

// The ID token comes straight from Google's token endpoint over TLS, which OpenID Connect Core 3.1.3.7
// accepts in place of checking its signature; the claims are still checked.
export async function googleIdentity(env: Env, origin: string, code: string, verifier: string): Promise<Identity> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.OWNER_EMAIL) return { ok: false, reason: 'Google sign-in is not configured' };
  const res = await fetch(env.GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/callback`,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!res.ok) return { ok: false, reason: `Google refused the code (HTTP ${res.status})` };
  const token = TokenResponse.safeParse(await res.json());
  if (!token.success) return { ok: false, reason: 'Google answered without an ID token' };
  const payload = token.data.id_token.split('.')[1] ?? '';
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
  );
  const claims = IdClaims.safeParse(JSON.parse(json));
  if (!claims.success) return { ok: false, reason: 'the ID token is missing claims' };
  const c = claims.data;
  if (!GOOGLE_ISSUERS.includes(c.iss)) return { ok: false, reason: 'the ID token was not issued by Google' };
  if (c.aud !== env.GOOGLE_CLIENT_ID) return { ok: false, reason: 'the ID token is for another client' };
  if (c.exp * 1000 <= Date.now()) return { ok: false, reason: 'the ID token has expired' };
  if (!c.email_verified) return { ok: false, reason: 'the Google account email is not verified' };
  if (c.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
    return { ok: false, reason: 'this server serves one Google account, and it is not this one' };
  }
  return { ok: true, email: c.email };
}
