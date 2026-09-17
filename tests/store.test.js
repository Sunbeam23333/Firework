import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, loadState, saveState, applyCare, updateProfiles, getSummary, exportState, mergeImport } from '../store.js';

const date = (day, hour = 12) => new Date(2026, 8, day, hour, 0, 0);
const care = (state, actorId, now = date(18), kind = 'pet', text = '') => applyCare(state, { kind, actorId, text }, now);
const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
};

test('a shared day is counted once, and the next local calendar day starts separately', () => {
  const original = createState(date(18));
  const first = care(original, 'a', date(18, 23));
  assert.equal(first.newTogetherDay, false);
  assert.deepEqual(original.events, []);
  assert.deepEqual(original.careDays, {});
  const repeated = care(first.state, 'a', date(18, 23));
  assert.equal(repeated.newTogetherDay, false);
  const together = care(repeated.state, 'b', date(18, 23));
  assert.equal(together.newTogetherDay, true);
  const again = care(together.state, 'b', date(18, 23));
  assert.equal(again.newTogetherDay, false);
  assert.deepEqual(getSummary(again.state, date(19, 0)), {
    ageDays: 2, togetherDays: 1, notesCount: 0, today: { a: false, b: false },
  });
  const tomorrow = care(care(again.state, 'b', date(19, 0)).state, 'a', date(19, 0));
  assert.equal(tomorrow.newTogetherDay, true);
  assert.equal(getSummary(tomorrow.state, date(19)).togetherDays, 2);
  assert.equal(tomorrow.event.day, '2026-09-19');
});

test('persistent storage restores names and memories without mutating input', () => {
  const storage = memoryStorage();
  const first = createState(date(18));
  const named = updateProfiles(first, { petName: '糖糖', a: '小月', b: '小星' });
  assert.equal(first.profiles.petName, '小满');
  const state = care(named, 'a', date(18), 'note', '今天有一朵特别像你的云 ☁️').state;
  assert.equal(saveState(state, storage), true);
  assert.deepEqual(loadState(storage), { state, available: true });
  assert.equal(getSummary(state, date(18)).notesCount, 1);
  assert.equal(loadState(memoryStorage()).available, true);
});

test('broken or blocked storage never crashes and corrupted data is not overwritten', () => {
  const storage = memoryStorage();
  storage.setItem('firework.ant.v1', '{broken');
  const loaded = loadState(storage);
  assert.equal(loaded.available, true);
  assert.equal(typeof loaded.error, 'string');
  assert.equal(loaded.recoveryKey, 'firework.ant.recovery');
  assert.equal(storage.getItem(loaded.recoveryKey), '{broken');
  assert.equal(storage.getItem('firework.ant.v1'), '{broken');
  assert.equal(loadState(storage).recoveryKey, loaded.recoveryKey);
  assert.equal(storage.length, 2);
  assert.equal(saveState(createState(date(18)), storage), true);
  assert.equal(storage.getItem(loaded.recoveryKey), '{broken');
  assert.equal(storage.length, 2);
  assert.equal(loadState(storage).recoveryKey, loaded.recoveryKey);
  assert.equal(loadState(storage).error, undefined);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(loadState(blocked).available, false);
  assert.equal(saveState(createState(), blocked), false);
  assert.equal(loadState(null).available, false);
});

test('new corruption never overwrites an older recovery copy and identical copies are reused', () => {
  const storage = memoryStorage();
  storage.setItem('firework.ant.recovery', 'older original');
  storage.setItem('firework.ant.v1', 'new broken original');
  const loaded = loadState(storage);
  assert.match(loaded.recoveryKey, /^firework\.ant\.recovery\.\d+\.\d+$/);
  assert.equal(storage.getItem('firework.ant.recovery'), 'older original');
  assert.equal(storage.getItem(loaded.recoveryKey), 'new broken original');
  // A different wrapper emulates reloading the module without its per-storage cache.
  const reloadedStorage = {
    getItem: key => storage.getItem(key), setItem: (key, value) => storage.setItem(key, value),
    key: index => storage.key(index), get length() { return storage.length; },
  };
  assert.equal(loadState(reloadedStorage).recoveryKey, loaded.recoveryKey);
  assert.equal(saveState(createState(date(18)), reloadedStorage), true);
  assert.equal(storage.length, 3);
  assert.equal(storage.getItem('firework.ant.recovery'), 'older original');
  assert.equal(storage.getItem(loaded.recoveryKey), 'new broken original');
  assert.equal(loadState(reloadedStorage).recoveryKey, 'firework.ant.recovery');
});

test('a failed recovery backup prevents replacing the original even when normal writes would succeed', () => {
  const source = memoryStorage();
  source.setItem('firework.ant.v1', 'precious broken original');
  const storage = {
    getItem: key => source.getItem(key),
    setItem(key, value) {
      if (key.startsWith('firework.ant.recovery')) throw new Error('quota');
      source.setItem(key, value);
    },
  };
  const loaded = loadState(storage);
  assert.equal(loaded.available, false);
  assert.equal(loaded.recoveryRequired, true);
  assert.equal(saveState(care(loaded.state, 'a').state, storage), false);
  assert.equal(source.getItem('firework.ant.v1'), 'precious broken original');
  const direct = memoryStorage();
  direct.setItem('firework.ant.v1', 'direct save broken original');
  assert.equal(saveState(createState(date(18)), direct), true);
  assert.equal(direct.getItem('firework.ant.recovery'), 'direct save broken original');
});

