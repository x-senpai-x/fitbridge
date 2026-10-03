# Beta launch and feedback

The release and public setup guide are the primary announcement artifacts.
Collect setup problems through the GitHub issue form and security reports through private vulnerability reporting.
Ask testers to include versions and the reviewed redacted diagnostic summary, never health payloads, signing keys, recovery codes, QR images, account IDs, or unredacted logs.
Record new source/device compatibility only after an actual end-to-end test.

## Suggested community sequence

Start with a few Android users who already use Health Connect and custom MCP connections.
Measure elapsed time from opening the setup guide to an assistant answering from a signed payload.
Record each blocker, whether setup needed a terminal, and whether recovery and the update PR instructions were understandable.
After that trial, use a Show HN post and relevant self-hosting, Cloudflare, and MCP community showcase channels, following each channel's current rules.
Do not advertise iOS or untested wearables as supported.
No third-party community posts or direct outreach were sent during this release session.

## Reusable announcement draft

I built fitbridge for Health Connect, an open-source receiver that connects Android health records to ChatGPT and Claude through your own Cloudflare Worker.
Each user hosts their own instance on Workers Free; the maintainer never receives their health data.
The beta includes a Deploy button, passkey setup, a Life Dashboard Companion pairing QR, OAuth, and nine read-only MCP tools.
Fitbit is the tested source; additional sources and iOS need further testing.
I would especially like feedback on first-time setup, Android background sync, and the update/recovery instructions.
Please share only redacted diagnostics in public issues.

Repository: https://github.com/x-senpai-x/fitbridge
Setup: https://x-senpai-x.github.io/fitbridge/
