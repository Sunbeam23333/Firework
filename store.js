const STORAGE_KEY = 'firework.ant.v1';
const RECOVERY_KEY = 'firework.ant.recovery';
const MAX_EVENTS = 10000;
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
const ACTORS = new Set(['a', 'b']);
const KINDS = new Set(['feed', 'pet', 'rest', 'note']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MIN_TIME = Date.UTC(2000, 0, 1);
const MAX_TIME = Date.UTC(2101, 0, 1);
let fallbackSequence = 0;
let recoverySequence = 0;
const recoveryCache = new WeakMap();

function capacityError() {
  return new Error('小窝已达到 10,000 条记忆的容量上限，旧记忆没有删除。请先导出备份。');
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validDate(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getTime() < MIN_TIME || now.getTime() >= MAX_TIME) {
    throw new Error('时间格式不正确。');
  }
  return now;
}

function dayKey(now) {
  validDate(now);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function validDay(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$|^2100-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= MIN_TIME && time < MAX_TIME && new Date(time).toISOString() === value;
}

// Text stays plain text. Render it with textContent, never innerHTML.
function plainText(value, limit) {
  if (typeof value !== 'string') throw new Error('文字格式不正确。');
  return Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()).slice(0, limit).join('');
}

function nameText(value) {
  const name = plainText(value, 16).replace(/\s+/g, ' ');
  if (!name) throw new Error('名字不能为空。');
  return name;
}

function normalProfiles(profiles) {
  if (!record(profiles) || !Array.isArray(profiles.caregivers) || profiles.caregivers.length !== 2) {
    throw new Error('家庭成员资料不完整。');
  }
  const caregivers = ['a', 'b'].map(id => {
    const entries = profiles.caregivers.filter(person => record(person) && person.id === id);
    if (entries.length !== 1) throw new Error('家庭成员资料不正确。');
    return { id, name: nameText(entries[0].name) };
  });
  return { petName: nameText(profiles.petName), caregivers };
}

function normalEvent(event) {
  if (!record(event) || typeof event.id !== 'string' || !/^[\w-]{1,100}$/.test(event.id)
      || !KINDS.has(event.kind) || !ACTORS.has(event.actorId)
      || !validTimestamp(event.createdAt) || !validDay(event.day)) {
    throw new Error('有一条记忆的格式不正确。');
  }
  // A saved day may differ from this device's timezone, but never by more than one day.
  const dayDistance = Math.abs(Date.parse(`${event.day}T12:00:00.000Z`) - Date.parse(event.createdAt));
  if (dayDistance > 36 * 60 * 60 * 1000) throw new Error('记忆日期与时间不一致。');
  const text = plainText(event.text, 160);
  if (event.kind === 'note' && !text) throw new Error('记忆内容不能为空。');
  return { id: event.id, kind: event.kind, actorId: event.actorId, text, createdAt: event.createdAt, day: event.day };
}

function sortEvents(events) {
  return events.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function normalizeState(value) {
  if (!record(value) || value.version !== 1 || !validTimestamp(value.createdAt)
      || !Array.isArray(value.events) || !record(value.careDays)) {
    throw new Error('这不是可识别的小蚂蚁记忆文件。');
  }
  if (value.events.length > MAX_EVENTS) throw capacityError();
  const profiles = normalProfiles(value.profiles);
  const careDays = {};
  for (const [day, care] of Object.entries(value.careDays)) {
    if (!validDay(day) || !record(care) || typeof care.a !== 'boolean' || typeof care.b !== 'boolean'
        || Object.keys(care).some(key => !ACTORS.has(key))) {
      throw new Error('陪伴日期的格式不正确。');
    }
    careDays[day] = { a: care.a, b: care.b };
  }
  const byId = new Map();
  for (const entry of value.events) {
    const event = normalEvent(entry);
    if (!byId.has(event.id)) byId.set(event.id, event);
  }
  const allEvents = sortEvents([...byId.values()]);
  for (const event of allEvents) {
    careDays[event.day] = { a: false, b: false, ...careDays[event.day], [event.actorId]: true };
  }
  return { version: 1, createdAt: value.createdAt, profiles, events: allEvents, careDays };
}

function readJSON(jsonText) {
  if (typeof jsonText !== 'string' || jsonText.length > MAX_IMPORT_BYTES
      || new TextEncoder().encode(jsonText).byteLength > MAX_IMPORT_BYTES) {
    throw new Error('请选择 16 MB 以内的记忆文件。');
  }
  let value;
  try {
    value = JSON.parse(jsonText, (key, entry) => {
      if (FORBIDDEN_KEYS.has(key)) throw new Error('记忆文件包含不支持的字段。');
      return entry;
    });
  } catch {
    throw new Error('记忆文件损坏或格式不正确。');
  }
  return normalizeState(value);
}

function storageAccess(storage) {
  const target = storage === undefined ? globalThis.localStorage : storage;
  if (!target || typeof target.getItem !== 'function' || typeof target.setItem !== 'function') {
    throw new Error('当前浏览器无法保存记忆。');
  }
  return target;
}

function preserveRecovery(storage, raw) {
  const cache = recoveryCache.get(storage) || new Map();
  const cachedKey = cache.get(raw);
  if (cachedKey && storage.getItem(cachedKey) === raw) return cachedKey;
  const original = storage.getItem(RECOVERY_KEY);
  let key = RECOVERY_KEY;
  if (original !== null && original !== raw) {
    // Find an identical backup after a reload, without replacing any earlier backup.
    if (typeof storage.key === 'function' && Number.isInteger(storage.length)) {
      for (let i = 0; i < storage.length; i++) {
        const existingKey = storage.key(i);
        if (existingKey?.startsWith(`${RECOVERY_KEY}.`) && storage.getItem(existingKey) === raw) {
          cache.set(raw, existingKey);
          recoveryCache.set(storage, cache);
          return existingKey;
        }
      }
    }
    do {
      key = `${RECOVERY_KEY}.${Date.now()}.${++recoverySequence}`;
    } while (storage.getItem(key) !== null);
  }
  if (storage.getItem(key) !== raw) storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error('无法保留原始记忆。');
  cache.set(raw, key);
  recoveryCache.set(storage, cache);
  return key;
}

function recoveryDetails(storage) {
  try {
    if (storage.getItem(RECOVERY_KEY) !== null) return { recoveryKey: RECOVERY_KEY };
    if (typeof storage.key === 'function' && Number.isInteger(storage.length)) {
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key?.startsWith(`${RECOVERY_KEY}.`) && storage.getItem(key) !== null) return { recoveryKey: key };
      }
    }
  } catch { /* A recovery lookup must not hide an otherwise readable primary state. */ }
  return {};
}

