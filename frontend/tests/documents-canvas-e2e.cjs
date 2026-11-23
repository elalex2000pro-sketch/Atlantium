const assert = require('node:assert/strict');

async function verifyDocumentsCanvas(browser, { WEB, token, user, viewport, style = 'glass' }) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  try {
    await context.addInitScript(({ token, user, style }) => {
      localStorage.setItem('autopilot_token', token);
      localStorage.setItem('autopilot_user', JSON.stringify(user));
      localStorage.setItem('hasCompletedOnboarding_v1', 'true');
      localStorage.setItem('academic-autopilot-preferences', JSON.stringify({ interfaceStyle: style, wallpaperPreset: 'forest' }));
    }, { token, user, style });
    const page = await context.newPage();
    await page.goto(WEB + '/documents');
    await page.locator(`html[data-interface-style="${style}"]`).waitFor();

    const newButton = page.getByRole('button', { name: 'Nuevo', exact: true });
    const canvasOption = page.getByRole('dialog').getByRole('button', { name: /Pizarra infinita/ });
    const editor = page.getByLabel('Nombre de la pizarra');
    const boards = page.getByRole('button', { name: 'Abrir pizarra', exact: true });
    const chunks = /\/_next\/static\/chunks\/.*\.js(?:\?|$)/;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await newButton.click();
    await page.route(chunks, async route => {
      await held;
      await route.continue();
    });
    try {
      await canvasOption.click();
      await page.getByRole('tab', { name: /Pizarras/, selected: true }).waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await editor.count(), 0, 'Editor must wait for the delayed scripts');
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }

    async function assertBoardCount(count) {
      await editor.waitFor();
      assert.equal(await editor.inputValue(), 'Pizarra sin título');
      await page.getByRole('button', { name: 'Pizarras', exact: true }).click();
      await boards.nth(count - 1).waitFor();
      assert.equal(await boards.count(), count);
    }

    await assertBoardCount(1);
    await newButton.click();
    await canvasOption.click();
    await assertBoardCount(2);
    await page.getByRole('button', { name: 'Nueva pizarra', exact: true }).click();
    await assertBoardCount(3);
  } finally {
    await context.close();
  }
}

module.exports = { verifyDocumentsCanvas };
