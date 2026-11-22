const assert = require('node:assert/strict');

async function verifyInterfaceStyle(browser, { WEB, request }) {
  const { access_token: token } = await request('/auth/register', null, 'POST', {
    email: `appearance-${Date.now()}@example.com`,
    password: 'AppearanceTest123',
    full_name: 'Prueba de apariencia',
  });
  const user = await request('/auth/me', token);
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce' });
  try {
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem('autopilot_token', token);
      localStorage.setItem('autopilot_user', JSON.stringify(user));
    }, { token, user });
    const page = await context.newPage();
    const question = page.getByRole('dialog', { name: '¿Qué estilo prefieres?' });
    const picker = page.getByRole('group', { name: 'Estilo de interfaz' });
    const style = (name) => picker.getByRole('button', { name, exact: true });
    const applied = (value) => page.locator(`html[data-interface-style="${value}"] main`).first().waitFor();
    const appearance = page.getByRole('heading', { name: 'Apariencia' });
    const openSettings = () => page.goto(WEB + '/settings', { waitUntil: 'domcontentloaded' });

    await openSettings();
    await question.waitFor();
    await question.getByText('Te sugerimos Sólido', { exact: false }).waitFor();
    assert.equal(await question.getByRole('button', { name: 'Cristal' }).getAttribute('aria-pressed'), 'true');
    await question.getByRole('button', { name: 'Omitir' }).click();
    await page.getByRole('dialog', { name: 'Planificador' }).waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    const tour = page.getByRole('dialog', { name: 'Planificador' });
    await tour.waitFor();
    assert.equal(await question.count(), 0);
    await tour.getByRole('button', { name: 'Saltar tour', exact: true }).last().click();
    await tour.waitFor({ state: 'hidden' });
    await appearance.waitFor();

    await style('Sólido').click();
    await applied('solid');
    assert.equal(await style('Sólido').getAttribute('aria-pressed'), 'true');
    const sidebar = page.getByRole('complementary', { name: 'Barra lateral' });
    assert.equal(await sidebar.evaluate((element) => getComputedStyle(element).backdropFilter), 'none');
    const studio = sidebar.getByRole('link', { name: 'IA Studio', exact: true });
    await studio.waitFor();
    assert.equal(await studio.getAttribute('href'), '/studio');
    await sidebar.getByRole('button', { name: 'Ocultar nombres de la barra' }).click();
    await sidebar.getByRole('button', { name: 'Mostrar nombres de la barra' }).waitFor();
    assert.equal(await studio.getAttribute('href'), '/studio');

    await style('Fondo').click();
    const wallpaper = page.getByRole('combobox', { name: 'Fondo de pantalla', exact: true });
    await wallpaper.selectOption('forest');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await applied('wallpaper');
    assert.equal(await wallpaper.inputValue(), 'forest');
    assert.equal(await style('Fondo').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('html').evaluate((element) => getComputedStyle(element).backgroundImage), /linear-gradient/);
    assert.equal(await question.count(), 0);

    // La clave de tema de una instalación anterior basta para saltar la pregunta.
    await page.evaluate(() => {
      localStorage.removeItem('hasCompletedOnboarding_v1');
      localStorage.removeItem('academic-autopilot-preferences');
      localStorage.setItem('academic-autopilot-theme-v18', 'dark');
    });
    await openSettings();
    await tour.waitFor();
    assert.equal(await question.count(), 0);
    await applied('glass');

    await page.evaluate(() => localStorage.removeItem('academic-autopilot-theme-v18'));
    await openSettings();
    await question.waitFor();
    await question.getByRole('button', { name: 'Sólido' }).click();
    await question.getByRole('button', { name: 'Continuar' }).click();
    await tour.waitFor();
    await applied('solid');
    await page.keyboard.press('Escape');
    await tour.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 390, height: 844 });
    const navigation = page.locator('[data-mobile-nav]');
    await navigation.waitFor();
    await page.locator('header').getByRole('link', { name: 'IA Studio', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/studio');
    assert.equal(await navigation.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(27, 27, 31)');
    await page.evaluate(() => localStorage.setItem('academic-autopilot-theme-v18', 'dark'));
    await page.goto(WEB, { waitUntil: 'domcontentloaded' });
    const hero = page.locator('[data-dashboard-hero]');
    await hero.getByRole('link', { name: 'Abrir planificador' }).waitFor();
    const dateBadge = hero.locator('[class~="backdrop-blur-xl"]');
    await page.locator('html.dark[data-interface-style="solid"]').waitFor();
    assert.equal(await dateBadge.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(241, 242, 246)');
    assert.match(await hero.getByRole('heading').innerText(), /, Prueba\.$/);
    assert.equal(await hero.getByRole('button', { name: 'Crear con IA' }).count(), 0);
    const contextPanel = page.getByRole('complementary', { name: 'Panel de contexto' });
    await contextPanel.getByText('Próxima tarea').waitFor();
    assert.equal(await contextPanel.getByRole('button', { name: 'Mes anterior' }).count(), 0);
    await contextPanel.getByRole('button', { name: '5', exact: true }).click();
    await contextPanel.getByText('5:00', { exact: true }).waitFor();
    await navigation.waitFor();
  } finally {
    await context.close();
  }
}

module.exports = { verifyInterfaceStyle };