export function createState(now = new Date()) {
  return {
    version: 1,
    createdAt: validDate(now).toISOString(),
    profiles: { petName: '小满', caregivers: [{ id: 'a', name: '我' }, { id: 'b', name: '另一位' }] },
    events: [],
    careDays: {},
  };
}

export function loadState(storage) {
  let stored;
  let target;
  try {
    target = storageAccess(storage);
    stored = target.getItem(STORAGE_KEY);
  } catch {
    return { state: createState(), available: false, error: '浏览器暂时无法保存记忆，请导出备份。' };
  }
  if (stored === null) return { state: createState(), available: true, ...recoveryDetails(target) };
  try {
    return { state: readJSON(stored), available: true, ...recoveryDetails(target) };
  } catch (error) {
    try {
      const recoveryKey = preserveRecovery(target, stored);
      return { state: createState(), available: true, recoveryKey, error: `已有记忆暂时无法读取，原始内容已单独保留。${error.message}` };
    } catch {
      return { state: createState(), available: false, recoveryRequired: true, error: '已有记忆暂时无法读取，也无法保留恢复副本。原始内容尚未覆盖，请先保存原始记忆。' };
    }
  }
}

export function saveState(state, storage) {
  try {
    const output = exportState(state);
    const target = storageAccess(storage);
    const stored = target.getItem(STORAGE_KEY);
    if (stored !== null) {
      try { readJSON(stored); }
      catch { preserveRecovery(target, stored); }
    }
    target.setItem(STORAGE_KEY, output);
    return true;
  } catch {
    return false;
  }
}

export function applyCare(state, { kind, actorId, text = '' }, now = new Date()) {
  if (!KINDS.has(kind) || !ACTORS.has(actorId)) throw new Error('请选择有效的照顾方式和家庭成员。');
  if (state.events.length >= MAX_EVENTS) throw capacityError();
  const content = plainText(text, 160);
  if (kind === 'note' && !content) throw new Error('先写下一点想记住的话吧。');
  const day = dayKey(now);
  const before = state.careDays[day] || { a: false, b: false };
  const today = { ...before, [actorId]: true };
  const id = globalThis.crypto?.randomUUID?.()
    || `ant-${now.getTime().toString(36)}-${(++fallbackSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
  const event = { id, kind, actorId, text: content, createdAt: now.toISOString(), day };
  return {
    state: { ...state, events: [...state.events, event], careDays: { ...state.careDays, [day]: today } },
    event,
    newTogetherDay: !(before.a && before.b) && today.a && today.b,
  };
}

export function updateProfiles(state, changes) {
  const old = state.profiles;
  return {
    ...state,
    profiles: {
      petName: changes.petName === undefined ? old.petName : nameText(changes.petName),
      caregivers: old.caregivers.map(person => ({
        id: person.id,
        name: changes[person.id] === undefined ? person.name : nameText(changes[person.id]),
      })),
    },
  };
}

export function getSummary(state, now = new Date()) {
  const today = dayKey(now);
  const birth = dayKey(new Date(state.createdAt));
  const elapsedDays = Math.round((Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${birth}T00:00:00.000Z`)) / 86400000);
  return {
    ageDays: Math.max(1, elapsedDays + 1),
    togetherDays: Object.values(state.careDays).filter(day => day.a === true && day.b === true).length,
    notesCount: state.events.filter(event => event.kind === 'note').length,
    today: { a: state.careDays[today]?.a === true, b: state.careDays[today]?.b === true },
  };
}

export function exportState(state) {
  return JSON.stringify(normalizeState(state), null, 2);
}

export function mergeImport(state, jsonText) {
  const incoming = readJSON(jsonText);
  const current = normalizeState(state);
  const byId = new Map(current.events.map(event => [event.id, event]));
  for (const event of incoming.events) if (!byId.has(event.id)) byId.set(event.id, event);
  if (byId.size > MAX_EVENTS) throw capacityError();
  const careDays = { ...current.careDays };
  for (const [day, care] of Object.entries(incoming.careDays)) {
    careDays[day] = { a: care.a || careDays[day]?.a === true, b: care.b || careDays[day]?.b === true };
  }
  return {
    version: 1,
    createdAt: current.createdAt < incoming.createdAt ? current.createdAt : incoming.createdAt,
    profiles: incoming.profiles,
    events: sortEvents([...byId.values()]),
    careDays,
  };
}
