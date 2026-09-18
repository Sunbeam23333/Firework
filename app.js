import { createState, loadState, saveState, applyCare, updateProfiles, getSummary, exportState, mergeImport } from './store.js';

import { SharedHome, readKey, KEY_STORAGE, ACTOR_STORAGE } from './sync.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const loaded = loadState();
let state = loaded.state;
let actorId = null;
let home = null;
let settingsVersion = 0;
try { actorId = localStorage.getItem(ACTOR_STORAGE); } catch {}
if (!['a', 'b'].includes(actorId)) actorId = null;
let filter = 'all';
let visibleCount = 6;
let asleep = false;
let toastTimer;
let actionTimer;
let whisperIndex = 0;
let recoveryKey = loaded.recoveryKey || null;
const speech = $('#pet-speech');
const pet = $('#pet-character');
const dialog = $('#settings-dialog');
const input = $('#memory-input');
const form = $('#settings-form');
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' });
const iconFor = { feed: 'spark', pet: 'heart', rest: 'moon', note: 'note' };

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function notify(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3400);
}

function persist() {
  if (home) return home.storageOK;
  const latest = loadState();
  if (latest.recoveryKey) recoveryKey = latest.recoveryKey;
  if (!latest.error) {
    const profiles = state.profiles;
    state = { ...mergeImport(state, exportState(latest.state)), profiles };
  }
  const ok = saveState(state);
  $('#storage-warning').hidden = ok && !recoveryKey;
  if (recoveryKey) {
    $('#storage-warning').textContent = '有一份旧记忆未能读取，原始数据已保留。请在小窝设置中导出恢复文件。';
    $('#export-recovery').hidden = false;
  }
  return ok;
}

function personName(id) {
  return state.profiles.caregivers.find(person => person.id === id)?.name || '我们';
}

function careText(event) {
  if (event.kind === 'note') return event.text;
  const name = state.profiles.petName;
  return { feed: `给${name}喂了一颗星星糖。小小一颗，甜了好久。`, pet: `轻轻摸了摸${name}的小脑袋。它把触角也靠过来了。`, rest: `陪${name}安静地待了一会儿。什么都不做，也很好。` }[event.kind];
}

function renderMemories() {
  const events = state.events.filter(event => filter === 'all' || (filter === 'note' ? event.kind === 'note' : event.kind !== 'note')).slice().reverse();
  const list = $('#memory-list');
  list.replaceChildren();
  if (events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-memory';
    empty.append(icon('note'));
    const content = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = filter === 'care' ? '一点点陪伴，就从现在开始' : '第一份小幸福，还在等你';
    const detail = document.createElement('p');
    detail.textContent = filter === 'care' ? '喂颗糖，摸摸头，都是它喜欢的小事。' : '写下一句话，让今天有一个被记住的理由。';
    content.append(title, detail);
    empty.append(content);
    list.append(empty);
  }
  for (const event of events.slice(0, visibleCount)) {
    const card = document.createElement('article');
    card.className = 'memory-card';
    const top = document.createElement('div');
    top.className = 'memory-card-top';
    const date = document.createElement('time');
    date.dateTime = event.createdAt;
    date.textContent = dateFormat.format(new Date(event.createdAt));
    top.append(date, icon(iconFor[event.kind]));
    const text = document.createElement('p');
    text.textContent = careText(event);
    const byline = document.createElement('div');
    byline.className = 'memory-card-bottom';
    byline.textContent = `${personName(event.actorId)}${event.kind === 'note' ? ' 写给小蚁' : ' 来过这里'}`;
    card.append(top, text, byline);
    list.append(card);
  }
  $('#load-more').hidden = events.length <= visibleCount;
}

