// Звук в браузере: воспроизведение потока (24 кГц) и запись микрофона (16 кГц) через AudioWorklet.
const AC = window.AudioContext || window.webkitAudioContext;

export class Player {
  constructor() { this.ctx = null; this.next = 0; this.sources = new Set(); this.rate = 24000; this.gain = null; }

  // Вызывать из обработчика нажатия кнопки: iOS/Safari разрешают звук только после жеста пользователя.
  async init() {
    if (!this.ctx) {
      this.ctx = new AC();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (e) { /* ignore */ } }
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (e) { /* ignore */ }
  }

  add(int16) {
    if (!this.ctx || !int16.length) return;
    const buf = this.ctx.createBuffer(1, int16.length, this.rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const start = Math.max(this.ctx.currentTime + 0.03, this.next);
    src.start(start);
    this.next = start + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  clear() {
    for (const s of this.sources) { try { s.stop(); } catch (e) { /* ignore */ } }
    this.sources.clear();
    this.next = 0;
  }

  speaking() { return !!this.ctx && this.next > this.ctx.currentTime + 0.02; }
}

export class Mic {
  constructor() { this.stream = null; this.ctx = null; this.node = null; this.on = false; }

  // onChunk(Int16Array) вызывается каждые 100 мс с 1600 отсчётами 16 кГц.
  async start(onChunk) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AC();
    await this.ctx.resume();
    await this.ctx.audioWorklet.addModule('mic-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm16k');
    this.node.port.onmessage = e => onChunk(new Int16Array(e.data));
    const mute = this.ctx.createGain();          // узел должен быть подключён к выходу, иначе браузер его не вызывает
    mute.gain.value = 0;
    src.connect(this.node);
    this.node.connect(mute);
    mute.connect(this.ctx.destination);
    this.on = true;
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (e) { /* ignore */ }
  }

  async stop() {
    this.on = false;
    try { if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); } } catch (e) { /* ignore */ }
    try { if (this.stream) this.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
    try { if (this.ctx) await this.ctx.close(); } catch (e) { /* ignore */ }
    this.stream = this.ctx = this.node = null;
  }
}
