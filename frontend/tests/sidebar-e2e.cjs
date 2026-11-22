/* R2: real isolated API, persisted layouts, responsive navigation and keyboard. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const API = process.env.SMOKE_API || 'http://127.0.0.1:8000', WEB = process.env.SMOKE_WEB || 'http://localhost:3000';
const baseline = process.argv.includes('--baseline');
const output = process.env.REDESIGN_OUTPUT;
async function verifyStickySidebar(page, sidebar) {
  const top = (await sidebar.boundingBox()).y;
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
  await page.waitForFunction(() => window.scrollY > 100);
  const scrolledTop = (await sidebar.boundingBox()).y;
  assert.ok(Math.abs(scrolledTop - top) <= 1, `Sidebar moved from ${top} to ${scrolledTop} on scroll`);
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function main() {
  assert.ok(output, 'Set REDESIGN_OUTPUT outside the repository');
  assert.ok([API, WEB].every(url => ['localhost', '127.0.0.1'].includes(new URL(url).hostname)), 'Only isolated local servers');
  assert.equal((await (await fetch(API + '/health')).json()).environment, 'isolated-chat-test');
  const auth = await fetch(API + '/api/v1/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `sidebar-${Date.now()}@example.com`, password: 'SidebarTest123', full_name: 'Prueba de navegación' }) });
  assert.ok(auth.ok);
  const { access_token: token } = await auth.json();
  const user = await (await fetch(API + '/api/v1/auth/me', { headers: { Authorization: 'Bearer ' + token } })).json();
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.SMOKE_BROWSER_CHANNEL || 'chrome', headless: true });
  let currentCase;
  try {
    for (const width of [390, 768, 1280]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
      const pending = new Set();
      currentCase = { width, theme, pending };
      context.on('request', request => pending.add(request));
      context.on('requestfinished', request => pending.delete(request));
      context.on('requestfailed', request => pending.delete(request));
      await context.addInitScript(({ token, user, theme }) => {
        if (sessionStorage.getItem('r2-initialized')) return;
        localStorage.setItem('autopilot_token', token);
        localStorage.setItem('autopilot_user', JSON.stringify(user));
        localStorage.setItem('hasCompletedOnboarding_v1', 'true');
        localStorage.setItem('academic-autopilot-theme-v18', theme);
        localStorage.setItem('layout_sidebar', JSON.stringify({ side: 'left', collapsed: false }));
        sessionStorage.setItem('r2-initialized', 'true');
      }, { token, user, theme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(WEB, { waitUntil: 'domcontentloaded' });
      await page.locator('main h1').first().waitFor({ state: 'visible' });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(output, `${width}-${theme}-expanded.png`), animations: 'disabled' });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page overflow');
      if (!baseline && width >= 768) {
        const sidebar = page.getByRole('complementary', { name: 'Barra lateral' });
        const toggle = sidebar.getByRole('button', { name: 'Ocultar nombres de la barra' });
        await toggle.waitFor({ state: 'visible' });
        await verifyStickySidebar(page, sidebar);
        await toggle.click();
        assert.equal(await sidebar.getAttribute('data-collapsed'), 'true');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sidebar.getByRole('button', { name: 'Mostrar nombres de la barra', exact: true }).waitFor({ state: 'visible' });
        assert.equal(await sidebar.getAttribute('data-collapsed'), 'true', 'Persists collapse');
        await page.locator('main h1').first().waitFor({ state: 'visible' });
        await verifyStickySidebar(page, sidebar);
        const planner = sidebar.getByRole('link', { name: 'Planificador', exact: true });
        await planner.focus();
        await page.getByRole('tooltip', { name: 'Planificador', exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('tooltip').waitFor({ state: 'hidden' });
        await page.keyboard.press('Enter');
        await page.waitForURL('**/planner');
        await page.locator('main h1').first().waitFor();
        await page.waitForTimeout(600);
        assert.equal(await planner.getAttribute('aria-current'), 'page');
        await page.screenshot({ path: path.join(output, `${width}-${theme}-compact.png`), animations: 'disabled' });
        await sidebar.getByRole('link', { name: 'Ajustes', exact: true }).click();
        const names = page.getByRole('switch', { name: 'Mostrar nombres en la barra', exact: true });
        await names.click();
        assert.equal(await sidebar.getAttribute('data-collapsed'), 'false');
        await page.getByRole('button', { name: 'Derecha', exact: true }).click();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await names.waitFor({ state: 'visible' });
        assert.equal(await sidebar.getAttribute('data-side'), 'right');
        assert.equal(await sidebar.getAttribute('data-collapsed'), 'false');
        await sidebar.getByRole('link', { name: 'Chat', exact: true }).click();
        await page.waitForURL('**/chat');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS sidebar ${baseline ? 'before' : 'after'} ${width} ${theme}`);
    }
  } catch (error) {
    if (error.name === 'TimeoutError' && currentCase) {
      const { width, theme, pending } = currentCase;
      // Query strings can contain credentials.
      const urls = [...pending].map(request => request.url().split(/[?#]/, 1)[0]);
      console.error(`Peticiones pendientes al agotar la espera (${width} px, ${theme}):`, urls);
    }
    throw error;
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
