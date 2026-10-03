import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { recomputeScheduled } from './daily';
import { handleIngest } from './ingest';
import { oauthOptions } from './oauth';
import { cleanAuthState, ownerApi, reservePublicAuth, runtimeEnv } from './owner';
import html from './web/page';

function protect(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set('Cache-Control', 'no-store');
  copy.headers.set('X-Content-Type-Options', 'nosniff');
  copy.headers.set('X-Frame-Options', 'DENY');
  copy.headers.set('Referrer-Policy', 'no-referrer');
  copy.headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://chatgpt.com https://claude.ai https://claude.com http://localhost:* http://127.0.0.1:* https://accounts.google.com");
  return copy;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && ['/register', '/token'].includes(url.pathname)) {
        const { success } = await env.AUTH_RATE_LIMIT.limit({ key: `oauth:${request.headers.get('CF-Connecting-IP') ?? 'local'}` });
        if (!success || (url.pathname === '/register' && !(await reservePublicAuth(env, 'dcr')))) {
          return protect(Response.json({ error: 'temporarily_unavailable', error_description: 'Authentication rate limit reached. Retry later.' }, { status: 429, headers: { 'Retry-After': '60' } }));
        }
      }
      let response: Response;
      if (url.pathname === '/health') response = Response.json({ ok: true });
      else if (url.pathname.startsWith('/api/')) response = await ownerApi(request, env);
      else if (['/', '/setup'].includes(url.pathname) && request.method === 'GET') response = new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
      else if (['/app.js', '/app.css'].includes(url.pathname)) response = await env.ASSETS.fetch(request);
      else {
        const resolved = await runtimeEnv(env);
        response = url.pathname === '/ingest'
          ? await handleIngest(request, resolved)
          : await new OAuthProvider(oauthOptions(url.origin)).fetch(request, resolved, ctx);
      }
      return protect(response);
    } catch {
      // Never log URLs, request bodies, credential material, or exception messages.
      console.error(JSON.stringify({ event: 'request_failed' }));
      return protect(Response.json({ error: 'Request failed. Retry later or check your Cloudflare deployment.' }, { status: 503 }));
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanAuthState(env);
    await recomputeScheduled(await runtimeEnv(env));
  },
} satisfies ExportedHandler<Env>;
