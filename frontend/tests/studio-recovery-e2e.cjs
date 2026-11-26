/* E2E de recuperación en IA Studio (ATL-108 bloque 2).
 * Se ejecuta contra servidores aislados (chat_test_server + Next.js dev/start).
 */
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');

const API = process.env.SMOKE_API || 'http://127.0.0.1:8000';
const WEB = process.env.SMOKE_WEB || 'http://localhost:3000';
const FRONTEND = path.resolve(__dirname, '..');
const ROOT = path.resolve(FRONTEND, '..');
const servers = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, label, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(200);
  }
  throw new Error('Timeout: ' + label);
}

async function freePort(url) {
  const port = Number(new URL(url).port || 80);
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`Port ${port} occupied`)));
    probe.listen(port, () => probe.close(resolve));
  });
}

function start(command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entry = { child, log: '' };
  servers.push(entry);
  const collect = (d) => { entry.log = (entry.log + d).slice(-12000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return entry;
}

async function request(route, token, method = 'GET', data) {
  const res = await fetch(API + '/api/v1' + route, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      'Content-Type': 'application/json',
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  assert.ok(res.ok, `${route}: ${res.status} ${res.ok ? '' : await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'atlantium-studio-recovery-'));
  await freePort(API);
  await freePort(WEB);

  const python =
    process.env.SMOKE_PYTHON ||
    'C:\\Users\\elale\\Downloads\\academic_autopilot\\atl-076-ai-contrast\\.venv\\Scripts\\python.exe';
  const apiServer = start(
    python,
    ['-m', 'uvicorn', 'chat_test_server:app', '--app-dir', 'tests', '--host', '0.0.0.0', '--port', new URL(API).port],
    path.join(ROOT, 'backend'),
    { AUTOPILOT_TEST_DIR: path.join(output, 'database'), AI_ENABLED: 'false', DEBUG: 'false' },
  );
  await until(async () => {
    if (apiServer.child.exitCode !== null) throw new Error(apiServer.log);
    try { return (await fetch(API + '/health')).ok; } catch { return false; }
  }, 'API startup');

  start(
    process.execPath,
    [require.resolve('next/dist/bin/next'), 'dev', '-p', new URL(WEB).port],
    FRONTEND,
    { NEXT_PUBLIC_API_URL: API, NEXT_TELEMETRY_DISABLED: '1' },
  );
  await until(async () => {
    try { return (await fetch(WEB + '/login')).ok; } catch { return false; }
  }, 'web startup', 180000);

  const channel = process.env.SMOKE_BROWSER_CHANNEL || 'chrome';
  const browser = await chromium.launch({
    headless: true,
    ...(channel === 'chromium' ? {} : { channel }),
  });

  try {
    const aliceReg = await request('/auth/register', null, 'POST', {
      email: `alice-${Date.now()}@example.com`,
      password: 'RecoveryUser123',
      full_name: 'Alice Recovery',
    });
    const aliceToken = aliceReg.access_token;
    const alice = await request('/auth/me', aliceToken);

    const bobReg = await request('/auth/register', null, 'POST', {
      email: `bob-${Date.now()}@example.com`,
      password: 'RecoveryUser123',
      full_name: 'Bob Recovery',
    });
    const bobToken = bobReg.access_token;
    const bob = await request('/auth/me', bobToken);

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    await page.addInitScript(({ token, user }) => {
      if (!window.localStorage.getItem('autopilot_token')) {
        window.localStorage.setItem('autopilot_token', token);
        window.localStorage.setItem('autopilot_user', JSON.stringify(user));
        window.localStorage.setItem('hasCompletedOnboarding_v1', 'true');
      }
    }, { token: aliceToken, user: alice });

    // 1. Simular respuesta perdida tras el commit en POST /assistant/chat.
    let chatPostCount = 0;
    let operationGetCount = 0;
    let dropNextChatResponse = true;

    await page.route('**/api/v1/assistant/chat', async (route) => {
      chatPostCount += 1;
      if (dropNextChatResponse) {
        dropNextChatResponse = false;
        await route.fetch();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await page.route('**/api/v1/assistant/operations/*', async (route) => {
      operationGetCount += 1;
      await route.continue();
    });

    await page.goto(WEB + '/studio');
    const input = page.getByPlaceholder('Pregunta lo que necesites…');
    await input.waitFor({ state: 'visible', timeout: 30000 });
    await input.fill('Crea la tarea Repasar tema 1');
    await input.press('Enter');

    await page.getByText('Reintentar el mismo envío').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(chatPostCount, 1);

    // Verificar que localStorage solo guarda identificadores y metadatos mínimos aislados por usuario.
    const storedRaw = await page.evaluate((uid) => {
      return window.localStorage.getItem(`atlantium_studio_pending_op:${uid}`);
    }, alice.id);
    assert.ok(storedRaw, 'Debe persistir el identificador de operación pendiente');
    const stored = JSON.parse(storedRaw);
    assert.equal(stored.kind, 'chat');
    assert.equal(stored.mode, 'chat');
    assert.ok(stored.requestId);
    assert.equal('token' in stored, false);
    assert.equal('message' in stored, false);
    assert.equal('attachments' in stored, false);
    assert.equal('api_key' in stored, false);

    // 2. Recargar Studio: debe recuperar la respuesta vía GET sin reejecutar POST /chat.
    await page.reload();
    await page.getByText('Se ha recuperado el resultado del último envío.').waitFor({ state: 'visible', timeout: 20000 });
    assert.equal(chatPostCount, 1, 'No debe reejecutar POST /assistant/chat tras recargar');
    assert.ok(operationGetCount >= 1, 'Debe consultar el estado autenticado de solo lectura');

    // Verificar que la clave persistida se limpió tras completar la recuperación.
    const clearedAfterRecover = await page.evaluate((uid) => {
      return window.localStorage.getItem(`atlantium_studio_pending_op:${uid}`);
    }, alice.id);
    assert.equal(clearedAfterRecover, null);

    // 3. Cambio de vista (desmontar Studio y volver a entrar) recuperando una operación pendiente.
    dropNextChatResponse = true;
    await input.fill('Crea la tarea Repasar tema 2');
    await input.press('Enter');
    await page.getByText('Reintentar el mismo envío').waitFor({ state: 'visible', timeout: 15000 });
    const countBeforeNav = chatPostCount;

    await page.goto(WEB + '/');
    await page.waitForTimeout(500);
    await page.goto(WEB + '/studio');
    await page.getByText('Se ha recuperado el resultado del último envío.').waitFor({ state: 'visible', timeout: 20000 });
    assert.equal(chatPostCount, countBeforeNav, 'No debe reejecutar POST /chat al volver a Studio');

    // 4. Diferenciar nuevo envío intencionado tras un error reintentable (simulado 500 sin llegar al backend).
    await page.unroute('**/api/v1/assistant/chat');
    let failFirstWith500 = true;
    const seenRequestIds = [];
    await page.route('**/api/v1/assistant/chat', async (route) => {
      const body = route.request().postDataJSON();
      seenRequestIds.push(body.request_id);
      if (failFirstWith500) {
        failFirstWith500 = false;
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Error temporal' }) });
        return;
      }
      await route.continue();
    });

    await input.fill('Primer intento fallido');
    await input.press('Enter');
    await page.getByText('Reintentar el mismo envío').waitFor({ state: 'visible', timeout: 15000 });

    await input.fill('Nuevo envío intencionado');
    await input.press('Enter');
    await page.waitForTimeout(1000);
    assert.equal(seenRequestIds.length, 2);
    assert.notEqual(seenRequestIds[0], seenRequestIds[1], 'Un nuevo envío intencionado debe usar un request_id distinto');

    // 5. Recuperación de confirmación pendiente y respuesta perdida tras confirmar.
    const proposalId = '22222222-2222-4222-8222-222222222222';
    let proposalStage = 'pending';
    let confirmPostCount = 0;
    await page.unroute('**/api/v1/assistant/chat');
    await page.unroute('**/api/v1/assistant/operations/*');
    await page.route(`**/api/v1/assistant/proposals/${proposalId}*`, async (route) => {
      if (proposalStage === 'pending') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'pending',
            pending_action: { proposal_id: proposalId, tool: 'delete_task', args: { elemento: 'Tarea prueba' } },
            decision: null,
            response: null,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'decided',
          pending_action: null,
          decision: true,
          response: {
            reply: 'Listo. He eliminado: Tarea prueba.',
            source: 'ai',
            created_at: new Date().toISOString(),
            document_id: null,
            pending_action: null,
          },
        }),
      });
    });
    await page.route('**/api/v1/assistant/confirm', async (route) => {
      confirmPostCount += 1;
      proposalStage = 'decided';
      await route.abort('failed');
    });

    await page.evaluate(({ aliceId, pid }) => {
      window.localStorage.setItem(
        `atlantium_studio_pending_op:${aliceId}`,
        JSON.stringify({
          kind: 'confirm',
          proposalId: pid,
          approve: null,
          mode: 'chat',
          documentId: null,
          tool: 'delete_task',
          elementLabel: 'Tarea prueba',
          startedAt: Date.now(),
        }),
      );
    }, { aliceId: alice.id, pid: proposalId });

    await page.reload();
    await page.getByText('Confirmar acción').waitFor({ state: 'visible', timeout: 20000 });
    await page.getByRole('button', { name: 'Sí, adelante' }).click();
    await page.waitForTimeout(500);
    assert.equal(confirmPostCount, 1);

    // Recargar tras perder la respuesta de confirmación: recupera la decisión sin reejecutar POST /confirm.
    await page.reload();
    await page.getByText('Se ha recuperado el resultado de tu confirmación.').waitFor({ state: 'visible', timeout: 20000 });
    assert.equal(confirmPostCount, 1, 'No debe reejecutar POST /assistant/confirm tras recargar');

    // 6. Aislamiento entre cuentas: dejar una operación pendiente de Alice y entrar como Bob.
    const fakeAliceOp = {
      kind: 'chat',
      requestId: '11111111-1111-4111-8111-111111111111',
      mode: 'chat',
      documentId: null,
      startedAt: Date.now(),
    };
    let bobQueriedAliceOp = false;
    await page.route('**/api/v1/assistant/operations/*', async (route) => {
      if (route.request().url().includes(fakeAliceOp.requestId)) {
        bobQueriedAliceOp = true;
      }
      await route.continue();
    });

    await page.evaluate(({ aliceId, op, token, user }) => {
      window.localStorage.setItem(`atlantium_studio_pending_op:${aliceId}`, JSON.stringify(op));
      window.localStorage.setItem('autopilot_token', token);
      window.localStorage.setItem('autopilot_user', JSON.stringify(user));
    }, { aliceId: alice.id, op: fakeAliceOp, token: bobToken, user: bob });

    await page.goto(WEB + '/studio');
    await page.getByPlaceholder('Pregunta lo que necesites…').waitFor({ state: 'visible', timeout: 20000 });
    assert.equal(bobQueriedAliceOp, false, 'Bob no debe consultar ni ver operaciones pendientes de Alice');

    const aliceStillIntact = await page.evaluate((aliceId) => {
      return window.localStorage.getItem(`atlantium_studio_pending_op:${aliceId}`);
    }, alice.id);
    assert.ok(aliceStillIntact, 'La operación pendiente de Alice sigue aislada en su clave');

    console.log('PASS studio-recovery-e2e: reload, unmount, lost response, new send, account isolation');
  } finally {
    await browser.close();
    for (const s of servers) {
      try { s.child.kill(); } catch {}
    }
    await fs.rm(output, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
