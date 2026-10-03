# Privacy statement

fitbridge is self-hosted software, not a hosted health-data service.
Each user deploys it into their own Cloudflare account.
The maintainer has no account access, shared backend, telemetry endpoint, or database of users.

## Where information goes

Your wearable/source app writes to Android Health Connect.
Life Dashboard Companion reads the permitted records and sends signed JSON to your Worker.
D1 stores the accepted records, derived figures, rejected records for diagnosis, ingestion metadata, owner settings, and phone signing key.
D1 also stores the passkey public key, recovery-code hash, hashed browser sessions, and short-lived authentication state.
OAuth KV stores client registrations, grants, and token state.
Cloudflare operates that infrastructure under its own account terms.

An assistant you authorize can read all stored records through MCP.
Returned records become subject to that assistant provider's processing, retention, and training settings.
The maintainer does not receive those tool calls or results.
Optional legacy Google authentication sends sign-in requests to Google; the default passkey flow does not.

## Browser and support

The setup page loads bundled assets from your own Worker, with no third-party script CDN or analytics.
Pairing QR codes contain a signing key and must be kept private.
Recovery codes authorize replacing the owner passkey and must be kept private.
Setup codes are held as Cloudflare secrets and protect first registration only.
Persistent Worker logs/traces are disabled by default.
Live logs may include OAuth client identifiers from the dependency; never share them without review and redaction.
The diagnostics preview omits health values, source names, hostnames, credentials, and secrets.
Sharing diagnostics in an issue is voluntary and makes that submitted text public.
GitHub also operates the repository, issue tracker, and documentation site under its own terms.

## Removal

Disconnect the assistant and revoke its connector first.
Delete your Worker, D1 database, and KV namespace in your own Cloudflare dashboard when removing the installation.
Uninstall or disable the companion's webhook configuration and remove Health Connect permissions if no longer needed.
Deleting fitbridge does not delete records already sent to an assistant or records held on the phone.
