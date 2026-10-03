# Contributing

For setup problems, use the [issue form](https://github.com/x-senpai-x/fitbridge/issues/new/choose) and include the app versions and reviewed diagnostics from your fitbridge page.
For vulnerabilities, use [private security reporting](https://github.com/x-senpai-x/fitbridge/security/advisories/new).
Never attach signing keys, pairing QR codes, recovery codes, or health records.

## Local development

Use Node 24 or newer.

```bash
npm ci
cp .dev.vars.example .dev.vars
```

Set a private `SETUP_CODE` in `.dev.vars`, then start the local server:

```bash
npx wrangler d1 migrations apply DB --local
npm run dev
```
Local Wrangler uses local D1 and KV resources.
See [architecture](docs/architecture.md) for the request paths and storage model.

## Checks

```bash
npm run build
npm run typecheck
npm test
npm run smoke
npx playwright install chromium
npm run test:browser
```

Unit tests run in workerd against local D1.
The smoke test exercises signed ingestion, OAuth, and the MCP tools with synthetic records.
Browser tests cover passkeys, pairing, consent, recovery, and revoked access using a virtual authenticator.
They recreate only `.wrangler/browser-tests`.
Use a dedicated deployment and synthetic records for any remote testing.

For workflow changes, run `actionlint`, `zizmor .github/workflows`, and `pinact run --check`.
Scan changes for secrets with `gitleaks git --redact --config .gitleaks.toml`.

## Project conventions

- Keep dependencies pinned to exact versions and commit the lockfile.
- Add numbered database migrations; do not edit migrations already applied to a deployment.
- Keep MCP tools read-only and treat source strings and record content as untrusted input.
- Use synthetic data in tests and previews.
- Keep each user's data in their own account; do not add telemetry or paid service dependencies.
- Keep documentation focused on current behavior, with one sentence per line.

Dependency updates require review before merging.
Keep Node types aligned with the supported Node version, and update Vitest together with its Cloudflare plugin.

Describe the problem, resulting behavior, and checks run in your pull request.
Include migration or configuration changes when relevant.
Contributions use the project's MIT license.
