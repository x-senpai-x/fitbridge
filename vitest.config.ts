import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const secrets = {
  SETUP_CODE: 'local-only-test-setup-code-please-never-deploy',
  AUTH_MODE: 'google',
  TIMEZONE: 'Asia/Kolkata',
  INGEST_SECRET: '3f9a1c0e5b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a2c4e6b8d0f',
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-google-secret',
  OWNER_EMAIL: 'owner@example.com',
};
// wrangler warns about every declared secret it cannot find in process.env, once per test file.
Object.assign(process.env, secrets);

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, BIRTH_YEAR: '1990', ...secrets } },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.ts'] },
  };
});
