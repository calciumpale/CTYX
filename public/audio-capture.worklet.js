// Streaming box-filter resampling preserves timing across render quanta, including
// hardware that ignores the requested 16 kHz AudioContext rate (e.g. 44.1/48 kHz).
class PCM16CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = options.processorOptions || {};
    this.ratio = sampleRate / (settings.targetSampleRate || 16000);
    this.frameSamples = settings.frameSamples || 320;
    this.frame = new ArrayBuffer(this.frameSamples * 2);
    this.view = new DataView(this.frame);
    this.index = 0;
    this.weight = 0;
    this.total = 0;
    this.stopped = false;
    this.port.onmessage = event => { if (event.data?.type === 'stop') this.stopped = true; };
  }

  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let value = 0;
      for (const channel of channels) value += channel[index] || 0;
      value /= channels.length;
      let remaining = 1;
      while (remaining > 1e-8) {
        const used = Math.min(remaining, this.ratio - this.weight);
        this.total += value * used;
        this.weight += used;
        remaining -= used;
        if (this.weight + 1e-8 >= this.ratio) {
          const sample = Math.max(-1, Math.min(1, this.total / this.ratio));
          this.view.setInt16(this.index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
          this.index++;
          this.weight = 0;
          this.total = 0;
          if (this.index === this.frameSamples) {
            this.port.postMessage(this.frame, [this.frame]);
            this.frame = new ArrayBuffer(this.frameSamples * 2);
            this.view = new DataView(this.frame);
            this.index = 0;
          }
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm16-capture', PCM16CaptureProcessor);
