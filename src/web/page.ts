export default `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>fitbridge setup</title><link rel="stylesheet" href="/app.css">
<script type="module" src="/app.js"></script></head>
<body><header><a href="/">fitbridge<span class="badge">self-hosted beta</span></a>
<a href="https://x-senpai-x.github.io/fitbridge/" target="_blank" rel="noreferrer">Setup guide ↗</a></header>
<main><div class="intro"><p class="eyebrow">ANDROID HEALTH CONNECT</p>
<h1>Set up fitbridge</h1><p>Connect your Android health records to ChatGPT or Claude.</p></div>
<p id="message" role="status" aria-live="polite">Checking your instance…</p>
<section id="register" hidden><div class="step">STEP 1 / PASSKEY</div><h2>Create your passkey</h2>
<p>Only the person with the setup code entered during deployment can claim this instance.</p>
<label for="setup-code">Setup code</label><input id="setup-code" type="password" autocomplete="off" minlength="24" maxlength="256" placeholder="The private code you entered in Cloudflare">
<button id="register-button">Create passkey</button><p class="hint">Your browser will ask for a fingerprint, face, PIN, or security key.</p></section>
<section id="login" hidden><div class="step">SIGN IN</div><h2>Welcome back</h2>
<p>Use the passkey you registered for this instance.</p><button id="login-button">Sign in with passkey</button>
<details><summary>Lost your passkey or changed the hostname?</summary><label for="recovery-code">Recovery code</label>
<input id="recovery-code" type="password" autocomplete="off"><button id="recover-button">Replace passkey</button>
<p>Recovery replaces the old passkey and invalidates existing browser sessions and assistant access. Reconnect your assistants afterward.</p></details></section>
<section id="recovery" hidden><div class="step">SAVE BEFORE CONTINUING</div><h2>Your recovery code</h2>
<p>Save this in your password manager. It can replace your passkey, including after moving to a custom domain. It is shown once.</p>
<code id="new-recovery"></code><button id="save-recovery">Download recovery code</button>
<label class="check"><input id="saved-recovery" type="checkbox">I saved my recovery code somewhere private.</label>
<button id="continue-button" disabled>Continue to phone setup</button></section>
<div id="dashboard" hidden>
<section><div class="step">STEP 2 / SETTINGS</div><h2>Choose your settings</h2>
<form id="settings-form"><div class="fields"><div><label for="timezone">Time zone</label><input id="timezone" required placeholder="Europe/London"><p class="hint">Choose before syncing. Stored record dates use this zone.</p></div>
<div><label for="source">Primary Health Connect source</label><input id="source" list="sources" required maxlength="200">
<datalist id="sources"><option value="com.fitbit.FitbitMobile">Fitbit</option><option value="com.sec.android.app.shealth">Samsung Health</option></datalist>
<p class="hint">The source package shown in Health Connect records. Choose one to avoid counting overlapping sources twice.</p></div>
<div><label for="birth-year">Birth year <span class="hint">optional</span></label><input id="birth-year" inputmode="numeric" maxlength="4" pattern="[0-9]{4}"><p class="hint">Only used for estimated heart-rate zones.</p></div></div>
<button type="submit">Save settings</button></form></section>
<section><div class="step">STEP 3 / PHONE</div><h2>Pair your phone</h2>
<p>Install <a href="https://github.com/owen282000/life-dashboard-companion-app/releases/tag/1.21.2" target="_blank" rel="noreferrer">Life Dashboard Companion 1.21.2</a> on your Android 14+ phone, then use its pairing scanner.</p>
<button id="pair-button">Show private pairing QR</button><div id="pairing" hidden><img id="qr" alt="Private Life Dashboard pairing QR" width="264" height="264">
<p><a id="pair-link">Open pairing on this phone</a></p><p class="hint">This QR contains your signing key. Keep it private. Do not press Generate after pairing, because it replaces the key.</p>
<details><summary>Enter the URL and key manually</summary><label>Webhook URL</label><code id="webhook"></code>
<label>HMAC signing key</label><code id="secret"></code><button id="copy-secret">Copy signing key</button></details></div>
<details open><summary>Choose these 13 types, at raw resolution</summary><ul class="types"><li>Heart Rate</li><li>Heart Rate Variability</li><li>Resting Heart Rate</li><li>Respiratory Rate</li><li>Oxygen Saturation</li><li>Skin Temperature</li><li>Sleep Sessions</li><li>Exercise Sessions</li><li>Steps</li><li>Distance</li><li>Total Calories</li><li>VO2 Max</li><li>Weight</li></ul>
<p>Turn Active Calories, daily totals, Screen Time, and Receive off. Set an hourly schedule. Allow read, background, and history access. Set Android battery usage to Unrestricted.</p></details>
<p class="notice">The companion’s Send Test Ping is unsigned and will fail. Run a real sync after pairing.</p>
<div class="sync"><span id="sync-status">Waiting for a signed sync</span><span id="last-sync"></span></div><p id="quota" class="hint"></p>
<button id="refresh-button">Check for data now</button></section>
<section><div class="step">STEP 4 / ASSISTANT</div><h2>Connect your assistant</h2><code id="mcp"></code><button id="copy-mcp">Copy MCP URL</button>
<p><strong>ChatGPT on the web:</strong> enable Developer mode, add this URL with OAuth, and sign in with your passkey. Review the consent page before allowing read-only access.</p>
<p><strong>Claude Code:</strong> run <code class="inline" id="claude-command"></code>, then authenticate through /mcp.</p>
<p class="hint">Assistant plan restrictions apply. Review your assistant's data controls before sharing health data.</p>
<blockquote>How did my sleep and HRV trend over the last 30 days?</blockquote>
<p>Start with the latest seven days. Large history imports may take several days because of Cloudflare’s free quotas.</p></section>
<section class="support"><h2>Need help?</h2><p>Copy a redacted diagnostic summary. Preview it before sharing in a public issue.</p>
<button id="diagnostics-button">Preview diagnostics</button><pre id="diagnostics" hidden></pre><button id="copy-diagnostics" hidden>Copy diagnostics</button>
<p><a href="https://github.com/x-senpai-x/fitbridge/issues/new/choose" target="_blank" rel="noreferrer">Report a setup problem ↗</a></p><button id="logout-button" class="secondary">Sign out</button></section>
<section><h2>Recovery and phone security</h2><p>Sign in with your passkey within the last five minutes to rotate keys.</p>
<button id="regenerate-recovery" class="secondary">Generate a new recovery code</button>
<button id="rotate-secret" class="secondary">Rotate phone signing key</button>
<p class="hint">Rotating the phone key stops syncs signed with the old key. Scan the new pairing QR afterward. Passkey recovery alone does not replace the phone key.</p></section>
</div></main><footer>Your account stores the data. Your chosen assistant receives the records you ask it to read.<br>General wellness only. Not a medical device.</footer></body></html>`;
