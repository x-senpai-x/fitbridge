import { test, expect } from '@playwright/test';
import { createHmac, randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';

test.setTimeout(60_000);

test('owner setup, signed ingest, passkey OAuth, redaction, recovery and revoked access', async ({ page, context, browser, baseURL }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const code = process.env.FITBRIDGE_TEST_SETUP_CODE ?? 'local-browser-test-setup-code-never-deploy';
  const origin = baseURL!;
  await page.goto('/setup');
  await expect(page.getByRole('heading', {name:'Create your owner passkey'})).toBeVisible();
  await page.locator('#setup-code').fill('wrong-code');
  await page.locator('#register-button').click();
  await expect(page.locator('#message')).toContainText('Setup code refused');
  await page.locator('#setup-code').fill(code);
  await page.locator('#register-button').click();
  await expect(page.locator('#new-recovery')).not.toBeEmpty();
  let recovery = (await page.locator('#new-recovery').textContent())!;
  await page.locator('#saved-recovery').check();
  await page.locator('#continue-button').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.locator('#timezone').fill('UTC');
  await page.locator('#birth-year').fill('1990');
  await page.getByRole('button', {name:'Save settings'}).click();
  await expect(page.locator('#message')).toContainText('Settings saved');
  await page.locator('#pair-button').click();
  await expect(page.locator('#qr')).toHaveAttribute('src', /^data:image\/png/);
  const secret = (await page.locator('#secret').textContent())!;
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  const link = new URL((await page.locator('#pair-link').getAttribute('href'))!);
  expect(new URLSearchParams(link.hash.slice(1)).get('secret')).toBe(secret);

  const outsider = await browser.newContext({baseURL: origin});
  expect((await outsider.request.get('/api/pairing')).status()).toBe(401);
  expect((await outsider.request.get('/api/status')).status()).toBe(401);
  expect((await outsider.request.post('/api/register/options', {data:{code},headers:{Origin:origin}})).status()).toBe(409);
  expect((await outsider.request.post('/api/settings', {data:{},headers:{Origin:'https://attacker.example'}})).status()).toBe(403);
  const now = new Date().toISOString();
  const body = JSON.stringify({timestamp:now,app_version:'synthetic-test',source:'health_connect',steps:[{uuid:'synthetic-shipping-steps',
    source:'com.fitbit.FitbitMobile',count:123,start_time:new Date(Date.now()-60000).toISOString(),end_time:now}]});
  const signed = { 'Content-Type':'application/json','X-Signature':`sha256=${createHmac('sha256',secret).update(body).digest('hex')}` };
  expect((await outsider.request.post('/ingest',{data:body,headers:{'Content-Type':'application/json'}})).status()).toBe(401);
  expect((await outsider.request.post('/ingest',{data:body,headers:signed})).status()).toBe(200);
  await page.locator('#refresh-button').click();
  await expect(page.locator('#sync-status')).toHaveText('Phone connected');
  await page.locator('#diagnostics-button').click();
  const diagnostics = (await page.locator('#diagnostics').textContent())!;
  expect(diagnostics).not.toContain(secret);
  expect(diagnostics).not.toContain(origin);
  expect(diagnostics).not.toContain('synthetic-shipping-steps');

  const callbackServer = createServer((_request, response) => {
    response.writeHead(200, {'Content-Type':'text/html'}); response.end('<p>Synthetic callback received.</p>');
  });
  await new Promise<void>(resolve => callbackServer.listen(0, '127.0.0.1', resolve));
  const address = callbackServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing callback server address');
  const redirect = `http://127.0.0.1:${address.port}/callback`;
  const registration = await outsider.request.post('/register',{data:{redirect_uris:[redirect],token_endpoint_auth_method:'none',client_name:'Browser smoke'}});
  expect(registration.status()).toBe(201);
  const client = await registration.json() as {client_id:string};
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:redirect,
    code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',
    state:'synthetic-state',scope:'read',resource:`${origin}/mcp`});
  await page.goto(`/authorize?${params}`);
  await expect(page.getByRole('heading',{name:'Allow Browser smoke?'})).toBeVisible();
  const callback = page.waitForRequest(url => url.url().startsWith(redirect));
  await page.getByRole('button',{name:'Allow read-only access'}).click();
  const authCode = new URL((await callback).url()).searchParams.get('code');
  expect(authCode).toBeTruthy();
  await page.waitForURL(`${redirect}**`);
  await new Promise<void>((resolve,reject) => callbackServer.close(error => error ? reject(error) : resolve()));
  const tokenResponse = await outsider.request.post('/token',{form:{grant_type:'authorization_code',code:authCode!,
    redirect_uri:redirect,client_id:client.client_id,code_verifier:verifier}});
  expect(tokenResponse.status()).toBe(200);
  const token = (await tokenResponse.json() as {access_token:string}).access_token;
  const mcpHeaders = {Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
  const rpc = {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic-browser',version:'1'}}};
  expect((await outsider.request.post('/mcp',{data:rpc,headers:mcpHeaders})).status()).toBe(200);

  await page.goto('/setup');
  await page.locator('#logout-button').click();
  await expect(page.locator('#login')).toBeVisible();
  await page.locator('#login-button').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.locator('#regenerate-recovery').click();
  await expect(page.locator('#recovery')).toBeVisible();
  await expect(page.locator('#new-recovery')).toHaveText(/^[A-Za-z0-9_-]{43}$/);
  await expect(page.locator('#new-recovery')).not.toHaveText(recovery);
  const previousRecovery = recovery;
  recovery = (await page.locator('#new-recovery').textContent())!;
  expect((await outsider.request.post('/api/recover/options',{data:{code:previousRecovery},headers:{Origin:origin}})).status()).toBe(401);
  await page.locator('#saved-recovery').check();
  await page.locator('#continue-button').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#rotate-secret').click();
  await expect(page.locator('#message')).toContainText('Phone key rotated');
  await page.locator('#pair-button').click();
  await expect(page.locator('#secret')).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.locator('#secret')).not.toHaveText(secret);
  expect((await outsider.request.post('/ingest',{data:body,headers:signed})).status()).toBe(401);
  const rotatedSecret = (await page.locator('#secret').textContent())!;
  expect((await outsider.request.post('/ingest',{data:body,headers:{...signed,'X-Signature':`sha256=${createHmac('sha256',rotatedSecret).update(body).digest('hex')}`}})).status()).toBe(200);
  await page.locator('#timezone').fill('Europe/London');
  await page.getByRole('button',{name:'Save settings'}).click();
  await expect(page.locator('#message')).toContainText('Time zone is fixed');
  await page.locator('#logout-button').click();
  await page.getByText('Lost your passkey or changed the hostname?').click();
  await page.locator('#recovery-code').fill(recovery);
  await page.locator('#recover-button').click();
  await expect(page.locator('#new-recovery')).not.toBeEmpty();
  expect(await page.locator('#new-recovery').textContent()).not.toBe(recovery);
  expect((await outsider.request.post('/mcp',{data:rpc,headers:mcpHeaders})).status()).toBe(401);
  expect((await outsider.request.post('/api/recover/options',{data:{code:recovery},headers:{Origin:origin}})).status()).toBe(401);
  await outsider.close();
});
