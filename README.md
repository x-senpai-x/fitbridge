# fitbridge

Connect Android Health Connect to ChatGPT and Claude through a service you host in your own Cloudflare account.
Ask about your sleep, workouts, activity, and health trends using nine read-only MCP tools.

**Beta · Android 14+ · Requires Life Dashboard Companion**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/x-senpai-x/fitbridge)

[Setup guide](https://x-senpai-x.github.io/fitbridge/) · [Troubleshooting](docs/runbook.md#troubleshooting) · [Updates and backups](docs/maintenance.md)

## How it works

```text
Wearable app → Health Connect → Life Dashboard Companion
                                          ↓
                               Your Cloudflare Worker
                                          ↓
                                   ChatGPT or Claude
```

[Life Dashboard Companion](https://github.com/owen282000/life-dashboard-companion-app) reads the records you permit on your phone and sends signed updates to fitbridge.
fitbridge stores them in your Cloudflare account and lets an assistant read them after you authorize access.
The companion is a separate Android app that you install yourself.

## Get started

You need:

- Android 14+ and a wearable app that writes records to Health Connect.
- GitHub and Cloudflare accounts.
- ChatGPT with Developer mode, or Claude with custom MCP connections.

1. [Generate a setup code](https://x-senpai-x.github.io/fitbridge/#setup-code) and save it privately.
2. Click **Deploy to Cloudflare** and enter the code as `SETUP_CODE`.
   Keep the Workers Free plan selected.
3. Open your Worker URL, create a passkey using the setup code, and save your recovery code.
4. Set your time zone and data source, then install [Life Dashboard Companion](https://github.com/owen282000/life-dashboard-companion-app/releases/tag/1.21.2) and pair it using the QR on your fitbridge page.
5. Select the 13 record types listed on that page and run a sync.
6. Add the MCP URL to your assistant and approve read-only access.

The [full setup guide](docs/runbook.md) covers permissions, record selection, and assistant connections.
The companion's **Send Test Ping** is unsigned and will fail; use a real sync after pairing.

Try asking:

> How did my sleep and HRV trend over the last 30 days?

## Available data

- Heart rate, HRV, resting heart rate, respiratory rate, oxygen saturation, and skin temperature.
- Sleep sessions and workouts.
- Steps, distance, total calories, VO2 max, and weight.
- Daily summaries, trends, and correlations across recorded metrics.

Availability depends on what your source app writes to Health Connect.
Missing measurements remain unknown.
Heart-rate zones are estimates; fitbridge does not recreate Fitbit's sleep score, readiness, cardio load, or stress scores.

The setup guide covers Fitbit.
Other Health Connect sources may export different records or units.
iPhone is not currently supported.

## Privacy and cost

Your instance stores data in your own Cloudflare account.
The maintainer receives no health data or telemetry.
An assistant you authorize can read all stored health records, so review its retention and training settings before connecting.
See the [privacy statement](docs/privacy.md) and [security policy](SECURITY.md).

fitbridge is free and uses no paid AI API.
Your assistant may require a subscription.
Cloudflare's free quotas can pause syncing; large history imports may take several days.
See [quotas and maintenance](docs/maintenance.md#quotas).

fitbridge is a general wellness tool, not a medical device.
It is independent of Fitbit, Google, OpenAI, Anthropic, and Cloudflare.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development and [architecture](docs/architecture.md) for the code structure.
For setup problems, [open an issue](https://github.com/x-senpai-x/fitbridge/issues/new/choose) with redacted diagnostics.
Report vulnerabilities through [private security reporting](https://github.com/x-senpai-x/fitbridge/security/advisories/new).

## License

[MIT](LICENSE).
Life Dashboard Companion is maintained separately by Owen Vogelaar and is not bundled with fitbridge.
Dependency and fixture notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [test/fixtures/LICENSE](test/fixtures/LICENSE).
