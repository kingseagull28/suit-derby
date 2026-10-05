/**
 * Subtle sound effects made with the Web Audio API (no audio files to load).
 * Audio starts only after the first user interaction, as browsers require.
 */
window.Sound = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('sd_muted') === '1'; } catch {}

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  document.addEventListener('pointerdown', () => ac(), { once: true });

  function tone(freq, start, dur, { type = 'sine', gain = 0.12, slide = 0 } = {}) {
    const c = ac(); if (!c || muted) return;
    const t = c.currentTime + start;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function noise(start, dur, gain = 0.08, freq = 2000) {
    const c = ac(); if (!c || muted) return;
    const t = c.currentTime + start;
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = c.createBufferSource();
    const f = c.createBiquadFilter();
    const g = c.createGain();
    src.buffer = buf; f.type = 'bandpass'; f.frequency.value = freq;
    g.gain.value = gain;
    src.connect(f).connect(g).connect(c.destination);
    src.start(t);
  }

  return {
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      try { localStorage.setItem('sd_muted', muted ? '1' : '0'); } catch {}
      return muted;
    },
    click() { tone(660, 0, 0.06, { type: 'triangle', gain: 0.06 }); },
    card() { noise(0, 0.09, 0.12, 3500); },
    hooves() { [0, 0.11, 0.22, 0.33].forEach((t, i) => tone(i % 2 ? 110 : 90, t + 0.05, 0.08, { type: 'triangle', gain: 0.16, slide: -40 })); },
    tick() { tone(880, 0, 0.08, { type: 'square', gain: 0.04 }); },
    go() { tone(523, 0, 0.15, { type: 'square', gain: 0.06 }); tone(784, 0.15, 0.35, { type: 'square', gain: 0.06 }); },
    confirm() { tone(520, 0, 0.08, { gain: 0.08 }); tone(780, 0.08, 0.14, { gain: 0.08 }); },
    error() { tone(200, 0, 0.18, { type: 'sawtooth', gain: 0.05, slide: -60 }); },
    fanfare() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.13, i === 3 ? 0.6 : 0.16, { type: 'square', gain: 0.06 })); },
    lose() { [392, 330, 262].forEach((f, i) => tone(f, i * 0.16, 0.22, { type: 'triangle', gain: 0.07 })); }
  };
})();
