# fitbridge design

Status: public beta, 2026-10-04.
This is the binding design for the public self-hosted version.

## Goal and boundary

Each user owns one Worker, one D1 database, and one OAuth KV namespace in their own Cloudflare account.
Life Dashboard Companion sends signed Health Connect JSON from Android.
The Worker stores records and exposes nine read-only MCP tools to an explicitly authorized assistant.
No health data reaches a shared maintainer service.
Fitbit is the tested wearable source; other sources are supported at the payload level but require separate device validation.

## Authentication and setup

Workers Builds prompts for a private SETUP_CODE of 24 to 256 characters.
The code is a bootstrap proof, not an account password or a recovery method.
The server does not accept an empty, missing, or short code.
Registration requires a same-origin JSON request, a browser-bound expiring challenge, and WebAuthn user verification.
The relying-party ID is the actual request hostname and the expected origin is the exact request origin.
An atomic singleton owner insert decides simultaneous registrations; losing attempts cannot replace the owner.
Challenges are atomically consumed with DELETE RETURNING before validating a response.
Ownership and challenges use D1's primary/atomic operations, not KV consistency.

The owner record stores a passkey public key/counter, recovery-code SHA-256 hash, phone signing key, settings, and authentication version.
The 256-bit recovery code is shown once and can be regenerated after a recent passkey login.
Recovery replaces the passkey and increments the authentication version.
Browser sessions and MCP grants bind to that version, including when AUTH_MODE is later changed.
Browser session cookies are host-only, HttpOnly, Secure on HTTPS, SameSite=Lax, and expire after 30 minutes.
Challenges expire after five minutes and bind to a separate host-only flow cookie.
Key regeneration/rotation requires a session established within five minutes.

Phone-key rotation is separate from passkey recovery and requires re-pairing the phone.
Time zone is fixed after the first stored record because record dates would otherwise need a full reindex.
Changing the primary source or birth year marks existing record dates dirty so derived metrics are recomputed.

## OAuth and MCP

The pinned workers-oauth-provider owns OAuth protocol parsing, consent cookies, PKCE, resource audience checks, grants, and token storage.
The app authenticates its owner and renders per-client consent.
Redirects are restricted to approved assistant hosts or local HTTP loopback callbacks.
Remote HTTP, URL credentials, and fragment redirects are refused.
CIMD is enabled with global_fetch_strictly_public; DCR remains available for compatible clients.
The protected handler explicitly enforces read scope and validates grant identity/version.
OAuth access lasts one hour and refresh grants last 30 days.
Google sign-in remains an explicit AUTH_MODE=google compatibility path, requiring its existing owner/client secrets.

The nine tools are get_overview, get_daily_summary, get_sleep, get_workouts, get_intraday, get_trends, correlate, search, and fetch.
Tool output is data, not agent instructions.
Source names and record text are untrusted.
Missing records remain unknown rather than becoming zero.
Search/fetch are retained for document-retrieval clients.

## Data and budgets

HMAC-SHA256 covers the exact received body using UTF-8 bytes of the hexadecimal signing-key string.
Unsigned or incorrectly signed requests are refused before data writes.
Bodies have a 10 MiB limit.
Records are validated, upserted idempotently, and ordered against deletion tombstones by payload timestamp.
One primary source controls derived metrics to avoid counting overlapping source apps twice.
Sleep belongs to the local date it ends; the longest session is the main sleep.
Night metrics are means of samples inside that session.
Heart-rate-zone metrics are explicitly labeled estimates based on age and recorded resting heart rate.
Hourly cron work and tool reads recompute bounded batches of dirty days.

Backfills pause at 70,000 tracked daily row writes and live ingestion at 90,000.
Those are conservative operational guards, not a transactional guarantee of every platform quota.
The native rate limiter rejects authentication bursts without storage writes.
Only known API routes can reach storage-backed authentication limits.
Atomic global daily caps allow at most 500 anonymous owner-auth posts, 500 authenticated management posts, and 100 dynamic registrations before storage operations are refused.
These caps can pause sign-in under attack; they preserve storage headroom but do not promise global DDoS availability.

## Privacy and support

Setup assets are bundled locally and use no CDN or analytics scripts.
Pairing and sync-status endpoints require an owner session and no-store responses.
The browser constructs a diagnostics preview excluding record values, hostnames, source names, passkeys, and secrets.
Persistent logs/traces are disabled by default because the OAuth dependency can warn with client identifiers.
Application error logs contain fixed categories rather than bodies or exception messages.
The maintainer cannot inspect users' accounts and asks only for voluntarily shared redacted diagnostics.

## Release and tests

Keep migration 0001 and add migration 0002 for owner/auth state.
Deploy commands apply migrations through the DB binding name before uploading the Worker.
Check strict types, workerd tests, the legacy OAuth smoke, and real Chromium WebAuthn with a synthetic virtual authenticator.
Remote rehearsals use distinct resource IDs and never the personal deployment's D1/KV.
The owner has tested the original Android flow; browser automation does not establish physical-device behavior of new onboarding.
Downstream updates open PRs, preserve personalized configuration, and require human review before deployment.

The first signed import atomically freezes the owner time zone before writing records.
An import that captured a stale zone or signing key is refused with 409 and must retry.
Logout does not consume the public daily allowance.
Authenticated recovery controls use a separate management allowance.
