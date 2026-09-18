import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { webcrypto, createHash } from 'node:crypto';
import worker from '../backend/worker.js';
import { SharedHome, readKey } from '../sync.js';
import { createState, applyCare, getSummary } from '../store.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const key = 'a'.repeat(43);
const storage = () => {
  const map = new Map();
  return { getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v), removeItem: k => map.delete(k), key: n => [...map.keys()][n], get length() { return map.size; } };
};
const event = (actorId, text, date = '2026-09-18T16:05:00.000Z') => applyCare(createState(), { kind: 'note', actorId, text }, new Date(date)).event;
function database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'firework-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = `import sqlite3,json,sys\ndb=sqlite3.connect(sys.argv[1])\ndb.row_factory=sqlite3.Row\na=json.loads(sys.argv[2])\nr=[]\nwith db:\n for q in a:\n  before=db.total_changes\n  c=db.execute(q['sql'],q.get('values',[]))\n  rows=[dict(x) for x in c.fetchall()]\n  r.append({'results':rows,'meta':{'changes':db.total_changes-before}})\nprint(json.dumps(r))`;
  function run(queries) {
    const result = spawnSync('python3', ['-c', script, join(dir,'db.sqlite'), JSON.stringify(queries)], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout);
  }
  for (const file of readdirSync(new URL('../drizzle', import.meta.url)).filter(x => x.endsWith('.sql'))) {
    const sql = readFileSync(new URL('../drizzle/' + file, import.meta.url),'utf8');
    run(sql.split('--> statement-breakpoint').filter(x=>x.trim()).map(sql => ({ sql })));
  }
  const db = { prepare(sql) {
    return { sql, values: [], bind(...values) { this.values=values; return this; }, async run() { return run([this])[0]; }, async all() { return run([this])[0]; }, async first() { return run([this])[0].results[0] ?? null; } };
  }, async batch(queries) { return run(queries); } };
  const env = { DB: db, ROOM_KEY_HASH: createHash('sha256').update(key).digest('hex'), ALLOWED_ORIGIN: 'https://sunbeam23333.github.io' };
  const fetcher = (url, options = {}) => worker.fetch(new Request(url, options), env);
  return { fetcher, env };
}

test('shared API protects memories, normalizes days, deduplicates retries, and rejects stale profile writes', async t => {
  const {fetcher} = database(t);
  const call = (path, method='GET', body, headers={}) => fetcher('https://example.test'+path, { method, headers: {Authorization:'Bearer '+key,'Content-Type':'application/json',...headers}, ...(body ? {body:JSON.stringify(body)} : {}) });
  assert.equal((await call('/v1/sync','GET',null,{Authorization:''})).status,401);
  assert.equal((await call('/v1/sync','GET',null,{Origin:'https://stranger.test'})).status,403);
  const preflight = await call('/v1/events','OPTIONS',null,{Origin:'https://sunbeam23333.github.io',Authorization:''});
  assert.equal(preflight.status,204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'https://sunbeam23333.github.io');
  const a = event('a','我的晚安'); const b=event('b','我的早安');
  await Promise.all([call('/v1/events','POST',{events:[a]}),call('/v1/events','POST',{events:[b]})]);
  await call('/v1/events','POST',{events:[a]});
  const state=await (await call('/v1/sync')).json();
  assert.equal(state.events.length,2); assert.equal(state.events[0].day,'2026-09-19');
  assert.deepEqual(state.profiles.caregivers.map(x=>x.name),['小小金','小蚂蚁']);
  const profiles={...state.profiles,petName:'小糖'};
  assert.equal((await call('/v1/profiles','PATCH',{profiles,expectedVersion:1})).status,200);
  assert.equal((await call('/v1/profiles','PATCH',{profiles:{...profiles,petName:'过时的名字'},expectedVersion:1})).status,409);
  assert.equal((await (await call('/v1/sync?after='+state.cursor)).json()).events.length,0);
  assert.equal((await call('/v1/events','POST',{events:[{...a,actorId:'outsider'}]})).status,400);
});

