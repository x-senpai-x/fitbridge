import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, vi } from 'vitest';

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // Runtime tests isolate database state; use deterministic edge-limit responses.
  // Real binding behavior is checked by the isolated deployment and browser suite.
  vi.spyOn(env.AUTH_RATE_LIMIT, 'limit').mockResolvedValue({ success: true });
});
