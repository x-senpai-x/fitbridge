# Architecture

fitbridge runs as one Cloudflare Worker with a D1 database and an OAuth KV namespace.
Each deployment has one owner.
Life Dashboard Companion sends signed records from Android Health Connect; assistants read them through MCP.

## Code layout

| Path | Responsibility |
|---|---|
| `src/index.ts` | Routing, response security headers, and scheduled work |
| `src/owner.ts` | Passkeys, browser sessions, recovery, settings, and pairing |
| `src/consent.ts`, `src/oauth.ts` | OAuth consent and protected MCP access |
| `src/ingest.ts` | Signature verification, validation, record upserts, and deletions |
| `src/metrics.ts` | Daily metric computation |
| `src/tools/` | Read-only MCP tools |
| `src/web/` | Browser setup interface |
| `migrations/` | D1 schema migrations |

## Setup and authentication

`SETUP_CODE` is a deploy-time secret of 24 to 256 characters used only for the first registration.
An atomic singleton insert prevents concurrent registrations from replacing the owner.
Passkey registration and login require user verification, exact origin and relying-party checks, and browser-bound challenges.
Challenges expire after five minutes and are consumed atomically.
Browser sessions expire after 30 minutes and use host-only, HttpOnly, SameSite cookies, with Secure on HTTPS.

D1 stores the passkey public key, recovery-code hash, hashed session tokens, settings, and phone signing key.
Recovery replaces the passkey and increments the owner's authentication version, invalidating browser sessions and assistant grants.
Phone-key rotation is a separate action.
Key rotation and recovery-code regeneration require a passkey login within the last five minutes.

The first import fixes the time zone used for stored dates.
Changing the primary source or birth year marks dates for recomputation.

## OAuth and MCP

`@cloudflare/workers-oauth-provider` handles OAuth protocol parsing, PKCE, resource checks, grants, and token storage in KV.
The app authenticates the owner and displays consent for each client.
Redirects are restricted to approved assistant hosts or local HTTP loopback callbacks.
CIMD is enabled with `global_fetch_strictly_public`; DCR remains available for compatible clients.
MCP requests require read scope and a current owner authentication version.
Access tokens last one hour; refresh grants last 30 days.
`AUTH_MODE=google` retains an optional Google sign-in path for deployments configured with the corresponding secrets.

The tools are `get_overview`, `get_daily_summary`, `get_sleep`, `get_workouts`, `get_intraday`, `get_trends`, `correlate`, `search`, and `fetch`.
Tool responses are untrusted data, not instructions to the assistant.
No tool modifies records.

## Ingestion and metrics

HMAC-SHA256 covers the exact request body using UTF-8 bytes of the hexadecimal signing-key string.
Verification precedes record writes, and request bodies are limited to 10 MiB.
Record upserts are idempotent; deletion tombstones are ordered by payload timestamp.
A single primary source controls derived metrics to avoid counting overlapping source apps twice.

Sleep belongs to the local date it ends, with the longest session used as the main sleep.
Night metrics average samples within that session.
Heart-rate zones are estimates based on age and recorded resting heart rate.
The hourly cron and tool reads recompute bounded batches of dirty dates.
Missing measurements remain unknown.

Backfills pause at 70,000 tracked daily row writes; live syncs pause at 90,000.
These are approximate guards, not a complete ledger of Cloudflare quota use.
Authentication uses an edge burst limiter and atomic daily caps before storage operations.
See the [threat model](threat-model.md) for the security controls and their limits.

## Deployment

The build bundles browser assets locally.
`npm run deploy` applies migrations through the `DB` binding before uploading the Worker.
Migration files are append-only; a Worker rollback does not roll back D1 or KV.
See [maintenance](maintenance.md) for updates, backups, and recovery.
