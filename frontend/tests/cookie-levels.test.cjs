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
