import { createState, exportState, mergeImport } from './store.js';
export const API_URL = 'https://firework-shared-memory.sunbeam514.chatgpt.site';
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
  constructor({ key, storage, fetcher = globalThis.fetch, onChange = () => {}, onStatus = () => {}, requestTimeoutMs = 12000 }) {
    this.key = key; this.storage = storage; this.fetcher = fetcher; this.onChange = onChange; this.onStatus = onStatus;
    this.state = createState(); this.cursor = 0; this.profileVersion = 0; this.pending = new Map(); this.busy = null; this.authenticated = false;
    this.storageOK = true;
    this.requestTimeoutMs = requestTimeoutMs;
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
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.requestTimeoutMs);
    try {
      // Native browser fetch rejects a SharedHome receiver (Illegal invocation).
      const fetcher = this.fetcher;
      const response = await fetcher(API_URL + path, {
        ...options, cache: 'no-store', credentials: 'omit', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.key}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { /* Preserve the HTTP status of gateway error pages. */ }
      if (!response.ok) {
        const fallback = response.status === 401 ? '小窝钥匙不正确，请重新打开邀请链接。' : `共享服务暂时无法响应（${response.status}），稍后会重试。`;
        const error = new Error(typeof data?.error === 'string' ? data.error : fallback);
        error.status = response.status; error.code = 'http'; error.data = data;
        throw error;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        const error = new Error('共享服务返回了无法读取的内容，请稍后重试。');
        error.code = 'protocol'; throw error;
      }
      return data;
    } catch (cause) {
      if (cause.code === 'http' || cause.code === 'protocol') throw cause;
      const error = new Error(timedOut ? '连接共享服务超时，稍后会自动重试。' : '未能连接共享服务，请检查网络后重试。');
      error.code = timedOut ? 'timeout' : 'network';
      throw error;
    } finally { clearTimeout(timer); }
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
      this.status(this.pending.size ? `有 ${this.pending.size} 条待同步 · ${error.message}` : error.message);
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
