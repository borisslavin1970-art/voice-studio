// Голосовая студия (веб-версия): вкладки «Студия», «Переводчик», «Настройки».
import { DATA } from './data.js';
import { LiveSession, DEFAULT_URL } from './live.js';
import { Player, Mic } from './audio.js';
import { studioPrompt, interpreterPrompt, cleanTranscript, langCode } from './prompts.js';

const VERSION = '1.0';
const MODEL = 'gemini-3.8-live';
const TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';
const MOCK = new URLSearchParams(location.search).get('mock');   // только для тестов: адрес поддельного сервера
const $ = s => document.querySelector(s);

// ---------- хранилище и журнал ----------
const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* приватный режим */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};
const getKey = () => store.get('gemini_key') || (MOCK ? 'mock' : '');
const stamp = () => new Date().toLocaleString('sv-SE');
const debugLog = [];
function dlog(msg) {
  const line = `${new Date().toLocaleString('sv-SE')}.${String(Date.now() % 1000).padStart(3, '0')} ${msg}`;
  debugLog.push(line);
  if (debugLog.length > 3000) debugLog.shift();
  console.debug(line);
}

function addLog(box, text, cls = '', stamped = true) {
  const row = document.createElement('div');
  row.className = 'line ' + cls;
  if (stamped) { const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = stamp(); row.append(ts); }
  row.append(document.createTextNode(text));
  box.append(row);
  while (box.childElementCount > 300) box.firstElementChild.remove();
  box.scrollTop = box.scrollHeight;
}

const lastErr = { text: '', at: 0 };
function logError(box, text) {                       // одинаковые ошибки подряд не дублируем
  const now = Date.now();
  if (!(text === lastErr.text && now - lastErr.at < 3000)) addLog(box, '⚠ ' + text, 'err');
  lastErr.text = text; lastErr.at = now;
}

// ---------- справочники ----------
function fillDatalist(id, items) { const dl = $(id); for (const v of items) { const o = document.createElement('option'); o.value = v; dl.append(o); } }
fillDatalist('#dl-jobs', DATA.jobs); fillDatalist('#dl-moods', DATA.moods); fillDatalist('#dl-tones', DATA.tones);
fillDatalist('#dl-ages', DATA.ages); fillDatalist('#dl-langs', DATA.langs);
{
  const acc = $('#s-accent');
  acc.append(new Option('— без акцента —', ''));
  for (const a of DATA.accents) acc.append(new Option(a.name, a.name));
  const st = $('#s-strength');
  for (const s of Object.keys(DATA.strengths)) st.append(new Option(s, s));
  st.value = DATA.defaultStrength;
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
function voiceBlock(p, onChange) {
  const g = $(`#${p}-gender`), v = $(`#${p}-voice`), info = $(`#${p}-info`);
  let extra = '';
  const show = () => {
    const x = DATA.voices.find(o => o.name === v.value);
    info.textContent = (x ? `${x.name}: ${DATA.genderFull[x.gender]} голос, тон ${x.pitch}. ${cap(x.traits)}. Подходит для: ${x.use}.` : '') + extra;
  };
  const refill = keep => {
    keep = keep || v.value;
    const items = DATA.voices.filter(o => !g.value || o.gender === g.value);
    v.replaceChildren(...items.map(o => new Option(`${o.name} · ${o.gender} · ${o.pitch} · ${o.traits}`, o.name)));
    v.value = items.some(o => o.name === keep) ? keep : items[0].name;
    show();
  };
  g.onchange = () => { refill(); onChange(); };
  v.onchange = () => { show(); onChange(); };
  refill('Kore');
  return { name: () => v.value, setExtra: t => { extra = t ? '\n' + t : ''; show(); } };
}

// ---------- звук ----------
const player = new Player();
const mic = new Mic();
let wakeLock = null;
async function lockScreen(on) {
  try {
    if (on && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* не критично */ }
}
const coarse = matchMedia('(pointer: coarse)').matches;      // на телефоне Enter — перенос строки, не отправка
if (coarse || innerWidth < 600) for (const d of document.querySelectorAll('details.opts')) d.open = false;   // на телефоне настройки свёрнуты

function debounced(fn, ms = 700) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

// ====================================================================
//                              СТУДИЯ
// ====================================================================
const sLog = $('#s-log');
const sVoice = voiceBlock('s', () => applyStudio());

function readStudio() {
  return { voice: sVoice.name(), job: $('#s-job').value.trim(), mood: $('#s-mood').value.trim(), tone: $('#s-tone').value.trim(),
    age: $('#s-age').value.trim(), accent: $('#s-accent').value, strength: $('#s-strength').value || DATA.defaultStrength };
}

const studio = new LiveSession({
  name: 'studio', getKey, url: MOCK || DEFAULT_URL, cfg: readStudio(),
  log: m => dlog('[студия] ' + m),
  emit: (k, p) => {
    if (k === 'audio') player.add(p);
    else if (k === 'latency') $('#s-lat').textContent = `первый звук: ${p.toFixed(0)} мс`;
    else if (k === 'error') logError(sLog, p);
    else if (k === 'info') addLog(sLog, 'ℹ ' + p, 'dim');
  },
  buildSetup: cfg => ({
    sync: false,
    setup: {
      model: 'models/' + MODEL,
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } } },
      systemInstruction: { parts: [{ text: studioPrompt(cfg) }] },
    },
  }),
});

