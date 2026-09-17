import { loadState, saveState, applyCare, updateProfiles, getSummary, exportState, mergeImport } from './store.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const loaded = loadState();
let state = loaded.state;
let actorId = 'a';
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
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
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
    date.textContent = `${new Date(event.createdAt).getFullYear()} 年 ${dateFormat.format(new Date(event.createdAt))}`;
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
  try {
    const result = applyCare(state, { kind, actorId, text });
    state = result.state;
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
  actorId = button.dataset.actor;
  render();
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
form.addEventListener('submit', event => {
  event.preventDefault();
  try {
    state = updateProfiles(state, { petName: form.elements.petName.value, a: form.elements.a.value, b: form.elements.b.value });
    const saved = persist();
    render();
    speech.textContent = `我叫${state.profiles.petName}，是你们的小蚂蚁。请多多关照呀。`;
    dialog.close();
    notify(saved ? '从今天起，小窝有了你们的名字。' : '名字已更新，暂时无法保存，请导出备份。');
  } catch (error) { notify(error.message); }
});
$('#export-memory').addEventListener('click', () => {
  const blob = new Blob([exportState(state)], { type: 'application/json' });
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
    state = mergeImport(state, await file.text());
    const saved = persist();
    render();
    form.elements.petName.value = state.profiles.petName;
    form.elements.a.value = personName('a');
    form.elements.b.value = personName('b');
    speech.textContent = '这些小幸福，我都想起来啦。欢迎回家。';
    notify(saved ? '回忆已合并，原来的记忆也都还在。' : '回忆已导入，但当前浏览器无法保存，请再导出备份。');
  } catch (error) { notify(error.message); }
  event.target.value = '';
});
window.addEventListener('storage', event => {
  if (event.key === 'firework.ant.v1' && event.newValue) {
    try {
      state = mergeImport(state, event.newValue);
      const incoming = mergeImport(state, event.newValue);
      const remoteIds = new Set(JSON.parse(event.newValue).events.map(item => item.id));
      if (state.events.some(item => !remoteIds.has(item.id))) saveState(incoming);
      render();
    } catch { /* Keep this tab's valid memories. */ }
  }
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
setInterval(() => { if (!document.hidden) render(); }, 60000);

render();
if (loaded.error) {
  $('#storage-warning').textContent = recoveryKey ? '有一份旧记忆未能读取，原始数据已保留。请在小窝设置中导出恢复文件。' : loaded.error;
  $('#storage-warning').hidden = false;
  $('#export-recovery').hidden = !recoveryKey;
} else if (!persist()) {
  $('#storage-warning').hidden = false;
}
if (state.events.length) speech.textContent = `你回来啦！${state.profiles.petName}和那些小小的回忆，一直都在。`;
