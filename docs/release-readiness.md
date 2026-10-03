# Public beta release evidence

Checked on 2026-10-04 in a sanitized checkout with fresh public history.
The original private checkout and personal Worker were preserved.
No captured owner health payloads, account credentials, or personal deployment IDs are included in this release.

## Checks performed

| Command or check | Result |
|---|---|
| Fresh public git clone, npm ci, npm run build, npm run typecheck | Lockfile install, assets, and strict types passed independently |
| GitHub Checks workflow | Both Build and test and Secrets and workflows passed on Linux for commit 8c0ceb9 |
| npm run build | Self-contained browser assets, no CDN requests |
| npm run typecheck | Wrangler binding types and strict Worker/Node/browser TypeScript passed |
| npm test | 16 files, 211 tests passed in local workerd with D1 migrations |
| npm run smoke | Signed ingest, legacy Google stand-in, consent, PKCE, OAuth, nine-tool discovery, summaries, sleep and search passed |
| npm run test:browser | Local Chromium WebAuthn setup, signed sync, OAuth, private diagnostics, passkey login, key rotation, recovery regeneration and revocation passed |
| FITBRIDGE_TEST_URL + FITBRIDGE_TEST_SETUP_CODE, npm run test:browser | Same flow passed on isolated remote Cloudflare resources, 37.8 seconds for the test |
| wrangler d1 migrations apply DB --remote, isolated config | All three additive migrations applied successfully |
| wrangler deploy, isolated config | Upload succeeded, 408.76 KiB compressed, measured Worker startup 49 ms |
| wrangler deploy --dry-run | Bundle/config check passed |
| npm audit --json | Zero reported vulnerabilities across installed dependencies at audit time |
| gitleaks git --pre-commit --staged --redact --config .gitleaks.toml | No detected secrets in staged public files |
| zizmor 1.30.1, actionlint 1.7.12, pinact 5.0.0, shellcheck 0.11.0 | Workflow and shell checks passed; zizmor used default offline audits |
| Desktop/mobile Chromium screenshots | Landing/setup pages visually inspected; no mobile horizontal overflow |
| Local setup-code generator | 32-byte crypto generation and clear controls checked |
| license-checker-rseidelsohn 5.0.1 | Runtime and development license inventories generated; runtime texts and companion MIT notices retained |

The browser uses a Chromium virtual authenticator with required user verification.
This verifies the WebAuthn server/browser exchange; it is not a physical phone, biometric sensor, or hardware security-key trial.
The remote test uses dedicated synthetic D1/KV resources and a separate Worker with cron disabled.
The deployment URL and resource IDs are deliberately excluded from public evidence.
Those test resources are removed after validation.

## Security review

Trail of Bits open-sourcing and sharp-edges instructions informed the release work.
A dedicated read-only source review found and led to fixes for arbitrary-route quota writes, uncapped dynamic registrations, stale grant versions across authentication modes, and stale-session recovery-code mutations.
Further fixes freeze the time zone atomically before first import and keep authenticated incident-response controls separate from anonymous daily allowances.
Deterministic regression tests cover the stale-session mutation and stale first-import settings cases.
The review did not identify a remaining P1 authentication or ownership bypass in the inspected snapshot.
This is source review and test evidence, not a third-party certification or a guarantee of absence of vulnerabilities.

## Limits and outstanding trials

The owner already tested the original Android-to-ChatGPT path using real Fitbit data.
No new physical Android pairing trial was performed for this public beta.
The Life Dashboard pairing URI is implemented from the upstream source; individual record-type selection remains manual.
A first-time user setup under ten minutes has not been measured.
The Deploy-button configuration follows the current Cloudflare guide; a full first-time account/Workers Builds wizard trial is separate from the isolated CLI deployment test.
Additional wearable sources and iOS remain experimental.
No upstream MCP conformance certificate is claimed.
Free-plan availability under distributed abuse and approximate concurrent backfill quota bounds are not guaranteed.

A basic name search found unrelated existing FitBridge health/fitness products.
The public descriptor is fitbridge for Health Connect with an explicit independence statement.
No formal trademark clearance is claimed.
Dependency license inventories are factual package reports, not a legal opinion.

## Reproduce

Use Node 24 or newer.
Run npm ci, npm run build, npm run typecheck, npm test, npm run smoke, npx playwright install chromium, and npm run test:browser.
For a remote trial, first create separate resources and an empty owner database, set FITBRIDGE_TEST_URL and FITBRIDGE_TEST_SETUP_CODE privately, and never point the browser suite at an existing user's instance.
Public CI repeats local verification without Cloudflare credentials or paid AI API keys.

GitHub verification: https://github.com/x-senpai-x/fitbridge/actions/runs/37147942609

The repository has secret scanning, push protection, private vulnerability reporting, and Dependabot security updates enabled.
Dependency update PRs are reviewable proposals and are not automatically merged.