function applyStudio() {
  const a = DATA.accents.find(x => x.name === $('#s-accent').value);
  sVoice.setExtra(a ? `Акцент «${a.name}»: ${a.kind}, сила — ${$('#s-strength').value}.` : '');
  studio.setCfg(readStudio());
}
const applyStudioSoon = debounced(applyStudio);
for (const id of ['#s-job', '#s-mood', '#s-tone', '#s-age']) $(id).addEventListener('input', applyStudioSoon);
for (const id of ['#s-accent', '#s-strength']) $(id).addEventListener('change', applyStudio);
$('#s-job').addEventListener('change', applyStudio);

async function studioSay(text) {
  text = text.trim();
  if (!text) return;
  if (!getKey()) return needKey();
  await player.init();
  applyStudio();
  studio.say(text);
  const c = readStudio();
  addLog(sLog, '▶ ' + text);
  addLog(sLog, '[' + [c.voice, c.job, c.mood, c.tone, c.age, c.accent && `акцент ${c.accent} (${c.strength})`].filter(Boolean).join(', ') + ']', 'dim', false);
  $('#s-text').value = '';
}
$('#s-say').onclick = () => studioSay($('#s-text').value);
$('#s-paste').onclick = async () => {
  const t = await readClipboard(sLog);
  if (t) { $('#s-text').value = t; studioSay(t); }
};
$('#s-stop').onclick = () => { player.clear(); studio.stop(); addLog(sLog, '■ остановлено', 'dim'); };
$('#s-text').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) { e.preventDefault(); studioSay($('#s-text').value); }
});

async function readClipboard(box) {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (t) return t;
  } catch (e) { dlog('буфер обмена: ' + e); }
  addLog(box, '⚠ не удалось взять текст из буфера обмена (разрешите доступ или вставьте текст в поле вручную)', 'err');
  return '';
}

// ====================================================================
//                            ПЕРЕВОДЧИК
// ====================================================================
const tLog = $('#t-log');
const tVoice = voiceBlock('t', () => applyTrans());
let curIn = '', curOut = '', lastFrag = 0, lastSpeaking = 0;

function readTrans() {
  return { l1: $('#t-l1').value.trim() || 'русский', l2: $('#t-l2').value.trim() || 'английский', mode: $('#t-mode').value,
    voice: tVoice.name(), job: $('#t-job').value.trim(), tone: $('#t-tone').value.trim(), engine: $('#t-engine').value };
}

function flushTurn() {
  const heard = cleanTranscript(curIn), said = cleanTranscript(curOut);
  curIn = curOut = '';
  if (heard) addLog(tLog, '🎤 ' + heard);
  if (said) addLog(tLog, '⇒ ' + said, 'out', !heard);
}

const trans = new LiveSession({
  name: 'translator', getKey, url: MOCK || DEFAULT_URL, cfg: readTrans(),
  log: m => dlog('[переводчик] ' + m),
  emit: (k, p) => {
    if (k === 'audio') player.add(p);
    else if (k === 'in') { curIn += p; lastFrag = Date.now(); }
    else if (k === 'out') { curOut += p; lastFrag = Date.now(); }
    else if (k === 'turn') flushTurn();
    else if (k === 'interrupted') player.clear();
    else if (k === 'latency') $('#t-lat').textContent = `первый звук: ${p.toFixed(0)} мс`;
    else if (k === 'error') logError(tLog, p);
    else if (k === 'info') addLog(tLog, 'ℹ ' + p, 'dim');
  },
  buildSetup: cfg => {
    const gen = { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } } };
    if (cfg.engine === 'translate') {
      // Live Translate: без системной инструкции, язык перевода — кодом; перевод только в одну сторону.
      const code = langCode(cfg.l2);
      if (!code) throw new Error(`для Live Translate язык «${cfg.l2}» не из списка — введите его код, например ka или pt-BR`);
      gen.translationConfig = { targetLanguageCode: code, echoTargetLanguage: false };
      return { sync: true, setup: { model: 'models/' + TRANSLATE_MODEL, generationConfig: gen,
        inputAudioTranscription: {}, outputAudioTranscription: {} } };
    }
    return { sync: false, setup: { model: 'models/' + MODEL, generationConfig: gen,
      systemInstruction: { parts: [{ text: interpreterPrompt(cfg) }] },
      inputAudioTranscription: {}, outputAudioTranscription: {} } };
  },
});
trans.active = false;                    // активна одна вкладка за раз, чтобы не держать два соединения

