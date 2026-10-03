import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const persist = '.wrangler/browser-tests';
rmSync(persist, { recursive: true, force: true });
const migration = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist],
  { stdio: 'inherit', env: { ...process.env, CI: 'true' } });
if (migration.status !== 0) process.exit(migration.status ?? 1);
const child = spawn('npx', ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', '8788',
  '--persist-to', persist, '--var', 'SETUP_CODE:local-browser-test-setup-code-never-deploy',
  '--var', 'AUTH_MODE:passkey'], { stdio: 'inherit', detached: process.platform !== 'win32' });
function stop(signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') { try { process.kill(-child.pid, signal); } catch {} }
  else child.kill(signal);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('exit', code => process.exit(code ?? 1));
