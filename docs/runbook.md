# Setup guide

## 1. Deploy fitbridge

Use the [public setup guide](https://x-senpai-x.github.io/fitbridge/) and Deploy to Cloudflare button.
Generate a private random setup code in your browser or password manager and enter it as SETUP_CODE during deployment.
The public generator uses browser crypto and does not send the value anywhere.
Keep your Cloudflare account on Workers Free.
The deployment provisions D1/KV and applies migrations through the DB binding.
After deployment, open your Worker URL.
Enter the setup code, create a passkey, and save the recovery code in your password manager.
Save your time zone before the first sync.
Select the primary Health Connect source, normally com.fitbit.FitbitMobile for Fitbit.
For another source, use its actual data-origin package as shown in exported records.

## 2. Pair your Android phone

Install [Life Dashboard Companion 1.21.2](https://github.com/owen282000/life-dashboard-companion-app/releases/tag/1.21.2) from its own maintainer.
On the wearable's app, enable writing the available categories to Health Connect.
Grant the companion read permissions, historical access, and background access.
Do not grant write access or enable Receive for fitbridge.
Set its Android battery usage to Unrestricted.

On the signed-in setup page, choose Show private pairing QR.
Scan it using the companion's pairing scanner; it fills the webhook URL and signing key together.
If both pages are on the phone, the Open pairing link uses the same lifedashboard://pair URI.
Keep the QR and key private.
Do not press Generate after pairing: it replaces a pasted or paired key.

The pairing format can select Health Connect as a source, but cannot select individual record types.
Enable these 13 types manually, all at raw resolution:

| Companion label | Payload key |
|---|---|
| Heart Rate | heart_rate |
| Heart Rate Variability | heart_rate_variability |
| Resting Heart Rate | resting_heart_rate |
| Respiratory Rate | respiratory_rate |
| Oxygen Saturation | oxygen_saturation |
| Skin Temperature | skin_temperature |
| Sleep Sessions | sleep |
| Exercise Sessions | exercise |
| Steps | steps |
| Distance | distance |
| Total Calories | total_calories |
| VO2 Max | vo2_max |
| Weight | weight |

Turn Active Calories, daily totals, Screen Time, and Receive off.
Choose an hourly schedule.
The onboarding Send Test Ping lacks a signing key and is expected to fail with 401.
Finish pairing and trigger a real sync instead.
The setup page confirms Phone connected only after a successfully signed live/backfill payload, not an onboarding ping.
Start with the most recent seven days before importing long history.
Ask your assistant about data coverage before importing more history.

## 3. Connect your assistant

### ChatGPT

On the web, enable Developer mode and add your fitbridge page's MCP URL with OAuth.
Use your passkey in the opened browser, then check the client name and full redirect URI before allowing read access.
Review Data controls, including Improve the model for everyone, before sharing health data.
Select the connector in a conversation and ask about data coverage first.

### Claude

On Claude.ai, add your MCP URL through custom connectors if your plan supports them.
For Claude Code:

```bash
claude mcp add --transport http fitbridge https://YOUR-WORKER.workers.dev/mcp
```

Run /mcp and authenticate in the opened browser.
### Codex

Add your instance and sign in:

```bash
codex mcp add fitbridge --url https://YOUR-WORKER.workers.dev/mcp
codex mcp login fitbridge
```


## Recovery and rotation

If a passkey is lost or the hostname changes, open the instance's setup page and use the recovery code to register a replacement.
Save the new recovery code; the old code becomes invalid.
Reconnect assistants afterward, because recovery invalidates their existing access.
The phone key stays unchanged during passkey recovery.

If a signing key was exposed, sign in and choose Rotate phone signing key, then scan the new pairing QR.
Old signed payloads get 401 until the phone has the replacement key.
You can regenerate a lost recovery code after signing in with your passkey.
Both actions require a login within the last five minutes; sign out and sign in again when prompted.
Without a passkey or recovery code, Cloudflare account access is the administrative recovery boundary.
See [administrative recovery](maintenance.md#administrative-passkey-recovery) if both are lost.

## Terminal deployment

```bash
npm ci
npx wrangler login
scripts/deploy.sh
```

The script creates missing resources, preserves existing secrets, applies additive migrations, and deploys.
Its generated bootstrap code is saved privately under .secrets/setup-code.
Read that local file to claim the instance, then delete it after saving a recovery code.
Check the target Worker name and resource IDs before running the script against an existing installation.
For a Deploy-button copy, retain its provisioned resource IDs and configured production branch.

## Troubleshooting

| Symptom | Action |
|---|---|
| Onboarding test ping fails with 401 | Expected before pairing; run a signed real sync |
| Real sync fails with 401 | Re-pair the exact current key; do not press Generate afterward |
| Sync fails with 409 | Finish owner setup first |
| Backfill fails with 429 | Honor Retry-After and resume after 00:00 UTC |
| Sign-in fails with 429 | Wait for the short burst limit; a global daily cap may require the next UTC day |
| No overnight data | Check Health Connect background/history permissions, battery restrictions, and wearable-app sync |
| Active Calories rejected | Turn it off and keep Total Calories enabled |
| Bucketed data rejected | Change each selected type to raw resolution |
| Time-zone change refused | Dates are already stored; see [time-zone changes](maintenance.md#time-zone-changes) |
| Wrong or empty source metrics | Verify the source package, save it, and let dirty days recompute |
| Passkey fails after domain change | Use recovery to register on the new hostname |
| Assistant's access expires after recovery | Reconnect and approve a new grant |

Use Preview diagnostics before sharing a public support issue.
Add Android/companion versions separately; never paste raw payloads, live logs, or account identifiers.
