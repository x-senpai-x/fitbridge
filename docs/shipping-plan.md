# Public release plan

This plan implements the second phase of fitbridge: a self-hosted service that another person can set up and maintain.
The owner has already tested the original Android, signed-ingest, OAuth, and ChatGPT flow with real data.
New tests cover the changed setup and deployment paths with synthetic data.

## Decisions

- Preserve the original private checkout and its working deployment.
- Build the public version in a separate checkout and publish with fresh history.
- Use MIT for fitbridge, retain third-party notices, and audit runtime and development dependency licenses.
- Keep each user's data in their own Cloudflare account.
- Default to passkeys with required user verification and a deploy-time setup code.
- Store owner identity and single-use challenges in D1, not eventually consistent KV.
- Generate the phone signing key on successful owner registration.
- Keep Google sign-in as an explicit compatibility mode for existing deployments.
- Use the existing nine read-only MCP tools and retain search/fetch.
- Serve the setup interface from the Worker and publish plain static documentation through GitHub Pages.
- Keep iOS experimental and do not claim untested wearable support.
- Open downstream update PRs without automatically merging or deploying them.
- Do not install a paid API workflow or add a shared maintainer backend.

## Work and acceptance checks

1. Public repository hygiene.
   Sanitize configuration and documentation, add license/notices, scan secrets, and create a fresh GitHub repository.
2. Owner authentication.
   Verify bootstrap code, enforce single-owner registration atomically, require passkey verification, bind challenges to browser cookies and origin, and implement expiring sessions and recovery.
3. Setup interface.
   Save validated settings before importing data, display a companion-compatible pairing QR, explain the 13 supported raw record types, show signed-sync status, and provide MCP connection instructions.
4. Operational safety.
   Keep unauthenticated diagnostics empty, redact shared diagnostics, document quota/backfill behavior, and provide additive migrations and recovery instructions.
5. Release maintenance.
   Add pinned CI, dependency updates, secret/workflow checks, issue and PR templates, release automation, and a reviewed upstream-update workflow.
6. Verification.
   Run type checks, workerd tests, local end-to-end smoke, browser passkey tests, a fresh-clone build, and isolated deployed checks against separate D1/KV resources.
7. Publication.
   Publish the public repository, documentation, and a prerelease after checks pass.
   Describe measured results and limitations without inventing a ten-minute usability trial or a new physical-device test.

## Evidence

Record the commands and outcomes in release-readiness.md as work completes.
No implementation change should depend on private fixtures or personal resource identifiers.
