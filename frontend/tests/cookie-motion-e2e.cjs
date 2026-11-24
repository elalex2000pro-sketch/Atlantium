const assert = require('node:assert/strict');
const path = require('node:path');

async function verifyCookieMotion(browser, { WEB, token, user, output }) {
  for (const width of [1440, 390]) {
    const reduced = width === 390;
    const viewport = { width, height: reduced ? 680 : 900 };
    const context = await browser.newContext({
      viewport, serviceWorkers: 'block', reducedMotion: reduced ? 'reduce' : 'no-preference',
    });
    try {
      await context.addInitScript(({ token, user }) => {
        localStorage.setItem('autopilot_token', token);
        localStorage.setItem('autopilot_user', JSON.stringify(user));
        localStorage.setItem('hasCompletedOnboarding_v1', 'true');
      }, { token, user });
      const page = await context.newPage();
      await page.route('**/version.json?*', route => route.fulfill({
        json: reduced ? { enabled: false } : { version: '990.0.0', enabled: true },
      }));
      await page.goto(WEB + '/planner');
      const welcome = page.locator('[data-cookie-welcome]');
      const launcher = page.locator('.cookie-launcher');
      if (!reduced) {
        const update = page.getByRole('button', { name: 'Recordar más tarde', exact: true });
        await update.waitFor();
        assert.equal(await welcome.count(), 0, 'El saludo debe esperar a la actualización');
        await update.click();
      }
      await welcome.getByText('Hola, Usuario, ¿qué tal?', { exact: true }).waitFor();
      assert.equal(await welcome.getAttribute('data-cookie-welcome'), reduced ? 'corner' : 'center');
      const initialBounds = await launcher.boundingBox();
      assert.ok(initialBounds);
      if (!reduced) {
        const center = welcome.getByRole('button', { name: 'Saltar saludo de Cookie' });
        const bounds = await center.boundingBox();
        assert.ok(bounds && Math.abs(bounds.x + bounds.width / 2 - width / 2) < 2);
        assert.ok(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2) < 2);
        await center.locator('[data-cookie-blinking="true"]').waitFor();
        assert.equal(await page.locator('main').evaluate(el => {
          const { x, y } = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(x + 24, y + 30));
        }), true);
      } else {
        assert.ok(await launcher.isVisible());
        assert.equal(await welcome.getByRole('button').count(), 0);
      }
      await page.screenshot({ path: path.join(output, `cookie-r5e-welcome-${width}.png`) });
      if (reduced) await page.keyboard.press('Escape');
      await welcome.waitFor({ state: 'detached' });
      const landing = await launcher.boundingBox();
      assert.deepEqual(landing, initialBounds);
      await page.reload();
      await page.locator('html[data-cookie-startup-ready]').waitFor({ state: 'attached' });
      assert.equal(await welcome.count(), 0, 'El saludo no se repite en la misma sesión');

      await launcher.focus();
      await page.keyboard.press(reduced ? 'Space' : 'Enter');
      const dialog = page.getByRole('dialog', { name: 'Panel de IA', exact: true });
      await dialog.getByRole('textbox', { name: 'Mensaje para la IA' }).waitFor();
      assert.equal(await page.locator('[data-cookie-panel-flight]').count(), reduced ? 0 : 1);
      await page.waitForFunction(() => {
        const panel = document.querySelector('[data-cookie-ai-dialog]');
        if (!panel) return false;
        const { transform, opacity } = getComputedStyle(panel);
        return opacity === '1' && (transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)');
      });
      const panel = await dialog.boundingBox();
      assert.ok(panel.x >= 10 && panel.y >= 10 && width - panel.x - panel.width >= 10);
      assert.ok(viewport.height - panel.y - panel.height >= 10);
      assert.equal(await dialog.evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius)), 24);
      await page.screenshot({ path: path.join(output, `cookie-r5e-panel-${width}.png`) });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await page.locator('[data-cookie-panel-flight]').waitFor({ state: 'detached' });
      assert.equal(await launcher.evaluate(el => el === document.activeElement), true);
      console.log(`PASS Cookie R5e ${width}: bienvenida, posición, panel flotante y teclado`);
    } finally {
      await context.close();
    }
  }
}

module.exports = { verifyCookieMotion };
