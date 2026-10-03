import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
  getOAuthApi,
  type OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider';
import { googleAuthorizeUrl, googleIdentity, randomVerifier } from './google';
import { googleMode, signedIn } from './owner';

export const SCOPE = 'read';
export const ALLOWED_REDIRECT_HOSTS: ReadonlySet<string> = new Set([
  'chatgpt.com',
  'claude.ai',
  'claude.com',
  'localhost',
  '127.0.0.1',
]);

export function redirectHostAllowed(uri: string): boolean {
  try {
    const url = new URL(uri);
    return ALLOWED_REDIRECT_HOSTS.has(url.hostname) && !url.username && !url.password && !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
  } catch {
    return false;
  }
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(status: number, title: string, body: string, headers = new Headers()): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><h1>${escape(title)}</h1>${body}`,
    { status, headers },
  );
}

function consentBody(details: ConsentDescription, handle: string, google = true): string {
  const origin = details.clientDomain
    ? `It is published by <strong>${escape(details.clientDomain)}</strong>.`
    : 'It registered itself, so its name is not verified.';
  const loopback = details.redirectIsLoopback
    ? '<p><strong>Access goes to an app on this computer.</strong> Continue only if you just started signing in from it.</p>'
    : '';
  return `<p><strong>${escape(details.clientName)}</strong> asks to read your fitness data from fitbridge. ${origin}</p>
<p>Access will be sent to <strong>${escape(details.redirectUri)}</strong>.</p>${loopback}
<p>It can read every stored record and daily figure. It cannot change anything.</p>
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">${google ? 'Allow, then sign in with Google' : 'Allow read-only access'}</button> <button name="decision" value="deny">Deny</button></form>`;
}

export async function authPages(request: Request, env: Env, options: OAuthProviderOptions<Env>): Promise<Response> {
  const url = new URL(request.url);
  const oauth = getOAuthApi(options, env);
  try {
    if (url.pathname === '/authorize' && request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      if (!redirectHostAllowed(authRequest.redirectUri)) {
        return page(
          400,
          'Sign-in refused',
          `<p>Redirect URI host ${escape(new URL(authRequest.redirectUri).hostname)} is not allowed.</p>`,
        );
      }
      const details = await oauth.describeConsent(authRequest);
      if (!googleMode(env) && !(await signedIn(request, env))) {
        return Response.redirect(`${url.origin}/setup?next=${encodeURIComponent(url.pathname + url.search)}`, 303);
      }
      const consent = await oauth.beginConsent(authRequest);
      return page(200, `Allow ${details.clientName}?`, consentBody(details, consent.handle, googleMode(env)), consent.headers);
    }
    if (url.pathname === '/authorize' && request.method === 'POST') {
      const owner = googleMode(env) ? null : await signedIn(request, env);
      if (!googleMode(env) && !owner) return page(401, 'Sign in again', '<p>Your owner session expired. Start again from the app.</p>');
      const form = await request.formData();
      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
      if (owner) {
        const { redirectTo } = await oauth.completeAuthorization({ request: approved.request,
          userId: 'owner', metadata: {}, scope: [SCOPE], props: { ownerVersion: owner.version } });
        approved.headers.set('Location', redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      }
      const verifier = randomVerifier();
      const upstream = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
      upstream.headers.set('Location', await googleAuthorizeUrl(env, url.origin, upstream.state, verifier));
      return new Response(null, { status: 302, headers: upstream.headers });
    }
    if (url.pathname === '/callback' && request.method === 'GET') {
      if (!googleMode(env)) return page(404, 'Not found', '<p>This instance uses passkeys.</p>');
      const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
      const code = url.searchParams.get('code');
      if (url.searchParams.get('error') !== null || code === null) {
        headers.set('Location', authorizationErrorRedirect(original, 'access_denied', 'Google sign-in was cancelled'));
        return new Response(null, { status: 302, headers });
      }
      const identity = await googleIdentity(env, url.origin, code, data.verifier);
      if (!identity.ok) {
        headers.set('Location', authorizationErrorRedirect(original, 'access_denied', identity.reason));
        return new Response(null, { status: 302, headers });
      }
      const { redirectTo } = await oauth.completeAuthorization({
        request: original,
        userId: 'owner',
        metadata: {},
        scope: original.scope,
        props: { email: identity.email },
      });
      headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers });
    }
    return new Response('not found\n', { status: 404 });
  } catch (error) {
    // parseAuthRequest throws before the host check above, carrying a metadata-document client's own redirect URI.
    if (
      error instanceof AuthorizationError &&
      error.redirectTo !== undefined &&
      redirectHostAllowed(error.redirectTo)
    ) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) {
      return page(400, 'Sign-in refused', `<p>${escape(error.description)}</p><p>Start again from the app.</p>`);
    }
    if (error instanceof CimdFetchError) return page(400, 'Sign-in refused', '<p>This app could not be verified.</p>');
    throw error;
  }
}
