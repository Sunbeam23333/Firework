import { createState, exportState, mergeImport } from './store.js';
export const API_URL = 'https://firework-shared-memory.chummy-rose-4464.chatgpt.site';
export const KEY_STORAGE = 'firework.shared.key';
export const ACTOR_STORAGE = 'firework.shared.actor';
const CACHE = 'firework.shared.cache.v1';
const OUTBOX = 'firework.shared.pending.';
const byTime = (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
export function readKey(text) {
  let key = text.trim();
  if (key.includes('#')) key = new URLSearchParams(key.split('#')[1]).get('key') || '';
  return /^[A-Za-z0-9_-]{43}$/.test(key) ? key : null;
}
export function sharedState(base, events) {
  const careDays = {};
  const sorted = [...new Map(events.map(event => [event.id, event])).values()].sort(byTime);
  for (const event of sorted) careDays[event.day] = { a: false, b: false, ...careDays[event.day], [event.actorId]: true };
  return { ...base, events: sorted, careDays };
}
export class SharedHome {
  constructor({ key, storage, fetcher = globalThis.fetch, onChange = () => {}, onStatus = () => {} }) {
    this.key = key; this.storage = storage; this.fetcher = fetcher; this.onChange = onChange; this.onStatus = onStatus;
    this.state = createState(); this.cursor = 0; this.profileVersion = 0; this.pending = new Map(); this.busy = null; this.authenticated = false;
    this.storageOK = true;
    try {
      const raw = storage.getItem(CACHE);
      if (raw) {
        try {
          const cache = JSON.parse(raw);
          if (cache.key !== this.key) return;
          if (!Number.isSafeInteger(cache.cursor) || cache.cursor < 0 || !Number.isSafeInteger(cache.profileVersion)) throw new Error('cache');
          this.state = mergeImport(createState(), exportState(cache.state));
          this.cursor = cache.cursor; this.profileVersion = cache.profileVersion;
        } catch {
          storage.setItem(`firework.shared.recovery.${Date.now()}`, raw);
        }
      }
    } catch { this.storageOK = false; }
    this.readPending();
  }
  readPending() {
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key?.startsWith(OUTBOX)) {
          const raw = JSON.parse(this.storage.getItem(key));
          const event = JSON.parse(exportState({ ...createState(), events: [raw] })).events[0];
          this.pending.set(event.id, event);
        }
      }
    } catch { this.storageOK = false; }
  }
  view() { return sharedState(this.state, [...this.state.events, ...this.pending.values()]); }
  emit() { this.onChange(this.view()); }
  status(message) { this.onStatus(this.storageOK ? message : `${message} · 本机无法暂存，请保持网页打开`); }
  cache() {
    try { this.storage.setItem(CACHE, JSON.stringify({ key: this.key, state: this.state, cursor: this.cursor, profileVersion: this.profileVersion })); }
    catch { this.storageOK = false; }
  }
  enqueue(events) {
    const ids = new Set([...this.view().events, ...events].map(event => event.id));
    if (ids.size > 10000) throw new Error('合并后会超过 10,000 条记忆，请保留原备份文件。');
    for (const event of events) {
      this.pending.set(event.id, event);
      try { this.storage.setItem(OUTBOX + event.id, JSON.stringify(event)); }
      catch { this.storageOK = false; }
    }
    this.emit(); this.status(`有 ${this.pending.size} 条记忆等待同步`);
    void this.sync();
  }
  async request(path, options = {}) {
    const response = await this.fetcher(API_URL + path, { ...options, cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${this.key}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || '共享服务暂时连接不上。'); error.status = response.status; error.data = data; throw error; }
    return data;
  }
  async pull() {
    let data;
    do {
      data = await this.request(`/v1/sync?after=${this.cursor}`);
      this.authenticated = true;
      const events = new Map(this.state.events.map(event => [event.id, event]));
      for (const event of data.events) events.set(event.id, event);
      this.state = sharedState({ ...this.state, createdAt: data.createdAt, profiles: data.profiles }, [...events.values()]);
      this.cursor = data.cursor; this.profileVersion = data.profileVersion;
      this.cache(); this.emit();
    } while (data.hasMore);
  }
  async sync() {
    if (this.busy) return this.busy;
    this.busy = this.run();
    try { return await this.busy; } finally { this.busy = null; }
  }
  async run() {
    this.lastError = null;
    this.status('正在同步你们的小窝…');
    try {
      this.readPending();
      await this.pull();
      while (this.pending.size) {
        const batch = [...this.pending.values()].slice(0, 100);
        const result = await this.request('/v1/events', { method: 'POST', body: JSON.stringify({ events: batch }) });
        const sent = new Map(batch.map(event => [event.id, event]));
        // Retain successful uploads in the cache before deleting their outbox records.
        const accepted = result.acknowledged.filter(id => sent.has(id));
        this.state = sharedState(this.state, [...this.state.events, ...result.events]);
        this.cache();
        for (const id of accepted) {
          this.pending.delete(id);
          try { this.storage.removeItem(OUTBOX + id); } catch { this.storageOK = false; }
        }
        this.emit();
        if (result.capacityReached || !accepted.length) throw new Error('记忆罐已满，请先导出备份。未同步的记忆仍留在本机。');
      }
      await this.pull();
      this.status('共同记忆已同步');
      return true;
    } catch (error) {
      this.lastError = error;
      if (error.status === 401) this.authenticated = false;
      this.status(error.status === 401 ? error.message : this.pending.size ? `有 ${this.pending.size} 条待同步 · ${error.message || '联网后自动重试'}` : '暂时离线 · 联网后自动同步');
      return false;
    }
  }
  async setProfiles(profiles, expectedVersion = this.profileVersion) {
    try {
      const data = await this.request('/v1/profiles', { method: 'PATCH', body: JSON.stringify({ profiles, expectedVersion }) });
      this.state = { ...this.state, profiles: data.profiles }; this.profileVersion = data.profileVersion; this.cache(); this.emit();
    } catch (error) {
      if (error.status === 409) { this.state = { ...this.state, profiles: error.data.profiles }; this.profileVersion = error.data.profileVersion; this.cache(); this.emit(); }
      throw error;
    }
  }
}