test('imports merge distinct memories and days, deduplicate IDs, and restore profiles', () => {
  const first = care(createState(date(18)), 'a').state;
  const remote = updateProfiles(care(first, 'b', date(18), 'note', '你也来啦').state, { petName: '圆圆' });
  const local = care(first, 'a', date(19), 'note', '明天见').state;
  const merged = mergeImport(local, exportState(remote));
  assert.equal(merged.events.length, 3);
  assert.equal(merged.profiles.petName, '圆圆');
  assert.equal(getSummary(merged, date(19)).togetherDays, 1);
  assert.equal(getSummary(merged, date(19)).notesCount, 2);
  assert.deepEqual(mergeImport(merged, exportState(remote)), merged);
  assert.equal(local.events.length, 2);
  assert.equal(local.profiles.petName, '小满');
});

test('malformed, oversized, prototype-polluting, and unknown-member imports are rejected', () => {
  const state = care(createState(date(18)), 'a').state;
  const variants = [
    { ...state, version: 2 },
    { ...state, createdAt: '2026-02-30T12:00:00.000Z' },
    { ...state, createdAt: '1800-01-01T00:00:00.000Z' },
    { ...state, events: [{ ...state.events[0], actorId: 'stranger' }] },
    { ...state, events: [{ ...state.events[0], createdAt: '<script>alert(1)</script>' }] },
    { ...state, events: [{ ...state.events[0], day: '2026-02-30' }] },
    { ...state, events: [{ ...state.events[0], day: '2026-08-18' }] },
    { ...state, careDays: { '2026-09-18': { a: true, b: false, stranger: true } } },
    { ...state, profiles: { ...state.profiles, caregivers: [{ id: 'a', name: 'a' }, { id: 'a', name: 'a' }] } },
  ];
  for (const value of variants) assert.throws(() => mergeImport(state, JSON.stringify(value)));
  assert.throws(() => mergeImport(state, '{"__proto__":{"polluted":true}}'));
  assert.throws(() => mergeImport(state, JSON.stringify(state).replace('"version":1', '"constructor":{},"version":1')));
  assert.throws(() => mergeImport(state, ' '.repeat(16 * 1024 * 1024 + 1)), /16 MB/);
  assert.throws(() => mergeImport(state, '蚂'.repeat(6 * 1024 * 1024)), /16 MB/);
  assert.equal({}.polluted, undefined);
  assert.equal(state.events.length, 1);
});

test('Unicode limits keep surrogate pairs intact; empty notes and invalid dates are rejected', () => {
  const first = createState(date(18));
  const state = updateProfiles(first, { petName: '🐜'.repeat(20), a: '中文名字'.repeat(8) });
  assert.equal(Array.from(state.profiles.petName).length, 16);
  assert.equal(state.profiles.petName, '🐜'.repeat(16));
  assert.equal(Array.from(state.profiles.caregivers[0].name).length, 16);
  const result = care(state, 'a', date(18), 'note', '🐜'.repeat(200));
  assert.equal(result.event.text, '🐜'.repeat(160));
  assert.throws(() => care(state, 'a', date(18), 'note', '  \n '));
  assert.throws(() => care(state, 'c'));
  assert.throws(() => care(state, 'a', new Date('invalid')));
  assert.throws(() => updateProfiles(state, { b: '   ' }));
  const markup = care(state, 'a', date(18), 'note', '<img src=x onerror=alert(1)>').state;
  assert.equal(mergeImport(state, exportState(markup)).events[0].text, '<img src=x onerror=alert(1)>');
});

test('old notes and shared days survive more than 1,000 later care events and export/import', () => {
  let state = care(care(createState(date(17)), 'a', date(17), 'note', '最初的纸条，永远别删').state, 'b', date(17)).state;
  const firstNote = state.events[0];
  const ids = new Set();
  for (let i = 0; i < 1005; i++) {
    const result = care(state, 'a', date(18));
    state = result.state;
    ids.add(result.event.id);
  }
  assert.equal(ids.size, 1005);
  assert.equal(state.events.length, 1007);
  assert.deepEqual(state.events[0], firstNote);
  assert.equal(getSummary(state, date(18)).togetherDays, 1);
  const restored = mergeImport(createState(date(18)), exportState(state));
  assert.equal(restored.events.length, 1007);
  assert.deepEqual(restored.events.find(event => event.id === firstNote.id), firstNote);
  assert.equal(getSummary(restored, date(18)).togetherDays, 1);
});

test('capacity rejects new actions and imports without silently dropping existing memories', () => {
  const seed = care(createState(date(18)), 'a', date(18), 'note', '每一条都要保留').state;
  const full = { ...seed, events: Array.from({ length: 10000 }, (_, index) => ({ ...seed.events[0], id: `event-${index}` })) };
  const before = JSON.stringify(full);
  assert.throws(() => care(full, 'b'), /10,000/);
  assert.equal(JSON.stringify(full), before);
  const other = care(createState(date(18)), 'b').state;
  assert.throws(() => mergeImport(full, exportState(other)), /10,000/);
  assert.equal(JSON.stringify(full), before);
  const backup = exportState(full);
  assert.ok(new TextEncoder().encode(backup).byteLength > 1024 * 1024);
  const restored = mergeImport(createState(date(18)), backup);
  assert.equal(restored.events.length, 10000);
  assert.equal(mergeImport(restored, backup).events.length, 10000);
  const tooMany = { ...full, events: [...full.events, { ...seed.events[0], id: 'overflow' }] };
  assert.throws(() => mergeImport(seed, JSON.stringify(tooMany)), /10,000/);
  const storage = memoryStorage();
  assert.equal(saveState(full, storage), true);
  assert.equal(loadState(storage).state.events.length, 10000);
});