function render() {
  const summary = getSummary(state);
  const name = state.profiles.petName;
  $('#age-days').textContent = String(summary.ageDays).padStart(2, '0');
  $('#pet-name').textContent = name;
  pet.setAttribute('aria-label', `摸摸${name}的小脑袋`);
  $('#memory-count').textContent = `${summary.notesCount} 张纸条`;
  $('#together-days').textContent = summary.togetherDays;
  const todayCount = Number(summary.today.a) + Number(summary.today.b);
  $('#spark-count').textContent = `${todayCount} / 2`;
  $('#together-message').classList.toggle('lit', todayCount === 2);
  $('#together-copy').textContent = todayCount === 2 ? '你们都来了，今天的小火花亮啦。' : todayCount === 1 ? '亮起半边啦，等另一位带来一点甜。' : '两个人都来过，小火花就亮了。';
  for (const person of state.profiles.caregivers) {
    $(`[data-person-name="${person.id}"]`).textContent = person.name;
    $(`[data-person-status="${person.id}"]`).textContent = summary.today[person.id] ? '今天来过啦' : '还没来过';
    const button = $(`[data-actor="${person.id}"]`);
    button.classList.toggle('visited', summary.today[person.id]);
    button.classList.toggle('selected', actorId === person.id);
    button.setAttribute('aria-pressed', String(actorId === person.id));
    button.querySelector('.avatar').textContent = Array.from(person.name)[0];
  }
  $('#mood-label').textContent = asleep ? '正在做甜甜的梦' : todayCount === 2 ? '今天被双倍喜欢' : todayCount === 1 ? '心里暖暖的' : '正在等你来';
  $('#pet-status').textContent = asleep ? '充电中，梦里也有星星糖' : '一只爱收集小幸福的蚂蚁';
  $('#pet-scene').classList.toggle('asleep', asleep);
  renderMemories();
}

function animate(kind, together) {
  pet.classList.remove('hop', 'cuddle');
  void pet.offsetWidth;
  if (kind !== 'rest') pet.classList.add(kind === 'pet' ? 'cuddle' : 'hop');
  clearTimeout(actionTimer);
  actionTimer = setTimeout(() => pet.classList.remove('hop', 'cuddle'), 1300);
  if (kind === 'rest' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const container = $('#particles');
  for (let i = 0; i < (together ? 12 : 6); i++) {
    const particle = document.createElement('span');
    particle.className = 'particle';
    particle.textContent = kind === 'feed' ? '✦' : '♡';
    const angle = (i / (together ? 12 : 6)) * Math.PI * 2;
    particle.style.setProperty('--x', `${Math.cos(angle) * (65 + Math.random() * 85)}px`);
    particle.style.setProperty('--y', `${-60 - Math.abs(Math.sin(angle)) * 125}px`);
    particle.style.setProperty('--r', `${Math.random() * 50 - 25}deg`);
    particle.style.animationDelay = `${i * .035}s`;
    container.append(particle);
    setTimeout(() => particle.remove(), 1800);
  }
}

function remember(kind, text = '') {
  if (!home || !home.profileVersion) { $('#join-dialog').showModal(); return false; }
  if (!actorId) { $('#identity-dialog').showModal(); return false; }
  try {
    const result = applyCare(state, { kind, actorId, text });
    state = result.state;
    home.enqueue([result.event]);
    asleep = kind === 'rest';
    const saved = persist();
    const name = personName(actorId);
    const messages = {
      feed: '谢谢你送的星星糖！我把今天的甜，藏在小肚子里了。',
      pet: `嘿嘿，触角都被你摸得翘起来了。最喜欢${name}啦。`,
      rest: '那就一起安静一会儿吧。所有小幸福，都还在这里。',
      note: `记住啦。${name}写下的这件小事，我会放进记忆罐。`,
    };
    speech.textContent = result.newTogetherDay ? '你们都来啦！今天的我，是被双倍喜欢的小蚂蚁。' : messages[kind];
    visibleCount = 6;
    render();
    animate(kind, result.newTogetherDay);
    if (!saved) notify('这次记忆暂时无法保存，请导出备份。');
    else if (result.newTogetherDay) notify('今日双人小火花，点亮成功 ✦');
    else if (kind === 'note') notify('这件小事，已经好好收起来了。');
    return true;
  } catch (error) {
    notify(error.message);
    return false;
  }
}

$$('[data-actor]').forEach(button => button.addEventListener('click', () => {
  chooseActor(button.dataset.actor);
}));
$$('[data-care]').forEach(button => button.addEventListener('click', () => remember(button.dataset.care)));
pet.addEventListener('click', () => remember('pet'));
input.addEventListener('input', () => {
  const chars = Array.from(input.value);
  if (chars.length > 160) input.value = chars.slice(0, 160).join('');
  $('#char-count').textContent = `${Array.from(input.value).length} / 160`;
});
$('#memory-form').addEventListener('submit', event => {
  event.preventDefault();
  if (remember('note', input.value)) {
    input.value = '';
    $('#char-count').textContent = '0 / 160';
  }
});
$('#whisper').addEventListener('click', () => {
  const notes = state.events.filter(event => event.kind === 'note');
  const lines = ['我偷偷数过啦，和你在一起的普通日子，都闪闪发光。', '我的愿望很小：有一点糖，还有你们。', '今天没发生什么大事也没关系。你来，就是小幸福。', '如果累了，就在我旁边坐一会儿吧。'];
  const note = notes.length ? notes[(notes.length - 1 - whisperIndex % notes.length)] : null;
  speech.textContent = note && whisperIndex % 2 === 0 ? `我还记得${personName(note.actorId)}说：“${Array.from(note.text).slice(0, 35).join('')}${Array.from(note.text).length > 35 ? '…' : ''}”` : lines[whisperIndex % lines.length];
  whisperIndex++;
  asleep = false;
  render();
  animate('pet', false);
});
$$('[data-filter]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  visibleCount = 6;
  $$('[data-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  renderMemories();
}));
$('#load-more').addEventListener('click', () => { visibleCount += 6; renderMemories(); });

