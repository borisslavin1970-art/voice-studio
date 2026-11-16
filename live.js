// Соединение с Gemini Live API (WebSocket из браузера) с теми же защитами, что и в Python-версии:
// заранее подготовленное соединение, переподключение при смене настроек, таймауты, один повтор,
// обновление старой сессии, контроль мёртвого соединения в простое.
export const DEFAULT_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export class LiveError extends Error {}
class TimeoutErr extends Error {}
class ClosedErr extends Error {}
class Cancelled extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dec = new TextDecoder();

function deferred() {
  const d = {};
  d.promise = new Promise((res, rej) => { d.resolve = res; d.reject = rej; });
  d.promise.catch(() => {});          // чтобы отклонение без ожидающих не давало «unhandled rejection»
  return d;
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new TimeoutErr()), ms); })])
    .finally(() => clearTimeout(t));
}

export function b64FromInt16(buf) {
  const bytes = buf instanceof Int16Array ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function int16FromB64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

export function describeError(e) {
  if (e instanceof TimeoutErr) return 'нет ответа от модели (таймаут) — соединение будет создано заново';
  if (e instanceof ClosedErr) return 'соединение закрыто сервером — будет создано заново';
  const m = String(e && e.message || e);
  if (/api key not valid|API_KEY_INVALID/i.test(m)) return 'ключ API не принят: проверьте его в «Настройках»';
  if (/exhausted|quota/i.test(m)) return 'превышена квота запросов/токенов (подождите минуту): ' + m;
  return m;
}

export class LiveSession {
  FIRST_AUDIO_TIMEOUT = 12000;
  IDLE_TIMEOUT = 15000;
  MAX_SESSION_AGE = 600000;
  HOUSEKEEP_EVERY = 15000;

  // buildSetup(cfg) -> { setup, sync }; emit(kind, payload); log(text)
  constructor({ name = 'session', getKey, url = DEFAULT_URL, emit = () => {}, log = () => {}, buildSetup, cfg = {} }) {
    Object.assign(this, { name, getKey, url, emit, log, buildSetup, cfg });
    this.ws = null; this.pendingWs = null; this.wsCfg = null; this.wsSince = 0;
    this.phase = 'idle';              // idle | connecting | generating
    this.pending = 0; this.gen = 0; this.chain = Promise.resolve();
    this.wanted = false; this.lastFail = 0; this.active = true;
    this.turnDone = false; this.tText = null; this.gotAudio = false; this.lastAudioAt = 0;
    this.setupWaiter = null; this.timer = null;
    this.sync = false; this.voiceOutAt = 0;
  }

  start() { if (!this.timer) this.timer = setInterval(() => this._housekeep(), this.HOUSEKEEP_EVERY); }
  suspend() { this.active = false; this.wanted = false; this.gen++; this._close(); this.phase = 'idle'; }
  resume() { this.active = true; this.warm(); }
  recover() { if (this.active && this.wanted) this._housekeep(); }

  setCfg(cfg) {
    if (JSON.stringify(cfg) !== JSON.stringify(this.cfg)) {
      this.log(`настройки изменены: ${JSON.stringify(cfg)}`);
      this.cfg = cfg;
      this.warm();                    // переподключаемся заранее, пока пользователь печатает
    }
  }

  warm() { if (!this.getKey() || !this.active) return Promise.resolve(); return this._enqueue(g => this._ensure(g)); }

  say(text) {
    if (!this.getKey()) { this.emit('error', 'Не задан ключ API: откройте вкладку «Настройки»'); return Promise.resolve(); }
    this.log(`задание: озвучить/перевести ${text.length} симв.`);
    return this._enqueue(async g => { await this._ensure(g); await this._speakWithRetry(text, g); });
  }

  stop() {
    this.log('нажат «Стоп»');
    this.gen++;
    (async () => { await this._close(); this.phase = 'idle'; this.warm(); })();
  }

  // ---- служебное ----
  _enqueue(fn) {
    const g = this.gen;
    this.pending++;
    const run = async () => {
      if (g !== this.gen) return;
      try { await fn(g); }
      catch (e) {
        if (e instanceof Cancelled || g !== this.gen) return;
        this.log('ошибка задания: ' + (e && e.stack || e));
        if (this.phase === 'connecting') this.lastFail = Date.now();
        await this._close();
        this.phase = 'idle';
        this.emit('error', describeError(e));
      }
    };
    const p = this.chain.then(run).finally(() => { this.pending--; });
    this.chain = p.catch(() => {});
    return p;
  }

  _alive() { return !!this.ws && this.ws.readyState === 1; }

  _housekeep() {
    if (!this.active || !this.wanted || this.pending > 0) return;
    const dead = !this._alive();
    const old = !dead && Date.now() - this.wsSince > this.MAX_SESSION_AGE;
    if (!(dead || old)) return;
    if (dead && Date.now() - this.lastFail < 60000) return;      // не долбим сервер, если он только что отказал
    const reason = dead ? 'соединение потеряно' : 'плановое обновление сессии';
    this.log(`простой: ${reason} — подключаюсь заново`);
    this.emit('info', `${reason} — подключаюсь заново`);
    this.warm();
  }

  async _ensure(g) {
    let why = null;
    if (!this.ws) why = 'нет соединения';
    else if (JSON.stringify(this.wsCfg) !== JSON.stringify(this.cfg)) why = 'настройки изменились';
    else if (!this._alive()) why = 'соединение было закрыто';
    else if (Date.now() - this.wsSince > this.MAX_SESSION_AGE) why = 'сессия устарела';
    if (why) {
      this.log('переподключение: ' + why);
      await this._connect(this.cfg, g);
    }
  }

  async _close() {
    const ws = this.ws || this.pendingWs;
    this.ws = null; this.pendingWs = null; this.wsCfg = null;
    if (ws) { try { ws.onmessage = null; ws.close(1000); } catch (e) { /* ignore */ } }
  }

  async _connect(cfg, g) {
    await this._close();
    this.phase = 'connecting';
    const t0 = performance.now();
    const { setup, sync } = this.buildSetup(cfg);
    const key = this.getKey();
    if (!key) throw new LiveError('Не задан ключ API: откройте вкладку «Настройки»');
    this.log(`подключение: ${JSON.stringify(cfg)}`);
    const ws = new WebSocket(`${this.url}${this.url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`);
    ws.binaryType = 'arraybuffer';
    this.pendingWs = ws;
    const opened = deferred();
    this.setupWaiter = deferred();
    const waiter = this.setupWaiter;
    ws.onopen = () => opened.resolve();
    ws.onerror = () => {};            // подробности придут в onclose
    ws.onmessage = ev => this._onMessage(ws, ev);
    ws.onclose = ev => {
      const why = `код ${ev.code}${ev.reason ? ': ' + ev.reason : ''}`;
      this.log('сокет закрыт: ' + why);
      opened.reject(new LiveError('не удалось открыть соединение (' + why + ')'));
      waiter.reject(new LiveError(ev.reason || `соединение закрыто (${why})`));
      if (ws === this.ws) { this.emit('closed', why); }
    };
    try {
      await withTimeout(opened.promise, 15000);
      ws.send(JSON.stringify({ setup }));
      await withTimeout(waiter.promise, 15000);
    } catch (e) {
      try { ws.close(); } catch (_) { /* ignore */ }
      if (this.pendingWs === ws) this.pendingWs = null;
      throw e;
    }
    if (g !== this.gen) { try { ws.close(); } catch (_) { /* ignore */ } throw new Cancelled(); }
    this.ws = ws; this.pendingWs = null; this.wsCfg = cfg; this.wsSince = Date.now();
    this.wanted = true; this.sync = !!sync; this.phase = 'idle';
    this.log(`подключено за ${(performance.now() - t0).toFixed(0)} мс`);
  }

  _onMessage(ws, ev) {
    if (ws !== this.ws && ws !== this.pendingWs) return;
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : dec.decode(ev.data)); } catch (e) { return; }
    if (m.setupComplete !== undefined) { this.setupWaiter && this.setupWaiter.resolve(); return; }
    if (m.goAway) { this.log('сервер сообщил goAway: ' + JSON.stringify(m.goAway)); this.wsSince = 0; }
    const sc = m.serverContent;
    if (!sc) return;
    const now = Date.now();
    for (const p of (sc.modelTurn && sc.modelTurn.parts) || []) {
      if (p.inlineData && p.inlineData.data) {
        const pcm = int16FromB64(p.inlineData.data);
        let sum = 0;
        for (let i = 0; i < pcm.length; i += 8) sum += pcm[i] * pcm[i];
        if (Math.sqrt(sum / Math.max(1, Math.ceil(pcm.length / 8))) > 200) this.voiceOutAt = now;
        this.gotAudio = true; this.lastAudioAt = now;
        if (this.tText != null) { this.emit('latency', performance.now() - this.tText); this.tText = null; }
        this.emit('audio', pcm);
      }
    }
    if (sc.inputTranscription && sc.inputTranscription.text != null) this.emit('in', sc.inputTranscription.text);
    if (sc.outputTranscription && sc.outputTranscription.text != null) this.emit('out', sc.outputTranscription.text);
    if (sc.interrupted) this.emit('interrupted');
    if (sc.turnComplete) { this.turnDone = true; this.emit('turn'); }
  }

  // ---- отправка ----
  sendAudio(int16) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || this.phase === 'connecting' || ws.bufferedAmount > 500000) return false;
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64FromInt16(int16), mimeType: 'audio/pcm;rate=16000' } } }));
    return true;
  }

  async _speakWithRetry(text, g) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { await this._speak(text, g); return; }
      catch (e) {
        if (!(e instanceof TimeoutErr || e instanceof ClosedErr)) throw e;
        this.log(`сбой при озвучке (попытка ${attempt}): ${describeError(e)}`);
        if (attempt === 2 || this.gotAudio) throw e;
        this.emit('info', 'модель не ответила — пересоздаю соединение и повторяю');
        await this._connect(this.cfg, g);
      }
    }
  }

  async _speak(text, g) {
    this.gotAudio = false;
    const pieces = chunksOf(text);
    for (let i = 0; i < pieces.length; i++) {
      if (!this._alive()) throw new ClosedErr();
      this.phase = 'generating';
      this.turnDone = false;
      const t0 = Date.now();
      this.tText = performance.now();
      this.ws.send(JSON.stringify({ realtimeInput: { text: pieces[i] } }));
      while (!this.turnDone) {
        await sleep(50);
        if (g !== this.gen) throw new Cancelled();
        if (!this._alive()) throw new ClosedErr();
        const got = this.gotAudio && this.lastAudioAt >= t0;
        if (!got && Date.now() - t0 > this.FIRST_AUDIO_TIMEOUT) {
          this.log(`кусок ${i + 1}/${pieces.length}: нет звука от модели ${this.FIRST_AUDIO_TIMEOUT / 1000} с`);
          throw new TimeoutErr();
        }
        if (got && Date.now() - this.lastAudioAt > this.IDLE_TIMEOUT) {
          this.log(`кусок ${i + 1}/${pieces.length}: пауза ${this.IDLE_TIMEOUT / 1000} с посреди речи`);
          throw new TimeoutErr();
        }
      }
      this.log(`кусок ${i + 1}/${pieces.length} готов за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
    }
    this.tText = null;
    this.phase = 'idle';
  }
}

import { chunks as chunksOf } from './prompts.js';
