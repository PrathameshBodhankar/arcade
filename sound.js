/*
 * Tiny shared WebAudio synth for the Arcade games (no audio files).
 * iOS Safari safe: unlocked on first gesture, resumes after interruptions.
 * Usage: ArcadeSound.init() inside a user gesture, then ArcadeSound.tone(...)
 */
(function () {
  'use strict';
  const KEY = 'arcade.muted';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  const S = {
    ctx: null,
    master: null,
    muted: store.get(KEY) === '1',
    VOLUME: 0.3,

    init() {
      if (this.ctx) {
        if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : this.VOLUME;
        this.master.connect(this.ctx.destination);
        const src = this.ctx.createBufferSource();          // silent unlock for iOS
        src.buffer = this.ctx.createBuffer(1, 1, 22050);
        src.connect(this.ctx.destination);
        src.start(0);
        if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      } catch (e) { this.ctx = null; }
    },

    setMuted(m) {
      this.muted = m;
      store.set(KEY, m ? '1' : '0');
      if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.VOLUME, this.ctx.currentTime, 0.01);
    },

    tone(freq, dur, opts) {
      const o0 = opts || {};
      if (!this.ctx || this.muted) return;
      const t0 = this.ctx.currentTime + (o0.delay || 0);
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = o0.type || 'square';
      o.frequency.setValueAtTime(freq, t0);
      if (o0.slide) o.frequency.exponentialRampToValueAtTime(o0.slide, t0 + dur);
      g.gain.setValueAtTime(o0.vol == null ? 0.4 : o0.vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(g).connect(this.master);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    },

    noise(dur, vol, cutoff) {
      if (!this.ctx || this.muted) return;
      const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = this.ctx.createBufferSource();
      const f = this.ctx.createBiquadFilter();
      const g = this.ctx.createGain();
      f.type = 'lowpass'; f.frequency.value = cutoff || 1800;
      g.gain.value = vol;
      src.buffer = buf;
      src.connect(f).connect(g).connect(this.master);
      src.start();
    },

    // Wire a mute button (aria-pressed) + keep it in sync.
    bindButton(btn) {
      const sync = () => {
        btn.setAttribute('aria-pressed', String(this.muted));
        btn.setAttribute('aria-label', this.muted ? 'Unmute sound' : 'Mute sound');
      };
      btn.addEventListener('click', () => { this.init(); this.setMuted(!this.muted); sync(); btn.blur(); });
      sync();
      return sync;
    },
  };

  window.addEventListener('touchend', () => S.init(), { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ctx) S.ctx.resume().catch(() => {}); });
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  window.ArcadeSound = S;
})();
