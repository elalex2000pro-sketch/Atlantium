const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/gamification.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function load(values = new Map()) {
  const exports = {};
  const events = [];
  const window = {
    localStorage: { getItem: id => values.get(id) ?? null, setItem: (id, value) => values.set(id, value) },
    dispatchEvent: event => events.push(event),
  };
  class CustomEvent {
    constructor(type, { detail } = {}) {
      Object.assign(this, { type, detail });
    }
  }
  vm.runInNewContext(code, { exports, window, CustomEvent });
  return { xp: exports, events };
}

test('Cookie usa la curva existente y respeta todos los umbrales', () => {
  const { xp } = load();
  assert.equal(xp.getLevelInfo(0).level, 1);
  assert.equal(xp.xpForLevel(2), 100);
  assert.equal(xp.xpForLevel(10), 4500);
  const expected = [['glasses', 2], ['headphones', 4], ['graduation-cap', 6], ['scarf', 8], ['crown', 10]];
  assert.deepEqual(Array.from(xp.COOKIE_REWARDS, reward => [reward.id, reward.level]), expected);
  for (const [index, [, level]] of expected.entries()) {
    const threshold = xp.xpForLevel(level);
    assert.equal(xp.getCookieRewards(xp.getLevelInfo(threshold - 1).level).filter(r => r.unlocked).length, index);
    assert.equal(xp.getCookieRewards(xp.getLevelInfo(threshold).level).filter(r => r.unlocked).length, index + 1);
  }
});

test('El XP previo se conserva y cada subida se anuncia una vez por usuario', () => {
  const values = new Map([['autopilot:gamification:ana', JSON.stringify({
    xp: 90, awardedTasks: ['previa'], equippedBadge: null, equippedTheme: 'theme-aurora',
  })]]);
  const { xp, events } = load(values);
  assert.equal(xp.claimCookieLevelNotice('ana', 1, 1), null);
  xp.awardTaskXp('ana', 'nueva');
  const event = events.find(item => item.type === xp.XP_EVENT).detail;
  assert.equal(xp.getGamification('ana').xp, 105);
  assert.equal(xp.getGamification('ana').equippedTheme, 'theme-aurora');
  assert.equal(xp.getLevelInfo(event.xp).progress, 0.025);
  const claim = () => xp.claimCookieLevelNotice(event.userId, event.previousLevel, event.level);
  assert.deepEqual(Array.from(claim(), reward => reward.id), ['glasses']);
  assert.equal(claim(), null);
  const reloaded = load(values).xp;
  assert.equal(reloaded.getCookieRewards(reloaded.getLevelInfo(reloaded.getGamification('ana').xp).level)[0].unlocked, true);
  assert.equal(reloaded.claimCookieLevelNotice('ana', 1, 2), null);
  assert.deepEqual(Array.from(reloaded.claimCookieLevelNotice('leo', 1, 2), reward => reward.id), ['glasses']);
  assert.deepEqual(Array.from(reloaded.claimCookieLevelNotice('ana', 2, 6), reward => reward.id), ['headphones', 'graduation-cap']);
});

test('El equipo combina huecos, reemplaza gorro por corona y permite quitar', () => {
  const profile = JSON.stringify({ xp: 4500, equippedTheme: 'theme-aurora', awardedTasks: ['previa'] });
  const values = new Map([['autopilot:gamification:ana', profile]]);
  const { xp, events } = load(values);
  for (const { id } of xp.COOKIE_REWARDS) assert.equal(xp.setCookieRewardEquipped('ana', id, true), true);
  const ready = ['glasses', 'headphones', 'scarf', 'crown'];
  assert.deepEqual(Array.from(xp.getEquippedCookieRewards('ana')), ready);
  assert.deepEqual(Array.from(load(values).xp.getEquippedCookieRewards('ana')), ready);
  assert.deepEqual(Array.from(xp.getEquippedCookieRewards('leo')), []);
  assert.equal(xp.setCookieRewardEquipped('ana', 'graduation-cap', false), true);
  assert.deepEqual(Array.from(xp.getEquippedCookieRewards('ana')), ready);
  assert.equal(xp.setCookieRewardEquipped('ana', 'crown', false), true);
  assert.deepEqual(Array.from(xp.getEquippedCookieRewards('ana')), ready.slice(0, 3));
  assert.equal(values.get('autopilot:gamification:ana'), profile);
  assert.equal(events.at(-1).type, xp.COOKIE_OUTFIT_EVENT);
});

test('El equipo ignora accesorios bloqueados, desconocidos y en el hueco equivocado', () => {
  const values = new Map([
    ['autopilot:gamification:ana', JSON.stringify({ xp: 100 })],
    ['autopilot:cookie-outfit:ana', JSON.stringify({ eyes: 'glasses', head: 'crown', ears: 'glasses', neck: 'desconocido' })],
  ]);
  const { xp, events } = load(values);
  assert.deepEqual(Array.from(xp.getEquippedCookieRewards('ana')), ['glasses']);
  assert.equal(xp.setCookieRewardEquipped('ana', 'headphones', true), false);
  assert.equal(xp.setCookieRewardEquipped('ana', 'desconocido', true), false);
  assert.equal(events.length, 0);
  values.set('autopilot:cookie-outfit:ana', '{');
  assert.deepEqual(Array.from(xp.getEquippedCookieRewards('ana')), []);
});