function applyTrans() {
  const sync = $('#t-engine').value === 'translate';
  for (const id of ['#t-mode', '#t-job', '#t-tone', '#t-text', '#t-say', '#t-paste']) $(id).disabled = sync;
  tVoice.setExtra(sync ? 'Live Translate: исходный язык определяется сам, перевод идёт на «Язык 2» почти синхронно, пока вы говорите. ' +
    'Недоступны: текст, режим «в обе стороны», профессия и интонация. Язык 2 — из списка или код (ka, pt-BR).' : '');
  trans.setCfg(readTrans());
}
const applyTransSoon = debounced(applyTrans);
for (const id of ['#t-l1', '#t-l2', '#t-job', '#t-tone']) $(id).addEventListener('input', applyTransSoon);
for (const id of ['#t-engine', '#t-mode']) $(id).addEventListener('change', applyTrans);
$('#t-swap').onclick = () => { const a = $('#t-l1'), b = $('#t-l2'); [a.value, b.value] = [b.value, a.value]; applyTrans(); };
$('#t-phones').onchange = () => dlog('режим: ' + ($('#t-phones').checked ? 'наушники, можно перебивать' : 'полудуплекс (микрофон глохнет при переводе)'));

async function transSay(text) {
  text = text.trim();
  if (!text) return;
  if (!getKey()) return needKey();
  const c = readTrans();
  if (c.l1.toLowerCase() === c.l2.toLowerCase()) return addLog(tLog, '⚠ выберите два разных языка', 'err');
  if (c.engine === 'translate') return addLog(tLog, '⚠ Live Translate принимает только речь с микрофона. Для текста выберите движок Gemini 3.8 Live.', 'err');
  await player.init();
  applyTrans();
  trans.say(text);
  addLog(tLog, '▶ ' + text);
  $('#t-text').value = '';
}
$('#t-say').onclick = () => transSay($('#t-text').value);
$('#t-paste').onclick = async () => {
  const t = await readClipboard(tLog);
  if (t) { $('#t-text').value = t; transSay(t); }
};
$('#t-stop').onclick = () => { player.clear(); trans.stop(); addLog(tLog, '■ остановлено', 'dim'); };
$('#t-text').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) { e.preventDefault(); transSay($('#t-text').value); }
});

// ----- микрофон -----
const transSpeaking = () => (trans.sync ? Date.now() - trans.voiceOutAt < 600 : player.speaking());
function onMicChunk(int16) {
  const now = Date.now();
  if (transSpeaking()) lastSpeaking = now;
  // полудуплекс: пока звучит перевод (и ещё 0,7 с после), вместо звука шлём тишину — чтобы модель не услышала саму себя
  const chunk = (!$('#t-phones').checked && now - lastSpeaking < 700) ? new Int16Array(int16.length) : int16;
  trans.sendAudio(chunk);
}
function setMicUi(on) { $('#t-mic').textContent = on ? '🎤 Выключить микрофон' : '🎤 Включить микрофон'; }
async function startMic() {
  if (!getKey()) return needKey();
  const c = readTrans();
  if (c.l1.toLowerCase() === c.l2.toLowerCase()) return addLog(tLog, '⚠ выберите два разных языка', 'err');
  try {
    await player.init();
    applyTrans();
    trans.warm();
    await mic.start(onMicChunk);
    setMicUi(true);
    lockScreen(true);
    dlog('микрофон включён');
  } catch (e) {
    dlog('микрофон: ' + e);
    addLog(tLog, '⚠ микрофон: ' + (e && e.name === 'NotAllowedError' ? 'доступ запрещён — разрешите микрофон для этого сайта в настройках браузера' : (e.message || e)), 'err');
    await mic.stop();
  }
}
async function stopMic() {
  if (!mic.on) return;
  await mic.stop();
  setMicUi(false);
  lockScreen(false);
  dlog('микрофон выключен');
}
$('#t-mic').onclick = () => (mic.on ? stopMic() : startMic());

