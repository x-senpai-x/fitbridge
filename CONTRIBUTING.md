# Contributing

Open a setup issue with the version, device/app versions, status codes, and redacted diagnostics.
For changes, describe the trigger, resulting behavior, and relevant checks.
Use synthetic records, never copied private health records.
Follow [AGENTS.md](AGENTS.md) for architecture and review boundaries.

Install with npm ci on Node 24+.
Run npm run build, npm run typecheck, and npm test before a PR.
Authentication changes also require npm run smoke and npm run test:browser.
Keep dependencies exact-pinned and add schema changes as new migration files.
Do not introduce paid services, maintainer telemetry, or automatic downstream merging.
Write documentation with one sentence per line.

Contributions are accepted under the project's MIT license.
Be respectful, specific, and constructive in issues and reviews.
Use the private security-reporting link for vulnerabilities.