test('two independent devices share updates and recover a lost response without duplicates', async t => {
  const {fetcher} = database(t);
  const sa=storage(), sb=storage();
  let offline=false, loseResponse=false;
  const unstable=async (url, options) => {
    if(offline) throw new TypeError('offline');
    const response=await fetcher(url,options);
    if(loseResponse && options.method==='POST'){loseResponse=false;throw new TypeError('lost response');}
    return response;
  };
  const a=new SharedHome({key,storage:sa,fetcher:unstable});
  const b=new SharedHome({key,storage:sb,fetcher});
  await Promise.all([a.sync(),b.sync()]);
  offline=true;
  a.enqueue([event('a','断网写下的话')]); await a.sync();
  assert.equal(a.pending.size,1);
  b.enqueue([event('b','另一台设备的话')]); await b.sync();
  offline=false;loseResponse=true;
  const reloaded=new SharedHome({key,storage:sa,fetcher:unstable});
  await reloaded.sync(); assert.equal(reloaded.pending.size,1);
  await reloaded.sync(); await b.sync();
  assert.equal(reloaded.pending.size,0); assert.equal(b.view().events.length,2);
  assert.equal(getSummary(b.view(),new Date('2026-09-18T16:05:00.000Z')).togetherDays,1);
  const wrong=new SharedHome({key:'b'.repeat(43),storage:sa,fetcher});
  assert.equal(wrong.profileVersion,0); assert.equal(await wrong.sync(),false); assert.equal(wrong.authenticated,false);
});

test('new actions during an in-flight upload stay in the outbox until acknowledged', async t => {
  const {fetcher} = database(t);
  let unlock, entered;
  const gate=new Promise(resolve=>unlock=resolve), started=new Promise(resolve=>entered=resolve);
  let held=false;
  const wrapped=async (url,options)=>{if(options.method==='POST'&&!held){held=true;entered();await gate;}return fetcher(url,options);};
  const home=new SharedHome({key,storage:storage(),fetcher:wrapped});
  await home.sync();
  home.enqueue([event('a','第一条')]);
  await started;
  home.enqueue([event('a','请求过程中写下的第二条')]);
  unlock(); await home.sync();
  assert.equal(home.pending.size,0);assert.equal(home.view().events.length,2);
});

test('invites parse only valid fragment keys',()=>{
  assert.equal(readKey('https://example.test/#key='+key),key);
  assert.equal(readKey('https://example.test/?key='+key),null);
});

test('browser fetch receives no SharedHome receiver and works without AbortSignal.timeout', async t => {
  const previous = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
  t.after(() => Object.defineProperty(AbortSignal, 'timeout', previous));
  let calls = 0;
  const home = new SharedHome({ key, storage: storage(), fetcher: function (_url, options) {
    assert.equal(this, undefined, 'native browser fetch cannot receive a SharedHome as this');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, 'Bearer ' + key);
    calls++;
    return Promise.resolve(Response.json({ ...createState(), profileVersion: 1, cursor: 0, hasMore: false }));
  } });
  assert.equal(await home.sync(), true);
  assert.ok(calls > 0);
  assert.equal(home.lastError, null);
});

test('connection failures preserve HTTP, protocol and network diagnostics', async () => {
  for (const scenario of [
    { fetcher: async () => new Response('<html>gateway unavailable</html>', { status: 502 }), code: 'http', status: 502, text: /502/ },
    { fetcher: async () => Response.json({error:'小窝钥匙不正确'}, { status: 401 }), code: 'http', status: 401, text: /钥匙/ },
    { fetcher: async () => new Response('<html>login page</html>', { status: 200 }), code: 'protocol', text: /无法读取/ },
    { fetcher: async () => { throw new TypeError('Failed to fetch'); }, code: 'network', text: /未能连接/ },
  ]) {
    let message;
    const home = new SharedHome({key, storage:storage(), fetcher:scenario.fetcher, onStatus:value=>message=value});
    assert.equal(await home.sync(),false);
    assert.equal(home.lastError.code,scenario.code);
    assert.equal(home.lastError.status,scenario.status);
    assert.match(message,scenario.text);
    assert.doesNotMatch(message,/暂时离线/);
  }
});

test('request and response-body timeouts abort; settled requests clear their timer', async () => {
  for (const body of [false,true]) {
    const fetcher = (_url, {signal}) => {
      const wait = () => new Promise((resolve,reject) => signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
      return body ? Promise.resolve({ok:true,status:200,text:wait}) : wait();
    };
    const home = new SharedHome({key,storage:storage(),fetcher,requestTimeoutMs:15});
    assert.equal(await home.sync(),false);
    assert.equal(home.lastError.code,'timeout');
  }
  let signal;
  const home = new SharedHome({key,storage:storage(),requestTimeoutMs:15,fetcher:async (_url, options)=>{
    signal=options.signal;return Response.json({ok:true});
  }});
  await home.request('/fixture');
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(signal.aborted,false);
});
