const assert = require('node:assert/strict');

async function verifySharedFocusTimer(browser, { WEB, request }) {
  const { access_token: token } = await request('/auth/register', null, 'POST', {
    email: `shared-focus-${crypto.randomUUID()}@example.com`,
    password: 'SharedFocusTest123',
    full_name: 'Usuario de enfoque',
  });
  const user = await request('/auth/me', token);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 }, serviceWorkers: 'block' });
  const notices = [];
  try {
    await context.exposeBinding('recordFocusNotice', (_source, notice) => {
      notices.push(notice);
      return { ok: true };
    });
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem('autopilot_token', token);
      localStorage.setItem('autopilot_user', JSON.stringify(user));
      localStorage.setItem('hasCompletedOnboarding_v1', 'true');
      window.autopilotDesktop = { notify: notice => window.recordFocusNotice(notice) };
    }, { token, user });
    const page = await context.newPage();
    let posts = 0;
    page.on('request', req => {
      if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/v1/focus/sessions') posts++;
    });
    await page.clock.install();
    const panel = page.getByRole('complementary', { name: 'Panel de contexto' });
    const main = page.getByRole('main');
    const button = (view, name) => view.getByRole('button', { name, exact: true });
    const clock = view => view.getByText(/^\d{1,2}:\d{2}$/, { exact: true });
    const key = 'autopilot:focus:timer:v1:' + user.id;
    const snapshot = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);

    await page.goto(WEB + '/settings', { waitUntil: 'domcontentloaded' });
    await button(panel, 'Empezar').click();
    await button(panel, 'Pausar').waitFor();
    const first = await snapshot();
    await page.clock.runFor(2500);
    assert.notEqual(await clock(panel).innerText(), '25:00');

    await page.locator('a[href="/focus"]:visible').first().click();
    await page.waitForURL('**/focus');
    await button(main, 'Pausar').click();
    await button(panel, 'Continuar').waitFor();
    assert.equal((await snapshot()).id, first.id);
    assert.equal(await clock(panel).innerText(), await clock(main).innerText());
    await button(panel, 'Reiniciar temporizador').click();
    await button(main, 'Empezar').waitFor();
    await button(panel, '5').click();
    await main.getByText('05:00', { exact: true }).waitFor();
    await button(panel, '25').click();
    await main.getByText('25:00', { exact: true }).waitFor();

    await button(main, 'Empezar').click();
    await button(panel, 'Pausar').waitFor();
    const active = await snapshot();
    assert.notEqual(active.id, first.id);
    await page.clock.runFor(2500);
    await button(panel, 'Pausar').click();
    await button(main, 'Continuar').waitFor();
    assert.equal(await clock(panel).innerText(), await clock(main).innerText());
    await button(main, 'Continuar').click();
    await button(panel, 'Pausar').waitFor();
    await page.clock.setSystemTime((await snapshot()).endsAt + 1000);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await panel.getByText('1 sesión completada', { exact: true }).waitFor();
    assert.equal(posts, 1);
    assert.equal((await request('/focus/sessions', token)).length, 1);
    assert.equal(await page.evaluate(id => JSON.parse(localStorage.getItem('autopilot:gamification:' + id)).xp, user.id), 25);
    assert.equal(notices.filter(notice => notice.title === 'Sesión completada').length, 1);
  } finally {
    await context.close();
  }
}

module.exports = { verifySharedFocusTimer };