function openSettings() {
  settingsVersion = home?.profileVersion || 0;
  $('#copy-invite').disabled = !home?.profileVersion;
  $('#bring-local').hidden = !home || !loaded.state.events.length;
  form.elements.petName.value = state.profiles.petName;
  form.elements.a.value = personName('a');
  form.elements.b.value = personName('b');
  dialog.showModal();
}
$('#open-settings').addEventListener('click', openSettings);
$('#memory-help').addEventListener('click', openSettings);
$('#close-settings').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (!home?.profileVersion) throw new Error('请先用邀请链接进入共同小窝。');
    const next = updateProfiles(state, { petName: form.elements.petName.value, a: form.elements.a.value, b: form.elements.b.value });
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try { await home.setProfiles(next.profiles, settingsVersion); }
    finally { submit.disabled = false; settingsVersion = home.profileVersion; }
    speech.textContent = `我叫${state.profiles.petName}，是你们的小蚂蚁。请多多关照呀。`;
    dialog.close();
    notify('小窝的名字已经同步给对方啦。');
  } catch (error) {
    if (error.status === 409) {
      form.elements.petName.value = state.profiles.petName;
      form.elements.a.value = personName('a'); form.elements.b.value = personName('b');
    }
    notify(error.message);
  }
});
$('#export-memory').addEventListener('click', () => {
  const backup = state.events.length > 10000 ? JSON.stringify({ ...state, exportNote: '此紧急备份包含超出容量的待同步记录，请分批恢复。' }, null, 2) : exportState(state);
  const blob = new Blob([backup], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `firework-memory-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  notify('记忆已经打包好，请收好这份备份。');
});
$('#import-memory').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error('请选择 16 MB 以内的记忆文件。');
    if (!home?.profileVersion) throw new Error('请先进入共同小窝。');
    const imported = mergeImport(createState(), await file.text());
    const known = new Set(state.events.map(item => item.id));
    home.enqueue(imported.events.filter(item => !known.has(item.id)));
    const saved = persist();
    render();
    form.elements.petName.value = state.profiles.petName;
    form.elements.a.value = personName('a');
    form.elements.b.value = personName('b');
    speech.textContent = '这些小幸福，我都想起来啦。欢迎回家。';
    notify(saved ? '回忆已合并，正在同步到共同记忆罐。' : '回忆已导入，但当前浏览器无法保存，请再导出备份。');
  } catch (error) { notify(error.message); }
  event.target.value = '';
});
window.addEventListener('storage', event => {
  if (event.key?.startsWith('firework.shared.pending.') && home) { home.readPending(); home.emit(); void home.sync(); }
});
$('#export-recovery').addEventListener('click', () => {
  try {
    const raw = localStorage.getItem(recoveryKey);
    if (!raw) throw new Error('没有找到恢复文件。');
    const url = URL.createObjectURL(new Blob([raw], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'firework-memory-recovery.txt';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (error) { notify(error.message); }
});
function chooseActor(id) {
  actorId = id;
  try { localStorage.setItem(ACTOR_STORAGE, id); } catch {}
  render();
}
$$('[data-identity]').forEach(button => button.addEventListener('click', () => {
  chooseActor(button.dataset.identity);
  $('#identity-dialog').close();
  notify(`欢迎回家，${personName(actorId)}。`);
}));
const syncStatus = $('#sync-status');
const volatile = new Map();
let sharedStorage;
try { sharedStorage = localStorage; }
catch { sharedStorage = { getItem: key => volatile.get(key) ?? null, setItem() { throw new Error('storage'); }, removeItem: key => volatile.delete(key), key: i => [...volatile.keys()][i], get length() { return volatile.size; } }; }
async function connect(key) {
  const candidate = new SharedHome({ key, storage: sharedStorage,
    onChange: next => { if (home === candidate) { state = next; render(); } },
    onStatus: message => { syncStatus.textContent = message; if (home !== candidate) $('#join-message').textContent = message; },
  });
  // The room has a single fixed key; cached access also works temporarily offline.
  const success = await candidate.sync();
  if (candidate.lastError?.status === 401 || (!success && !candidate.profileVersion)) return false;
  home = candidate;
  state = home.view(); render();
  try { sharedStorage.setItem(KEY_STORAGE, key); } catch {}
  $('#join-dialog').close();
  if (!actorId) {
    for (const button of $$('[data-identity]')) button.textContent = `我是${personName(button.dataset.identity)}`;
    $('#identity-dialog').showModal();
  }
  return true;
}
$('#join-form').addEventListener('submit', async event => {
  event.preventDefault();
  const key = readKey($('#invite-input').value);
  if (!key) { $('#join-message').textContent = '请粘贴完整的邀请链接。'; return; }
  const button = $('#join-form button'); button.disabled = true;
  try { await connect(key); } finally { button.disabled = false; }
});
function inviteURL() { return `${location.origin}${location.pathname}#key=${home.key}`; }
$('#copy-invite').addEventListener('click', async () => {
  if (!home) return;
  try { await navigator.clipboard.writeText(inviteURL()); notify('邀请链接已复制，发给对方就能一起养小蚁啦。'); }
  catch { $('#invite-copy').hidden = false; $('#invite-copy').value = inviteURL(); $('#invite-copy').select(); }
});
$('#bring-local').addEventListener('click', () => {
  if (!home) return;
  const known = new Set(state.events.map(item => item.id));
  home.enqueue(loaded.state.events.filter(item => !known.has(item.id)));
  $('#bring-local').hidden = true;
  notify('旧回忆正在带入共同小窝，原始本地副本也会保留。');
});
$('#retry-sync').addEventListener('click', () => home ? void home.sync() : $('#join-dialog').showModal());
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); void home?.sync(); } });
window.addEventListener('online', () => void home?.sync());
setInterval(() => { if (!document.hidden) void home?.sync(); }, 15000);
setInterval(() => { if (!document.hidden) render(); }, 60000);
render();
if (loaded.error) {
  $('#storage-warning').textContent = recoveryKey ? '有一份旧记忆未能读取，原始数据已保留。请在小窝设置中导出恢复文件。' : loaded.error;
  $('#storage-warning').hidden = false;
  $('#export-recovery').hidden = !recoveryKey;
}
async function start() {
  const fragmentKey = readKey(location.hash);
  let storedKey;
  try { storedKey = readKey(sharedStorage.getItem(KEY_STORAGE) || ''); } catch {}
  if (fragmentKey) history.replaceState(null, '', location.pathname + location.search);
  const key = fragmentKey || storedKey;
  if (key && await connect(key)) return;
  state = createState(); render();
  $('#join-dialog').showModal();
}
void start();
