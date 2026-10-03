# Updates, quotas, backups, and recovery

## Update your copy

The Deploy button creates a copy, not a fork that automatically inherits updates.
The included upstream-update workflow opens a PR from the upstream repository when enabled.
It preserves personalized wrangler.jsonc, README.md, and the workflow itself.
Review release notes, migration files, and any upstream configuration diff before merging.
New bindings and compatibility changes must be copied into your own Wrangler configuration while retaining your IDs.
The bot never auto-merges.
Enable GitHub Actions' permission to create pull requests if you use the workflow.
Merging into the branch connected to Workers Builds triggers deployment.
Keep the deploy command npm run deploy so migrations precede Worker upload.

## Migration policy

Migrations are additive during the beta series.
Never modify a migration already applied to a deployment.
Apply through the binding name:

```bash
npx wrangler d1 migrations apply DB --remote
```

Worker rollback does not roll back D1 or KV data.
Keep older code compatible with added schema and take a backup before a substantial migration.
The 0002 owner/auth migration preserves existing health tables and grants.
Existing Google deployments can retain AUTH_MODE=google and their Google/ingest secrets, but new deployments default to passkeys.
Do not switch a populated legacy instance to passkeys without reviewing the primary source/time zone and phone re-pairing plan.

## Back up privately

```bash
mkdir -p .secrets
chmod 700 .secrets
umask 077
npx wrangler d1 export DB --remote --output .secrets/fitbridge-backup.sql
```

The export contains health records and owner/signing-key state.
Keep it private and encrypted when storing elsewhere.
Do not attach it to an issue or commit it.
Back up before manually editing owner state, changing stored date conventions, or purging records.

## Administrative passkey recovery

Use the recovery code through the UI whenever available.
If both passkey and recovery are lost, a Cloudflare administrator can clear only owner/session/challenge state after a private backup.
That permits a new registration using the deploy-time SETUP_CODE, generates a new phone key, and requires re-pairing.
It does not erase records.
Existing grants must also be invalidated: revoke them or delete/reset OAuth KV before reopening access, because recreating an owner version can otherwise collide with an older grant.
Avoid this manual procedure unless you understand those consequences.

## Time-zone changes

Record local_date is persisted during ingestion, so changing only the setting would corrupt date grouping.
The UI refuses a time-zone change after records exist.
For beta users, the supported simple path is a private backup followed by a new empty deployment in the new zone and a phone backfill.
Keep the old instance private until the new import is checked, then remove it.
No automatic in-place reindex tool is provided in this beta.

## Quotas

Cloudflare Workers Free, D1, and KV quotas are shared with other projects in your account.
Stay on the free plan; fitbridge does not enable paid overages automatically.
Check current platform limits in the dashboard and [Cloudflare's documentation](https://developers.cloudflare.com/workers/platform/limits/).
Backfill and live guards use tracked row writes, not a complete provider billing ledger.
Bulk imports and manual migrations can still hit platform quotas.
Honor HTTP 429 Retry-After rather than repeatedly retrying.
The tracker reserves headroom for live ingestion, authentication, and recomputation, but concurrent large requests can overshoot an approximate threshold.
Large history imports may take several days, and each UTC day's quota resets at 00:00 UTC.

## Logs and feedback

Use the authenticated setup page's redacted status/diagnostics first.
Persistent logs are disabled by default.
If you temporarily enable or tail logs for debugging, keep them private and inspect for client identifiers and other sensitive values before sharing.
The maintainer cannot inspect your Cloudflare account or remotely upgrade your instance.
