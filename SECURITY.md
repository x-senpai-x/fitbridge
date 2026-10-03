# Security policy

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/x-senpai-x/fitbridge/security/advisories/new).
Do not place vulnerabilities, credentials, pairing QR codes, recovery codes, or health records in a public issue.
Include the affected release, reproduction steps with synthetic data, impact, and a proposed mitigation if available.
We aim to acknowledge reports within seven days.

## Supported versions

Only the latest published beta is supported during the beta period.
Check release notes and review upstream update PRs before deploying fixes to your own instance.
The maintainer cannot patch your account remotely.

## Boundaries

Every deployment has one owner.
The first owner proves knowledge of a private deploy-time setup code and registers a user-verified passkey.
Setup codes cannot reclaim an existing instance.
The recovery code replaces the passkey and invalidates browser sessions and MCP access.
It does not replace the phone signing key; rotate that key separately if compromised.
MCP exposes read-only tools, but a granted assistant can read all stored health data.
Account compromise, an unlocked phone, compromised browsers, and malicious assistant behavior are outside server authentication's protection.

See [threat-model.md](docs/threat-model.md) and [privacy.md](docs/privacy.md).
