# Threat model

## Assets and trust boundaries

Protect health records, signing keys, recovery codes, owner settings, and assistant grants.
The phone/source app, Cloudflare account, browser/authenticator, and authorized assistant are separate trust boundaries.
The maintainer is outside the deployment's data path.
An authorized assistant can read everything the MCP tools expose; consent is not a per-record access policy.

## Attacks and controls

| Threat | Control and residual boundary |
|---|---|
| First visitor claims a fresh instance | Private deploy-time setup proof and atomic singleton owner insert |
| Registration races | INSERT ON CONFLICT with RETURNING; only the winner creates a session |
| Login replay or challenge swapping | Expiry, exact origin/RP, browser cookie binding, atomic challenge consumption |
| Passkey without user verification | Both creation and assertion verification require user verification |
| Cross-site state changes | Same-origin JSON API requests, host-only cookies, restrictive framing policy |
| Consent bypass/open redirects | Provider consent handles and PKCE; app allowlists safe redirect protocols/hosts |
| CIMD SSRF | Provider URL checks and Cloudflare global_fetch_strictly_public compatibility flag |
| Stolen grant survives passkey recovery | Owner-version checks on every passkey grant, independent of AUTH_MODE |
| Unsigned/forged phone writes | HMAC verification before record writes |
| Replayed signed payload | Idempotent record upserts and timestamp-ordered deletion tombstones; no short freshness window that would break backfills |
| Anonymous quota exhaustion | Known-route gate, edge burst limiter, bounded global daily owner/DCR caps |
| Secret/record leakage through support | Private setup endpoints, no-store responses, diagnostics preview, default-disabled persistent logs |
| Prompt injection through records/source names | Deliberate MCP instructions, strict tool schemas and read-only annotations; assistant must still treat content as untrusted |
| Compromised phone key | Explicit key rotation and re-pairing; passkey recovery alone does not rotate it |
| Lost recovery download | Fresh-passkey-authenticated recovery-code regeneration |
| Dependency or workflow compromise | Exact dependencies, integrity lockfile, pinned actions, updates through reviewed PRs |

## Limits

Read-only tools can disclose health data to an authorized assistant.
They do not prevent an assistant from quoting or otherwise reusing that data.
A compromised Cloudflare account can read and alter the database, code, and secrets.
A compromised browser session can manage setup until expiry.
The native limiter is location-local and approximate; the D1 daily caps are atomic, but can deny legitimate sign-in while under attack.
Free quotas and CPU limits may stop service under unusually heavy use.
The receiver does not establish clinical accuracy or prove that another wearable exports the same metrics.
Changing a custom domain changes WebAuthn's relying-party ID and requires recovery/re-registration.

Owner mutations bind the current owner version and session validity inside their SQL update to prevent stale-session races.
The first import freezes the time zone before record writes, so concurrent setup cannot mix date conventions.
An existing owner session uses a separate quota for incident-response actions and can log out even if the public daily cap is exhausted.
