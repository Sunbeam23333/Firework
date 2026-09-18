import { createState, exportState } from '../store.js';

const FRONTEND = 'https://sunbeam23333.github.io/Firework/';
const MAX_BODY = 256 * 1024;
const dbFor = env => {
  if (!env.DB) throw new Error('Database unavailable');
  return env.DB;
};
const digest = async key => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))].map(n => n.toString(16).padStart(2, '0')).join('');
const roomDay = date => new Date(Date.parse(date) + 8 * 3600000).toISOString().slice(0, 10);
async function readBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('需要 JSON 格式。');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('请求内容为空。');
  let size = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('单次记忆太多，请分批保存。'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function getHome(db) {
  const initial = createState();
  await db.prepare('INSERT OR IGNORE INTO home (id, profiles, version, created_at) VALUES (?, ?, ?, ?)').bind('home', JSON.stringify(initial.profiles), 1, initial.createdAt).run();
  const row = await db.prepare('SELECT profiles, version, created_at FROM home WHERE id = ?').bind('home').first();
  return { profiles: JSON.parse(row.profiles), profileVersion: row.version, createdAt: row.created_at };
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowedOrigin = env.ALLOWED_ORIGIN || 'https://sunbeam23333.github.io';
    const headers = { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' };
    if (origin === allowedOrigin) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return reply({ ok: true });
    if (url.pathname === '/' && request.method === 'GET') return Response.redirect(FRONTEND, 302);
    if (origin && origin !== allowedOrigin) return reply({ error: '这个来源不能访问小窝。' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' } });
    const key = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
    if (!env.ROOM_KEY_HASH) return reply({ error: '共享服务暂未就绪。' }, 503);
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || await digest(key) !== env.ROOM_KEY_HASH) return reply({ error: '小窝钥匙不正确，请重新打开邀请链接。' }, 401);
    try {
      const db = dbFor(env);
      if (url.pathname === '/v1/sync' && request.method === 'GET') {
        const after = Number(url.searchParams.get('after') || 0);
        if (!Number.isSafeInteger(after) || after < 0) return reply({ error: '同步位置不正确。' }, 400);
        const home = await getHome(db);
        const { results } = await db.prepare('SELECT seq, payload FROM events WHERE seq > ? ORDER BY seq LIMIT 201').bind(after).all();
        const rows = results.slice(0, 200);
        return reply({ ...home, events: rows.map(row => JSON.parse(row.payload)), cursor: rows.at(-1)?.seq ?? after, hasMore: results.length > 200 });
      }
      if (url.pathname === '/v1/events' && request.method === 'POST') {
        const body = await readBody(request);
        if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 100) return reply({ error: '每次可保存 1 到 100 条记忆。' }, 400);
        const normalized = JSON.parse(exportState({ ...createState(), events: body.events, careDays: {} })).events.map(event => ({ ...event, day: roomDay(event.createdAt) }));
        const statements = normalized.map(event => db.prepare('INSERT OR IGNORE INTO events (id, payload) SELECT ?, ? WHERE (SELECT COUNT(*) FROM events) < 10000').bind(event.id, JSON.stringify(event)));
        await db.batch(statements);
        const ids = normalized.map(event => event.id);
        const { results } = await db.prepare(`SELECT id, payload FROM events WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
        const acknowledged = results.map(row => row.id);
        return reply({ acknowledged, events: results.map(row => JSON.parse(row.payload)), capacityReached: acknowledged.length < ids.length });
      }
      if (url.pathname === '/v1/profiles' && request.method === 'PATCH') {
        const body = await readBody(request);
        if (!Number.isSafeInteger(body.expectedVersion)) return reply({ error: '资料版本不正确。' }, 400);
        const profiles = JSON.parse(exportState({ ...createState(), profiles: body.profiles })).profiles;
        await getHome(db);
        const result = await db.prepare('UPDATE home SET profiles = ?, version = version + 1 WHERE id = ? AND version = ?').bind(JSON.stringify(profiles), 'home', body.expectedVersion).run();
        const home = await getHome(db);
        return result.meta.changes ? reply(home) : reply({ ...home, error: '对方刚刚修改了名字，已为你刷新。请再保存一次。' }, 409);
      }
      return reply({ error: '这里没有这个入口。' }, 404);
    } catch (error) {
      if (error instanceof SyntaxError || /格式|记忆|家庭成员|名字|日期|时间|JSON|请求内容/.test(error.message)) return reply({ error: error.message }, 400);
      console.error('Shared memory request failed', error.name);
      return reply({ error: '共享记忆暂时连接不上，本机待同步的记忆会保留。' }, 503);
    }
  },
};
