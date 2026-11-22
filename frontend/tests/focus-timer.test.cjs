const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../src/lib/focus-timer.ts"), "utf8");
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exportsObject });

const { claimExpired, readTimer, readyTimer, remainingMs, timerKey, toggleTimer } = exportsObject;
const newId = () => "test-session";
const start = 100_000;

test("start, pause and resume preserve exact remaining time and session ID", () => {
  const running = toggleTimer(readyTimer(), start, newId);
  assert.equal(running.endsAt, start + 1_500_000);
  assert.equal(remainingMs(running, start + 37_432), 1_462_568);
  const paused = toggleTimer(running, start + 37_432, newId);
  assert.equal(paused.status, "paused");
  assert.equal(remainingMs(paused, start + 900_000), 1_462_568);
  const resumed = toggleTimer(paused, start + 900_000, () => assert.fail("new session"));
  assert.equal(resumed.id, running.id);
  assert.equal(resumed.endsAt, start + 2_362_568);
});

test("completion is claimed only after the deadline and cannot be reclaimed", () => {
  const running = toggleTimer(readyTimer("break"), start, newId);
  assert.equal(running.endsAt, start + 300_000);
  assert.equal(claimExpired(running, running.endsAt - 1), running);
  assert.equal(remainingMs(running, running.endsAt + 86_400_000), 0);
  const claimed = claimExpired(running, running.endsAt);
  assert.equal(claimed.status, "sending");
  assert.equal(claimed.id, running.id);
  assert.equal(claimExpired(claimed, running.endsAt + 1_000), claimed);
});

test("reload restores a running or paused account, and catches up after closing", () => {
  const running = toggleTimer(readyTimer(), start, newId);
  const paused = toggleTimer(running, start + 120_000, newId);
  const storage = new Map([
    [timerKey("alice"), JSON.stringify(running)],
    [timerKey("bob"), JSON.stringify(paused)],
  ]);
  const localStorage = { getItem: key => storage.get(key) ?? null };
  const restored = readTimer(localStorage, "alice");
  assert.equal(remainingMs(restored, start + 600_000), 900_000);
  assert.equal(claimExpired(restored, running.endsAt + 60_000).status, "sending");
  assert.equal(remainingMs(readTimer(localStorage, "bob"), running.endsAt), 1_380_000);
  const other = readTimer(localStorage, "carol");
  assert.equal(other.status, "ready");
  assert.equal(other.id, null);
});

test("invalid snapshots are ignored and unconfirmed saves are never claimed again", () => {
  const invalid = readTimer({ getItem: () => "{bad json" }, "alice");
  assert.equal(invalid.status, "ready");
  const running = toggleTimer(readyTimer(), start, newId);
  const sending = claimExpired(running, running.endsAt);
  const stored = readTimer({getItem: () => JSON.stringify({...sending, status: "unconfirmed"})}, "alice");
  assert.equal(claimExpired(stored, running.endsAt + 1_000), stored);
});
