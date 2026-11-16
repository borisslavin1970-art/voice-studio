// AudioWorklet: берёт звук микрофона с родной частотой устройства и отдаёт 16-бит PCM 16 кГц блоками по 1600 отсчётов.
class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;   // входных отсчётов на один выходной
    this.t = 0;                        // позиция следующего выходного отсчёта относительно начала блока
    this.last = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
  }

  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (!x) return true;
    let t = this.t;
    while (t < x.length - 1) {          // линейная интерполяция между соседними отсчётами
      const i = Math.floor(t);
      const f = t - i;
      const a = i >= 0 ? x[i] : this.last;
      const v = a + (x[i + 1] - a) * f;
      this.out[this.n++] = Math.max(-1, Math.min(1, v)) * 32767;
      if (this.n === 1600) { this.port.postMessage(this.out.buffer.slice(0)); this.n = 0; }
      t += this.ratio;
    }
    this.t = t - x.length;
    this.last = x[x.length - 1];
    return true;
  }
}
registerProcessor('pcm16k', Pcm16k);
