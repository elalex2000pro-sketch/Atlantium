const assert = require('node:assert/strict');
const path = require('node:path');

async function verifyCookieMotion(browser, { WEB, token, user, output }) {
  for (const { width, reduced } of [{ width: 1440, reduced: false }, { width: 390, reduced: false }, { width: 390, reduced: true }]) {
    const viewport = { width, height: width === 390 ? 680 : 900 };
    const capture = reduced ? `${width}-reducido` : width;
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
      await page.addInitScript(() => {
        const blink = new MutationObserver(() => {
          if (document.querySelector('[data-cookie-welcome] [data-cookie-blinking="true"]')) {
            document.documentElement.dataset.welcomeBlinkSeen = "true";
            blink.disconnect();
          }
        });
        blink.observe(document, { subtree: true, attributes: true, attributeFilter: ['data-cookie-blinking'] });
      });
      await page.route('**/version.json?*', route => route.fulfill({
        json: width === 1440 ? { version: '990.0.0', enabled: true } : { enabled: false },
      }));
      await page.goto(WEB + '/planner');
      const welcome = page.locator('[data-cookie-welcome]');
      const launcher = page.locator('.cookie-launcher');
      if (width === 1440) {
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
        // El pop arranca con escala cero. Esperar a que el orbe tenga tamaño medible.
        await page.waitForFunction(() =>
          document.querySelector('[data-cookie-welcome="center"] button')?.getBoundingClientRect().width >= 48);
        const bounds = await center.boundingBox();
        assert.ok(bounds && Math.abs(bounds.x + bounds.width / 2 - width / 2) < 2, JSON.stringify(await center.evaluate(el => ({
          box: el.getBoundingClientRect().toJSON(),
          wrapper: el.parentElement.getBoundingClientRect().toJSON(),
          wrapperTransform: getComputedStyle(el.parentElement).transform,
          viewport: [innerWidth, innerHeight],
        }))));
        assert.ok(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2) < 2);
        await page.locator('html[data-welcome-blink-seen]').waitFor({ state: 'attached' });
        assert.equal(await page.locator('main').evaluate(el => {
          const { x, y } = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(x + 24, y + 30));
        }), true);
      } else {
        assert.ok(await launcher.isVisible());
        assert.equal(await welcome.getByRole('button').count(), 0);
      }
      await page.screenshot({ path: path.join(output, `cookie-r5e-welcome-${capture}.png`) });
      if (reduced) await page.keyboard.press('Escape');
      else if (width === 390) await welcome.getByRole('button', { name: 'Saltar saludo de Cookie' }).click();
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
      await page.screenshot({ path: path.join(output, `cookie-r5e-panel-${capture}.png`) });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await page.locator('[data-cookie-panel-flight]').waitFor({ state: 'detached' });
      assert.equal(await launcher.evaluate(el => el === document.activeElement), true);
      console.log(`PASS Cookie R5e ${capture}: bienvenida, posición, panel flotante y teclado`);
    } finally {
      await context.close();
    }
  }
}

module.exports = { verifyCookieMotion };
