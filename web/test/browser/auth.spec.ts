import { test, expect, type Page } from '@playwright/test';

const authUrl = 'http://127.0.0.1:54321/auth/v1';
const password = 'disposable-atlas-browser-password';
async function login(page: Page, email = 'operator@example.test') {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test.beforeAll(async ({ request }) => {
  for (const email of ['operator@example.test', 'denied@example.test']) {
    const response = await request.post(`${authUrl}/admin/users`, {
      headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
      data: { email, password, email_confirm: true },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
});

test('anonymous browser and direct API cannot read protected identity', async ({ page, request }) => {
  await page.goto('/invoices');
  await expect(page).toHaveURL(/\/login$/);
  const response = await request.get('/api/session');
  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: 'Sign in required.' });
});

test('permitted real auth session reaches console and trusted server identity; signout clears access', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  const response = await page.request.get('/api/session?orgId=attacker&actorId=attacker');
  expect(response.status()).toBe(200);
  const identity = await response.json();
  expect(identity.email).toBe('operator@example.test');
  expect(identity.orgId).toBe(process.env.ATLAS_ORG_ID);
  expect(identity.actorId).toMatch(/^[a-f0-9-]{36}$/);
  await page.goto('/invoices');
  await expect(page.getByText('AUTH-ALLOWED-001')).toBeVisible();
  await expect(page.getByText('AUTH-OTHER-SECRET-001')).toHaveCount(0);
  const crossSite = await page.request.post('/auth/signout', { headers: { Origin: 'https://attacker.invalid' } });
  expect(crossSite.status()).toBe(403);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/session')).status()).toBe(401);
});

test('valid non-allowlisted account is denied and its cookies are cleared', async ({ page }) => {
  await login(page, 'denied@example.test');
  await expect(page.getByText('This account is not on the operator allowlist.')).toBeVisible();
  expect((await page.request.get('/api/session')).status()).toBe(401);
  await page.goto('/invoices');
  await expect(page).toHaveURL(/\/login$/);
});

test('direct API rejects a real non-allowlisted session with 403', async ({ page, request }) => {
  const login = await request.post(`${authUrl}/token?grant_type=password`, {
    data: { email: 'denied@example.test', password },
  });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  await page.context().addCookies([{
    name: 'sb-127-auth-token',
    value: `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`,
    domain: '127.0.0.1', path: '/', sameSite: 'Lax',
  }]);
  const response = await page.request.get('/api/session');
  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual({ error: 'Operator access denied.' });
});

test('genuinely expired access token with revoked refresh session cannot regain access', async ({ page, request }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Atlas operator console' })).toBeVisible();
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.filter(c => /sb-.*-auth-token(?:\.\d+)?$/.test(c.name)).sort((a,b) => a.name.localeCompare(b.name)).map(c => c.value).join('');
  expect(sessionCookie.startsWith('base64-')).toBeTruthy();
  const session = JSON.parse(Buffer.from(sessionCookie.slice(7), 'base64url').toString());
  const logout = await request.post(`${authUrl}/logout?scope=global`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  expect(logout.ok()).toBeTruthy();
  // Home has no mounted auth client, so no background browser refresh. Wait for
  // GoTrue's actual issued JWT expiry; no clock mocks or fabricated expired JWT.
  const exp = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString()).exp;
  await new Promise(resolve => setTimeout(resolve, Math.max(0, exp * 1000 - Date.now() + 1500)));
  expect((await page.request.get('/api/session')).status()).toBe(401);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});