// ====================================================================
//                          НАСТРОЙКИ И ОБЩЕЕ
// ====================================================================
function needKey() {
  setTab('settings');
  $('#key-out').textContent = 'Сначала введите ключ Gemini API и нажмите «Сохранить».';
}

$('#key').value = store.get('gemini_key');
$('#key-save').onclick = () => {
  const k = $('#key').value.trim();
  if (!k) { $('#key-out').textContent = 'Ключ пуст.'; return; }
  store.set('gemini_key', k);
  $('#key-out').textContent = 'Ключ сохранён на этом устройстве. Проверьте подключение.';
  active().warm();
};
$('#key-forget').onclick = () => { store.del('gemini_key'); $('#key').value = ''; $('#key-out').textContent = 'Ключ удалён с этого устройства.'; };
$('#key-test').onclick = async () => {
  if (!getKey()) { $('#key-out').textContent = 'Сначала введите и сохраните ключ.'; return; }
  const s = active();
  $('#key-out').textContent = 'Проверяю…';
  const t0 = performance.now();
  s.wsCfg = null;                         // принудительно новое подключение
  await s.warm();
  $('#key-out').textContent = s._alive() ? `Подключение работает (${(performance.now() - t0).toFixed(0)} мс).` : 'Не удалось подключиться — подробности в журнале на вкладках «Студия»/«Переводчик».';
};
$('#log-copy').onclick = async () => {
  try { await navigator.clipboard.writeText(debugLog.join('\n')); $('#key-out').textContent = 'Журнал скопирован.'; }
  catch (e) { $('#key-out').textContent = 'Не удалось скопировать — используйте «Скачать журнал».'; }
};
$('#log-save').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([debugLog.join('\n')], { type: 'text/plain;charset=utf-8' }));
  a.download = `voice-studio-${new Date().toISOString().slice(0, 10)}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$('#version').textContent = `Версия ${VERSION}.`;

// ----- согласие на передачу данных -----
const consent = $('#consent');
function askConsent() { consent.hidden = false; }
$('#consent-ok').onclick = () => { store.set('consent', '1'); consent.hidden = true; if (!getKey()) needKey(); };
$('#consent-reset').onclick = () => { store.del('consent'); askConsent(); };

// ----- вкладки -----
let current = 'studio';
const active = () => (current === 'trans' ? trans : studio);
function setTab(name) {
  current = name === 'settings' ? current : name;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const n of ['studio', 'trans', 'settings']) $('#tab-' + n).hidden = n !== name;
  if (name === 'studio') { trans.suspend(); stopMic(); studio.resume(); }
  else if (name === 'trans') { studio.suspend(); trans.resume(); }
}
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => setTab(b.dataset.tab);

// ----- статус -----
function paint(el, kind, text) { el.className = 'status ' + kind; el.textContent = text; }
setInterval(() => {
  const s = studio;
  if (s.phase === 'connecting') paint($('#s-status'), 'warn', '● подключение…');
  else if (s.phase === 'generating' || player.speaking() || s.pending) paint($('#s-status'), 'busy', '● говорю…');
  else paint($('#s-status'), 'ok', '● готово');
  const t = trans;
  if (t.phase === 'connecting') paint($('#t-status'), 'warn', '● подключение…');
  else if (transSpeaking() || t.phase === 'generating' || t.pending) paint($('#t-status'), 'busy', '● перевожу…');
  else if (mic.on) paint($('#t-status'), 'ok', '● слушаю…');
  else paint($('#t-status'), 'ok', '● готово');
  if ((curIn || curOut) && Date.now() - lastFrag > 1500) flushTurn();   // у Live Translate нет границ реплик — собираем по паузе
}, 120);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    dlog('страница снова видима');
    if (player.ctx && player.ctx.state !== 'running') player.ctx.resume().catch(() => {});
    active().recover();
  }
});

// ----- запуск -----
studio.start(); trans.start();
applyStudio(); applyTrans();
if (!store.get('consent') && !MOCK) askConsent();
else if (!getKey()) needKey();
studio.resume();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(e => dlog('service worker: ' + e));
}
dlog(`запуск, версия ${VERSION}, ${navigator.userAgent}`);
window.__app = { studio, trans, player, mic, debugLog };      // для отладки и тестов
