import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import QRCode from 'qrcode';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element ${id}`);
  return el as T;
};
const message = (text: string, error = false): void => { $('message').textContent = text; $('message').className = error ? 'error' : ''; };
const show = (id: string, visible: boolean): void => { $(id).hidden = !visible; };
let recovery = '';
let diagnostics = '';
let pairing: { link: string; secret: string; webhook: string; mcp: string } | null = null;
let poll: ReturnType<typeof setInterval> | undefined;

async function api<T>(path: string, data?: object): Promise<T> {
  const response = await fetch(`/api/${path}`, data === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) {
    if (response.status === 401 && path !== 'register/options' && path !== 'recover/options') hidePrivate();
    throw new Error(value.error ?? `Request failed (${response.status})`);
  }
  return value;
}

function hidePrivate(): void {
  show('dashboard', false); show('pairing', false); show('recovery', false);
  $('qr').removeAttribute('src'); $('secret').textContent = ''; $('new-recovery').textContent = '';
  $('diagnostics').textContent = ''; $('pair-link').removeAttribute('href');
  pairing = null; recovery = ''; diagnostics = '';
  if (poll !== undefined) clearInterval(poll);
  poll = undefined;
  show('login', true);
}

function afterSignIn(): void {
  const next = new URL(location.href).searchParams.get('next');
  if (next) {
    const target = new URL(next, location.origin);
    if (target.origin === location.origin && target.pathname === '/authorize') { location.assign(target.href); return; }
  }
  void loadState();
}

async function register(recovering = false): Promise<void> {
  const kind = recovering ? 'recover' : 'register';
  const code = $<HTMLInputElement>(recovering ? 'recovery-code' : 'setup-code').value;
  const { options } = await api<{options: PublicKeyCredentialCreationOptionsJSON}>(`${kind}/options`, { code });
  const response = await startRegistration({ optionsJSON: options });
  const result = await api<{ recovery_code: string }>(`${kind}/verify`, { response });
  recovery = result.recovery_code;
  $<HTMLInputElement>('setup-code').value = ''; $<HTMLInputElement>('recovery-code').value = '';
  show('register', false); show('login', false); show('dashboard', false); show('recovery', true);
  $('new-recovery').textContent = recovery;
  $<HTMLInputElement>('saved-recovery').checked = false; $<HTMLButtonElement>('continue-button').disabled = true;
  message('Passkey created. Save your recovery code before continuing.');
}

async function login(): Promise<void> {
  const { options } = await api<{options: PublicKeyCredentialRequestOptionsJSON}>('login/options', {});
  const response = await startAuthentication({ optionsJSON: options });
  await api('login/verify', { response });
  afterSignIn();
}

async function refreshStatus(): Promise<void> {
  const status = await api<{ last_received: number | null; last_status: number | null; writes_today: number; rejected_types: unknown; version: string }>('status');
  $('sync-status').textContent = status.last_received ? 'Phone connected' : 'Waiting for a signed sync';
  $('last-sync').textContent = status.last_received ? `Last received ${new Date(status.last_received).toLocaleString()}` : '';
  $('quota').textContent = status.last_status === 429 ? 'Backfill paused at the free write budget. Retry after 00:00 UTC.'
    : `${status.writes_today.toLocaleString()} tracked row writes today. Backfills pause at 70,000; live syncs at 90,000.`;
  // Intentionally exclude timestamps, source names, hostnames, and medical values from shared diagnostics.
  diagnostics = JSON.stringify({ fitbridge_version: status.version, signed_sync_received: status.last_received !== null,
    last_status: status.last_status, writes_today: status.writes_today, rejected_types: status.rejected_types }, null, 2);
}

async function loadState(): Promise<void> {
  try {
    const state = await api<{registered: boolean; signed_in: boolean; settings?: {timezone: string; primary_source: string; birth_year: string}}>('state');
    show('register', !state.registered); show('login', state.registered && !state.signed_in);
    show('dashboard', state.signed_in); show('recovery', false);
    if (!state.signed_in) { message(state.registered ? 'Sign in to manage your private instance.' : 'Your instance is ready to claim.'); return; }
    const settings = state.settings!;
    $<HTMLInputElement>('timezone').value = settings.timezone === 'UTC' ? Intl.DateTimeFormat().resolvedOptions().timeZone : settings.timezone;
    $<HTMLInputElement>('source').value = settings.primary_source;
    $<HTMLInputElement>('birth-year').value = settings.birth_year;
    const mcp = `${location.origin}/mcp`;
    $('mcp').textContent = mcp;
    $('claude-command').textContent = `claude mcp add --transport http fitbridge ${mcp}`;
    await refreshStatus();
    if (poll !== undefined) clearInterval(poll);
    poll = setInterval(() => { if (document.visibilityState === 'visible') void refreshStatus().catch(e => message(String(e.message), true)); }, 30_000);
    message('Save your settings, then connect your phone.');
  } catch (error) { message(error instanceof Error ? error.message : 'Could not load this instance.', true); }
}

function action(id: string, fn: () => Promise<void>): void {
  $(id).addEventListener('click', async () => {
    const button = $<HTMLButtonElement>(id); button.disabled = true;
    try { await fn(); } catch (error) { message(error instanceof Error ? error.message : 'That step failed. Try again.', true); }
    finally { button.disabled = false; }
  });
}

action('register-button', () => register());
action('recover-button', () => register(true));
action('login-button', login);
action('continue-button', async () => { if (!$<HTMLInputElement>('saved-recovery').checked) return; recovery = ''; $('new-recovery').textContent = ''; afterSignIn(); });
$('saved-recovery').addEventListener('change', () => { $<HTMLButtonElement>('continue-button').disabled = !$<HTMLInputElement>('saved-recovery').checked; });
action('save-recovery', async () => {
  const url = URL.createObjectURL(new Blob([`fitbridge recovery code\nInstance: ${location.origin}\nCode: ${recovery}\nKeep this private.\n`], {type:'text/plain'}));
  const a = document.createElement('a'); a.href = url; a.download = 'fitbridge-recovery.txt'; a.click(); URL.revokeObjectURL(url);
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('settings', { timezone: $<HTMLInputElement>('timezone').value, primary_source: $<HTMLInputElement>('source').value,
      birth_year: $<HTMLInputElement>('birth-year').value });
    message('Settings saved. You can pair your phone now.');
  } catch (error) { message(error instanceof Error ? error.message : 'Could not save settings.', true); }
});
action('pair-button', async () => {
  pairing = await api('pairing');
  $<HTMLImageElement>('qr').src = await QRCode.toDataURL(pairing!.link, { width: 264, margin: 2, errorCorrectionLevel: 'M' });
  $<HTMLAnchorElement>('pair-link').href = pairing!.link;
  $('webhook').textContent = pairing!.webhook; $('secret').textContent = pairing!.secret; show('pairing', true);
  message('Scan with the companion pairing scanner, then run a real sync.');
});
action('copy-secret', async () => { if (pairing) await navigator.clipboard.writeText(pairing.secret); message('Signing key copied. Keep it private.'); });
action('copy-mcp', async () => { await navigator.clipboard.writeText(`${location.origin}/mcp`); message('MCP URL copied.'); });
action('refresh-button', refreshStatus);
action('diagnostics-button', async () => { await refreshStatus(); $('diagnostics').textContent = diagnostics; show('diagnostics', true); show('copy-diagnostics', true); });
action('copy-diagnostics', async () => { await navigator.clipboard.writeText(diagnostics); message('Redacted diagnostics copied.'); });
action('logout-button', async () => { await api('logout', {}); hidePrivate(); message('Signed out. Private details hidden.'); });
action('regenerate-recovery', async () => {
  const result = await api<{recovery_code: string}>('recovery-code', {});
  recovery = result.recovery_code; $('new-recovery').textContent = recovery;
  $<HTMLInputElement>('saved-recovery').checked = false; $<HTMLButtonElement>('continue-button').disabled = true;
  show('dashboard', false); show('recovery', true); message('Save the new recovery code. The previous code is no longer valid.');
});
action('rotate-secret', async () => {
  if (!window.confirm('The old signing key will stop working. Pair your phone again with the new QR. Continue?')) return;
  await api('rotate-secret', {confirm:'rotate'});
  pairing = null; $('secret').textContent = ''; $('qr').removeAttribute('src'); $('pair-link').removeAttribute('href'); show('pairing', false);
  message('Phone key rotated. Show the new pairing QR and scan it on your phone.');
});
void loadState();
