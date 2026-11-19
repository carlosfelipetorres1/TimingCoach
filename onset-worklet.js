// Drum hit (onset) detector. Runs on the audio thread.
// Posts {type:'onset', time} with the hit time on the AudioContext clock,
// and {type:'level', peak} ~30x per second for the input meter.
class OnsetDetector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.floor = 0.007;      // absolute level a hit must exceed
    this.ratio = 3.6;        // how far above the background level a hit must jump
    this.refractory = 0.05;  // s: ignore re-triggers within 50 ms (flams, ringing)

    // ~100 Hz high-pass to remove rumble / DC
    const rc = 1 / (2 * Math.PI * 100);
    const dt = 1 / sampleRate;
    this.hpA = rc / (rc + dt);
    this.hpPrevX = 0;
    this.hpPrevY = 0;

    this.fast = 0; // peak envelope, ~4 ms release
    this.slow = 0; // background level, ~300 ms average
    this.fastRel = Math.exp(-1 / (0.004 * sampleRate));
    this.slowC = Math.exp(-1 / (0.3 * sampleRate));

    this.armed = true;
    this.hitPeak = 0;
    this.lastOnset = -1;

    this.levelPeak = 0;
    this.levelCount = 0;
    this.levelEvery = Math.round(sampleRate / 30);

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.floor === 'number') this.floor = d.floor;
      if (typeof d.ratio === 'number') this.ratio = d.ratio;
    };
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;

    const n = ch.length;
    const sr = sampleRate;
    const t0 = currentTime;

    for (let i = 0; i < n; i++) {
      const x = ch[i];
      const y = this.hpA * (this.hpPrevY + x - this.hpPrevX);
      this.hpPrevX = x;
      this.hpPrevY = y;
      const a = y < 0 ? -y : y;

      this.fast = a > this.fast ? a : this.fast * this.fastRel;
      this.slow = this.slowC * this.slow + (1 - this.slowC) * a;
      if (a > this.levelPeak) this.levelPeak = a;

      const t = t0 + i / sr;
      if (this.armed) {
        if (
          this.fast > this.floor &&
          this.fast > this.ratio * this.slow &&
          t - this.lastOnset > this.refractory
        ) {
          this.armed = false;
          this.hitPeak = this.fast;
          this.lastOnset = t;
          this.port.postMessage({ type: 'onset', time: t, peak: this.fast });
        }
      } else {
        if (this.fast > this.hitPeak) this.hitPeak = this.fast;
        // re-arm once the hit has decayed
        if (
          t - this.lastOnset > this.refractory &&
          (this.fast < this.hitPeak * 0.35 || this.fast < this.floor)
        ) {
          this.armed = true;
        }
      }
    }

    this.levelCount += n;
    if (this.levelCount >= this.levelEvery) {
      this.port.postMessage({ type: 'level', peak: this.levelPeak });
      this.levelPeak = 0;
      this.levelCount = 0;
    }
    return true;
  }
}

registerProcessor('onset-detector', OnsetDetector);
