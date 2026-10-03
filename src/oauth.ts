import type { OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { z } from 'zod';
import { authPages, redirectHostAllowed, SCOPE } from './consent';
import { serveMcp } from './mcp';
import { googleMode, readOwner } from './owner';

const Registration = z.object({ redirect_uris: z.array(z.string()).min(1) });

// Built per request because the token audience is this Worker's own origin.
export function oauthOptions(origin: string): OAuthProviderOptions<Env> {
  const options: OAuthProviderOptions<Env> = {
    apiRoute: '/mcp',
    apiHandler: { fetch: async (request, env, ctx) => {
      const auth = ctx as ExecutionContext & { auth?: { scope: string[] }; props?: unknown };
      if (!auth.auth?.scope.includes(SCOPE)) return new Response('read scope required\n', {
        status: 403, headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="read"' },
      });
      const props = z.object({ ownerVersion: z.number().int().optional(), email: z.string().optional() }).safeParse(auth.props);
      if (props.success && props.data.ownerVersion !== undefined) {
        const owner = await readOwner(env);
        if (!owner || props.data.ownerVersion !== owner.version) return new Response('sign in again\n', {
          status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
        });
      } else if (!googleMode(env) || !props.success || !env.OWNER_EMAIL || props.data.email?.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
        return new Response('sign in again\n', { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } });
      }
      return serveMcp(request, env);
    } },
    defaultHandler: { fetch: (request, env) => authPages(request, env, options) },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 86_400,
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    onError: () => { console.warn(JSON.stringify({ event: 'oauth_request_refused' })); },
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'fitbridge' },
    clientRegistrationCallback: ({ clientMetadata }) => {
      const parsed = Registration.safeParse(clientMetadata);
      const refused = parsed.success
        ? parsed.data.redirect_uris.filter((uri) => !redirectHostAllowed(uri))
        : ['(none given)'];
      if (refused.length > 0) return { description: `redirect URI host not allowed: ${refused.join(', ')}` };
    },
  };
  return options;
}
