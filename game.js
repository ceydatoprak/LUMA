/* ============================================================
   FLUX — a movement-first spirit traversal game
   ------------------------------------------------------------
   The player is a small spirit creature. It cannot walk. It moves
   in directional bursts: hold to wind up, drag to aim, release to
   leap. Gravity pulls it into arcs, ordinary surfaces catch it
   rather than bounce it, and the interesting movement comes from
   what it can do while airborne — cling to a wall, be caught and
   re-aimed by an energy node, or be thrown by a spirit spring.

   Sections
     1. Config, tuning & math
     2. Audio (Web Audio synthesis)
     3. Particles & shockwaves
     4. Level data
     5. World building
     6. Collision & motion
     7. Player (physics / state / visual / input contract)
     8. Game state machine
     9. Rendering
    10. Input
    11. Main loop
   ============================================================ */
(() => {
'use strict';

/* ============================================================
   1. CONFIG, TUNING & MATH
   ============================================================ */

const VW = 540, VH = 960;          // camera viewport, in world units
const STEP = 1 / 60;               // fixed physics step (seconds)

/* ---------------------------------------------------------------------------
   MOVEMENT TUNING
   ---------------------------------------------------------------------------
   One table, one source of truth. Nothing outside it invents a threshold.

   Speeds are world units per 1/60 s step; accelerations are units per step
   squared. For scale: the camera shows 540 x 960 units, the spirit is 13 units
   across, and a full-power leap rises a little over a quarter of a screen.

   The feel this describes is a creature, not a projectile. Ordinary surfaces
   have NO restitution at all — they absorb the normal component and let the
   spirit keep a fraction of its slide, which is what stops the whole world
   reading as a pinball table. Every strong rebound in the game is a deliberate
   object: a spring throws you, a node re-aims you. Those are the only two
   things that can add energy, so traversal stays readable.
--------------------------------------------------------------------------- */
const MOVE = {
  /* --- body ------------------------------------------------------------- */
  radius:       13,

  /* --- gravity & air -----------------------------------------------------
     Low gravity and a wide float band at the top of the arc. The spirit is
     meant to hang long enough that you can watch the arc happen and see where
     it is going, rather than being over before you have read it. */
  gravity:      0.46,   // downward acceleration per step
  floatBand:    4.4,    // |vy| under this counts as the top of the arc
  floatScale:   0.48,   // gravity multiplier there — a long, readable apex
  fallMax:      14.0,   // terminal velocity
  airDrag:      0.9975, // horizontal only; vertical is governed by gravity

  /* --- the burst ---------------------------------------------------------
     The gap between a weak and a strong leap is deliberately narrow. A short
     drag still travels somewhere useful, so a sloppy input costs distance, not
     the run — and a full drag is a longer leap, not a different mechanic. */
  burstMin:     11.5,   // ~70% of a full leap: never a wasted input
  burstMax:     16.5,   // full-commitment leap
  burstCurve:   0.2,    // 0 = linear power ramp, 1 = fully quadratic
  burstTime:    0.075,  // gravity-free snap right after release
  dragFull:     130,    // drag distance for full power
  dragDead:     7,      // under this a release is a cancel

  /* --- ordinary surfaces: catch, do not bounce --------------------------- */
  floorDot:     0.55,   // contact normal more vertical than this is a floor
  landHard:     9.0,    // impact speed that reads as a heavy landing
  slideKeep:    0.62,   // slide kept when arriving fast
  groundDrag:   0.84,   // per step once settled on a floor
  groundStop:   0.30,   // below this the spirit is parked
  ceilingKeep:  0.55,   // glancing a ceiling costs some slide, nothing more
  slop:         0.05,   // separation kept after a contact, to stay quiet

  /* --- landing assist ------------------------------------------------------
     A leap that comes down a hair short of a ledge is the most annoying way to
     fail, because the player did read the situation correctly. While falling
     near the top of a safe surface the spirit is nudged toward it — a gentle
     acceleration, well under what the player is already doing, so it reads as
     the character reaching for the edge and never as a snap. */
  assistReach:  46,     // how far past the edge the nudge still applies
  assistBand:   150,    // how far above a surface top the nudge starts
  assistPull:   0.90,   // sideways acceleration per step while assisting
  assistMax:    5.0,    // the most sideways speed the nudge may ever add

  /* --- wall cling ----------------------------------------------------------
     A wall is a safe place to stop and think, not a reaction test. Contact
     kills all speed, the grip holds with no slide at all for well over a
     second, and only then does it start to creep. */
  clingTime:    2.40,   // total hold before the wall lets go
  clingGrip:    1.50,   // seconds of full grip before the slide starts
  clingSlide:   2.0,    // downward slide speed once grip runs out
  clingKick:    0.30,   // outward push blended into a burst off a wall

  /* --- forgiveness -------------------------------------------------------- */
  coyote:       0.13,   // aim still works just after leaving a surface
  /* An early press is not a mistake, it is intent. A finger held down while
     the spirit is still in the air is answered the moment anything can answer
     it — the ground, a wall, or a node — so wanting to go again never costs a
     second press. It is generous because it only ever converts a press the
     player is still holding; a tap that is released is simply dropped. */
  buffer:       0.90,
  aimHold:      2.60,   // longest a wind-up may be held before it lapses

  /* --- energy nodes -------------------------------------------------------- */
  nodeReach:    130,    // generous catch radius — this is a mobile target
  nodePull:     0.30,   // per frame the node draws the spirit toward itself
  nodeBurst:    16.5,   // release speed at full power
  nodeMin:      12.0,   // release speed at no power (a node always throws)
  nodeCool:     2.40,   // seconds before a spent node can be used again

  /* --- spirit springs ------------------------------------------------------ */
  springSpeed:  19.5,   // launch speed along the spring's face
  springKeep:   0.18,   // sideways motion kept through the throw

  /* --- camera ---------------------------------------------------------------
     The view leads rather than follows. While aiming it slides toward where
     the leap is pointed and eases out, so the destination is on screen before
     the player commits — the single biggest fairness problem in the game was
     asking for leaps toward places that could not be seen. */
  camLead:      430,    // how far a full-power aim pulls the view forward
  camLeadMin:   190,    // ...and how far the weakest aim does
  camFollow:    8.0,    // view offset per unit of travel speed
  camEase:      0.11,   // normal follow smoothing
  camEaseAim:   0.16,   // slightly quicker while aiming, so it keeps up
  zoomAim:      0.68,   // furthest the view will pull back to frame a leap
  zoomFast:     0.88,   // view scale at top travel speed
  zoomEase:     0.08,
  camFrame:     165,    // breathing room kept around a framed leap
  camHold:      0.60,   // the spirit never sits further out than this much
                        // of the half-view: it stays in frame, in the rear third

  /* --- limits & failure ----------------------------------------------------- */
  speedMax:     34,     // hard clamp, for stability only
  hurtTime:     0.30,   // seconds of the dissolve before respawn
  respawnTime:  0.22,   // seconds of the reform before control returns
};

/* Power ramp: fine control low down, punch at the top. */
const burstCurve = (p) => p * (1 - MOVE.burstCurve) + p * p * MOVE.burstCurve;

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
const easeInOut = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ---- palette ------------------------------------------------------------
   The neon identity is kept, but colour is now pure atmosphere: it tells you
   what a thing IS, never what it will accept. */
const HUE = {
  spirit: { rgb: [150, 226, 255], hi: [240, 252, 255] },   // the player
  node:   { rgb: [255, 196, 108], hi: [255, 240, 208] },   // energy node
  spring: { rgb: [126, 255, 186], hi: [226, 255, 240] },   // spirit spring
  mote:   { rgb: [198, 160, 255], hi: [240, 228, 255] },   // checkpoint
  gate:   { rgb: [140, 230, 255], hi: [236, 252, 255] },   // level exit
  stone:  { rgb: [122, 150, 208], hi: [196, 220, 255] },   // ordinary surface
};
const DANGER = [255, 66, 116];
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y); c.arcTo(x + w, y, x + w, y + r, r);
  c.lineTo(x + w, y + h - r); c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h); c.arcTo(x, y + h, x, y + h - r, r);
  c.lineTo(x, y + r); c.arcTo(x, y, x + r, y, r);
  c.closePath();
}

/* ---- adaptive quality ---------------------------------------------------
   Only decoration scales. Physics, collision and input never change, so the
   game plays identically on a slow phone and a fast desktop. */
const Q = { level: 1, avg: 16.7, work: 0, bad: 0, good: 0, particleScale: 1 };

// backing-store budget in device pixels (see fit())
const PIXEL_BUDGET = 1100000;
const PIXEL_BUDGET_LOW = 700000;

function grad(store, key, make) {
  let g = store[key];
  if (g === undefined) g = store[key] = make();
  return g;
}

/* ============================================================
   2. AUDIO — small synth kit, unlocked on first interaction
   ============================================================ */

const Sfx = (() => {
  /* --------------------------------------------------------------------
     Soft, futuristic palette. Everything is sine / triangle / filtered
     noise through a shared low-pass and a short ambient send, so nothing
     can turn into an arcade beep. Nodes are created per voice (they are
     cheap and self-disposing) but the noise buffer, filters, compressor
     and delay network are built once.
     -------------------------------------------------------------------- */
  const MIX = {
    master: 0.42,
    burst:  0.5,
    spring: 0.5,
    node:   0.44,
    land:   0.3,
    cling:  0.34,
    mote:   0.4,
    gate:   0.5,
    fail:   0.36,
    ui:     0.22,
    sweep:  0.3,
  };

  let ctx = null, master = null, bus = null, air = null, noiseBuf = null;
  let on = true, ready = false, tension = null;
  let voices = 0;
  let lastLand = -1;

  function build() {
    if (ctx || !on) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { on = false; return null; }
    try { ctx = new AC(); } catch (e) { on = false; return null; }

    master = ctx.createGain();
    master.gain.value = MIX.master;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22; comp.knee.value = 26; comp.ratio.value = 6;
    comp.attack.value = 0.006; comp.release.value = 0.25;

    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 7200;
    tone.Q.value = 0.4;

    bus = ctx.createGain();
    bus.connect(tone); tone.connect(comp); comp.connect(master);
    master.connect(ctx.destination);

    air = ctx.createGain();
    air.gain.value = 0.3;
    const d1 = ctx.createDelay(0.5), d2 = ctx.createDelay(0.5);
    d1.delayTime.value = 0.085; d2.delayTime.value = 0.147;
    const fb = ctx.createGain(); fb.gain.value = 0.26;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass'; damp.frequency.value = 2600;
    air.connect(d1); d1.connect(d2); d2.connect(damp); damp.connect(fb);
    fb.connect(d1); damp.connect(bus);

    const n = Math.floor(ctx.sampleRate * 0.8);
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

    ready = true;
    return ctx;
  }

  function unlock() {
    build();
    if (ctx && ctx.state !== 'running') ctx.resume();
  }

  function out(node, send) {
    node.connect(bus);
    if (send) { const g = ctx.createGain(); g.gain.value = send; node.connect(g); g.connect(air); }
  }
  function done() { voices--; }

  function tone(o) {
    if (!ready || !on || voices > 14) return;
    const t = ctx.currentTime + (o.delay || 0);
    const dur = o.dur || 0.3;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.glide || dur));
    if (o.detune) osc.detune.value = o.detune;

    const g = ctx.createGain();
    const peak = Math.max(0.0004, o.peak || 0.1);
    const atk = o.attack || 0.014;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + atk);
    g.gain.exponentialRampToValueAtTime(peak * 0.28, t + atk + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    let node = osc;
    if (o.lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(o.lp, t);
      if (o.lp1) f.frequency.exponentialRampToValueAtTime(Math.max(60, o.lp1), t + dur);
      f.Q.value = o.q || 0.7;
      node.connect(f); node = f;
    }
    node.connect(g);
    out(g, o.send);
    voices++;
    osc.onended = done;
    osc.start(t); osc.stop(t + dur + 0.06);
  }

  function air_noise(o) {
    if (!ready || !on || voices > 14) return;
    const t = ctx.currentTime + (o.delay || 0);
    const dur = o.dur || 0.25;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = o.rate || 1;

    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.f0 || 900, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(80, o.f1), t + dur);
    f.Q.value = o.q || 0.9;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = o.cap || 5200;

    const g = ctx.createGain();
    const peak = Math.max(0.0004, o.peak || 0.05);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.attack || 0.012));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(f); f.connect(lp); lp.connect(g);
    out(g, o.send);
    voices++;
    src.onended = done;
    src.start(t); src.stop(t + dur + 0.05);
  }

  /* --- continuous wind-up tension: one voice, held, gently filtered --- */
  function tensionStart() {
    if (!ready || !on || tension) return;
    const osc = ctx.createOscillator(); osc.type = 'sine';
    const osc2 = ctx.createOscillator(); osc2.type = 'triangle';
    osc2.detune.value = 7;
    const g = ctx.createGain(); g.gain.value = 0.0001;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 700; f.Q.value = 3;
    osc.frequency.value = 96; osc2.frequency.value = 144;
    osc.connect(f); osc2.connect(f); f.connect(g); g.connect(bus);
    osc.start(); osc2.start();
    tension = { osc, osc2, g, f };
  }
  function tensionUpdate(p) {
    if (!tension) return;
    const t = ctx.currentTime;
    tension.osc.frequency.setTargetAtTime(78 + p * 150, t, 0.06);
    tension.osc2.frequency.setTargetAtTime(118 + p * 232, t, 0.06);
    tension.f.frequency.setTargetAtTime(420 + p * 1100, t, 0.07);
    tension.g.gain.setTargetAtTime(0.004 + p * 0.026, t, 0.06);
  }
  function tensionStop() {
    if (!tension) return;
    const t = ctx.currentTime;
    const { osc, osc2, g } = tension;
    g.gain.setTargetAtTime(0.0001, t, 0.04);
    osc.stop(t + 0.25); osc2.stop(t + 0.25);
    tension = null;
  }

  return {
    unlock, tensionStart, tensionUpdate, tensionStop,
    setMuted(v) { on = !v; if (master) master.gain.value = v ? 0 : MIX.master; },

    /* the spirit throwing itself: a low pulse and a rising breath */
    burst(p) {
      const v = MIX.burst;
      tone({ type: 'sine', f0: 92 + p * 36, f1: 188 + p * 96, dur: 0.3, glide: 0.13,
             peak: 0.2 * v, attack: 0.008, lp: 1400, lp1: 620, send: 0.12 });
      tone({ type: 'triangle', f0: 244 + p * 126, f1: 442 + p * 220, dur: 0.24, glide: 0.11,
             peak: 0.085 * v, attack: 0.012, lp: 2400, send: 0.16 });
      air_noise({ dur: 0.2, peak: 0.05 * v, f0: 620, f1: 2100 + p * 900, q: 0.7, cap: 4200, send: 0.2 });
    },

    /* meeting a surface: a soft, woody settle — never a click */
    land(hard) {
      const s = clamp(hard, 0, 1);
      const now = ready ? ctx.currentTime : 0;
      if (now - lastLand < 0.05) return;
      lastLand = now;
      const m = MIX.land * (0.4 + s * 0.6);
      tone({ type: 'sine', f0: 132 - s * 28, f1: 82, dur: 0.14, glide: 0.1,
             peak: 0.5 * m, attack: 0.005, lp: 760 });
      air_noise({ dur: 0.07, peak: 0.24 * m, f0: 520 + s * 500, f1: 260, q: 1.3, cap: 2600 });
    },

    /* taking hold of a wall: a short breath, almost a gasp */
    cling() {
      const v = MIX.cling;
      air_noise({ dur: 0.14, peak: 0.22 * v, f0: 1700, f1: 700, q: 1.1, cap: 4200, send: 0.2 });
      tone({ type: 'sine', f0: 320, f1: 250, dur: 0.14, glide: 0.1, peak: 0.2 * v, attack: 0.008, lp: 1800 });
    },

    /* an energy node taking hold: a warm bell that sits under the aim */
    nodeCatch() {
      const v = MIX.node;
      [523.3, 784].forEach((f, i) => {
        tone({ type: 'sine', f0: f * 0.94, f1: f, dur: 0.5 - i * 0.12, glide: 0.12,
               peak: (0.2 - i * 0.06) * v, attack: 0.008, delay: i * 0.02, lp: 4600, send: 0.4 });
      });
      air_noise({ dur: 0.3, peak: 0.06 * v, f0: 1600, f1: 4200, q: 0.8, cap: 5600, attack: 0.04, send: 0.4 });
    },

    /* a node releasing its charge */
    nodeFire(p) {
      const v = MIX.node;
      tone({ type: 'triangle', f0: 392, f1: 880 + p * 300, dur: 0.3, glide: 0.14,
             peak: 0.18 * v, attack: 0.006, lp: 3600, send: 0.3 });
      tone({ type: 'sine', f0: 110, f1: 210, dur: 0.24, glide: 0.1, peak: 0.24 * v, attack: 0.006, lp: 1000 });
      air_noise({ dur: 0.22, peak: 0.07 * v, f0: 900, f1: 3400, q: 0.7, cap: 5000, send: 0.3 });
    },

    /* a spring throwing the spirit: bassy, generous, with an upward tail */
    spring() {
      const v = MIX.spring;
      tone({ type: 'sine', f0: 72, f1: 146, dur: 0.3, glide: 0.11,
             peak: 0.36 * v, attack: 0.006, lp: 900, send: 0.12 });
      tone({ type: 'triangle', f0: 294, f1: 660, dur: 0.26, glide: 0.14,
             peak: 0.12 * v, attack: 0.012, lp: 2800, send: 0.24 });
      air_noise({ dur: 0.1, peak: 0.07 * v, f0: 1500, f1: 800, q: 1.1, cap: 4200 });
    },

    /* claiming a checkpoint mote: a small, clear chime */
    mote() {
      const v = MIX.mote;
      [659.3, 987.8].forEach((f, i) => {
        tone({ type: 'sine', f0: f, dur: 0.6 - i * 0.16, peak: (0.17 - i * 0.05) * v,
               attack: 0.006 + i * 0.004, delay: i * 0.05, lp: 5200, send: 0.45 });
      });
      air_noise({ dur: 0.3, peak: 0.1 * v, f0: 2600, f1: 1000, q: 1.1, cap: 6000, send: 0.4 });
    },

    /* the gate: a soft chord that opens upward, airy tail, no fanfare */
    gate() {
      const v = MIX.gate;
      [261.6, 392, 523.3, 659.3].forEach((f, i) => {
        tone({ type: 'sine', f0: f * 0.94, f1: f, dur: 1.0 - i * 0.1, glide: 0.3,
               peak: (0.17 - i * 0.03) * v, attack: 0.03 + i * 0.01,
               delay: i * 0.05, lp: 4600, send: 0.45 });
      });
      tone({ type: 'triangle', f0: 784, f1: 1046, dur: 0.6, glide: 0.35,
             peak: 0.045 * v, attack: 0.06, delay: 0.1, lp: 5400, send: 0.5 });
      air_noise({ dur: 0.7, peak: 0.05 * v, f0: 900, f1: 4200, q: 0.6, cap: 5600,
                  attack: 0.12, send: 0.5 });
    },

    /* coming apart — soft and short, because the retry is instant */
    fail() {
      const v = MIX.fail;
      tone({ type: 'sine', f0: 210, f1: 62, dur: 0.4, glide: 0.3,
             peak: 0.3 * v, attack: 0.008, lp: 1500, lp1: 220, send: 0.2 });
      tone({ type: 'triangle', f0: 314, f1: 96, dur: 0.3, glide: 0.22,
             peak: 0.1 * v, attack: 0.012, lp: 1200, send: 0.25 });
      air_noise({ dur: 0.32, peak: 0.07 * v, f0: 1700, f1: 240, q: 0.7, cap: 3400, send: 0.3 });
    },

    /* reforming at the last mote */
    respawn() {
      const v = MIX.mote;
      tone({ type: 'sine', f0: 196, f1: 392, dur: 0.34, glide: 0.2,
             peak: 0.2 * v, attack: 0.01, lp: 3000, send: 0.3 });
      air_noise({ dur: 0.26, peak: 0.06 * v, f0: 500, f1: 2600, q: 0.7, cap: 4600, attack: 0.05, send: 0.3 });
    },

    /* a refusal: a dull, polite thud */
    deny() {
      tone({ type: 'sine', f0: 190, f1: 140, dur: 0.16, glide: 0.1,
             peak: 0.1, attack: 0.006, lp: 700 });
      air_noise({ dur: 0.1, peak: 0.02, f0: 460, f1: 240, q: 1.4, cap: 2200 });
    },

    ui() {
      tone({ type: 'sine', f0: 660, f1: 520, dur: 0.075, glide: 0.06,
             peak: 0.34 * MIX.ui, attack: 0.006, lp: 2600, send: 0.16 });
    },

    sweep() {
      const v = MIX.sweep;
      air_noise({ dur: 0.5, peak: 0.07 * v, f0: 300, f1: 2600, q: 0.5, cap: 4200,
                  attack: 0.14, send: 0.35 });
      tone({ type: 'sine', f0: 110, f1: 240, dur: 0.44, glide: 0.34,
             peak: 0.16 * v, attack: 0.06, lp: 1200, send: 0.2 });
    },

    complete() {
      const v = MIX.gate;
      [261.6, 329.6, 392, 523.3].forEach((f, i) => {
        tone({ type: 'sine', f0: f, dur: 1.5, peak: 0.13 * v,
               attack: 0.12 + i * 0.03, delay: i * 0.08, lp: 4000, send: 0.5 });
      });
    },
  };
})();

/* ============================================================
   3. PARTICLES & SHOCKWAVES  (fixed pools, zero allocation)
   ============================================================ */

const PMAX = 72;
const parts = new Array(PMAX);
for (let i = 0; i < PMAX; i++) {
  parts[i] = { on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 2,
               col: HUE.spirit.rgb, drag: 0.94, shape: 0, ang: 0, spin: 0, len: 0,
               grow: 0, grav: 0 };
}
let pCursor = 0;
function newPart() {
  for (let i = 0; i < PMAX; i++) {
    const p = parts[(pCursor + i) % PMAX];
    if (!p.on) { pCursor = (pCursor + i + 1) % PMAX; return p; }
  }
  const p = parts[pCursor]; pCursor = (pCursor + 1) % PMAX; return p;
}

const RMAX = 12;
const rings = new Array(RMAX);
for (let i = 0; i < RMAX; i++) {
  rings[i] = { on: false, x: 0, y: 0, r0: 0, r1: 0, life: 0, max: 1, col: HUE.spirit.rgb, w: 3 };
}
let rCursor = 0;
function newRing() {
  for (let i = 0; i < RMAX; i++) {
    const r = rings[(rCursor + i) % RMAX];
    if (!r.on) { rCursor = (rCursor + i + 1) % RMAX; return r; }
  }
  const r = rings[rCursor]; rCursor = (rCursor + 1) % RMAX; return r;
}

const FX = {
  shock(x, y, r0, r1, dur, col, w) {
    const r = newRing();
    r.on = true; r.x = x; r.y = y; r.r0 = r0; r.r1 = r1; r.life = dur; r.max = dur;
    r.col = col; r.w = w || 3;
  },
  spark(x, y, ang, spread, speed, count, col, opt) {
    opt = opt || {};
    count = Math.max(1, Math.round(count * Q.particleScale));
    for (let i = 0; i < count; i++) {
      const p = newPart();
      const a = ang + rand(-spread, spread);
      const sp = speed * rand(0.35, 1);
      p.on = true; p.x = x + rand(-2, 2); p.y = y + rand(-2, 2);
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
      p.max = p.life = (opt.life || 0.5) * rand(0.6, 1.2);
      p.size = (opt.size || 2.4) * rand(0.6, 1.3);
      p.col = col; p.drag = opt.drag || 0.93;
      p.shape = opt.shape || 0;     // 0 dot, 1 streak, 2 ring-dot
      p.ang = a; p.spin = rand(-0.2, 0.2); p.len = opt.len || 10;
      p.grow = opt.grow || 0;
      p.grav = opt.grav || 0;
    }
  },
  implode(x, y, r, count, col, life) {
    count = Math.max(3, Math.round(count * Q.particleScale));
    for (let i = 0; i < count; i++) {
      const a = rand(0, TAU);
      const p = newPart();
      const d = r * rand(0.6, 1.25);
      p.on = true;
      p.x = x + Math.cos(a) * d; p.y = y + Math.sin(a) * d;
      const sp = d / (life * 60) * rand(0.9, 1.1);
      p.vx = -Math.cos(a) * sp; p.vy = -Math.sin(a) * sp;
      p.max = p.life = life * rand(0.8, 1);
      p.size = rand(1.4, 3.2); p.col = col; p.drag = 1.0; p.shape = 0;
      p.grow = -0.4; p.grav = 0;
    }
  },
};

function updateParticles() {
  for (let i = 0; i < PMAX; i++) {
    const p = parts[i];
    if (!p.on) continue;
    p.life -= STEP;
    if (p.life <= 0) { p.on = false; continue; }
    p.x += p.vx; p.y += p.vy;
    p.vx *= p.drag; p.vy *= p.drag;
    if (p.grav) p.vy += p.grav;
    p.ang += p.spin;
    if (p.grow) p.size = Math.max(0.2, p.size * (1 + p.grow * STEP));
  }
  for (let i = 0; i < RMAX; i++) {
    const r = rings[i];
    if (!r.on) continue;
    r.life -= STEP;
    if (r.life <= 0) r.on = false;
  }
}

function clearFX() {
  for (let i = 0; i < PMAX; i++) parts[i].on = false;
  for (let i = 0; i < RMAX; i++) rings[i].on = false;
}

/* ---- ambient motes: drawn in camera space, so they never need culling ---- */
const DUST = [];
for (let i = 0; i < 30; i++) {
  DUST.push({ x: rand(0, VW), y: rand(0, VH), z: rand(0.25, 1),
              vx: rand(-0.09, 0.09), vy: rand(-0.16, -0.03), s: rand(0.6, 2.0), t: rand(0, TAU) });
}
let dustPhase = 0;
function updateDust() {
  if ((dustPhase ^= 1)) return;          // decorative: 30 Hz is plenty
  for (const d of DUST) {
    d.x += d.vx * d.z; d.y += d.vy * d.z; d.t += 0.04 * d.z;
    if (d.y < -8) { d.y = VH + 8; d.x = rand(0, VW); }
    if (d.x < -8) d.x = VW + 8; else if (d.x > VW + 8) d.x = -8;
  }
}

/* ============================================================
   4. LEVEL DATA
   ============================================================
   Everything is data. A level is a world box plus lists of entities; adding a
   kind means one entry in ENTITY_KINDS and one draw function, never a branch
   in the simulation.

   Entity kinds
     solid   safe surface. Catches the spirit: it lands, slides or clings.
     spring  spirit spring. Throws the spirit along its face. The only thing
             in the world that hands out free energy.
     node    energy node. Catches an airborne spirit so it can be re-aimed,
             then goes dark while it recharges.
     mote    checkpoint. Claimed on touch, becomes the respawn point.
     spike   static lethal growth.
     beam    lethal energy beam; `pulse` makes it blink on a cycle.
     gap     void. Falling into it, or off the world, dissolves the spirit.

   Any entity may carry `motion` to oscillate or sweep.
   ============================================================ */

const LEVELS = [
  {
    /* 1 — one job: learn that you drag the way you want to go.

       Everything here is deliberately unfailable. The ledges are wide and
       barely apart, so almost any forward drag lands on the next one, and a
       catch floor runs under the whole level: a bad first input costs a couple
       of seconds, never a life. */
    name: 'FIRST LIGHT',
    tip: 'Drag the way you want to go, then let go.',
    w: 1340, h: 940,
    bg: ['#141a44', '#06091c'], accent: [120, 170, 255],
    spawn: { x: 120, y: 540 },
    gate: { x: 1150, y: 380 },
    solids: [
      { x: 670, y: 900, w: 1340, h: 240 },     // catch floor, top 780
      { x: 200, y: 660, w: 400, h: 160 },      // home ledge, top 580
      { x: 630, y: 590, w: 340, h: 160 },      // top 510   (gap 60, rise 70)
      { x: 1150, y: 500, w: 380, h: 160 },     // top 420   (gap 160, rise 90)
    ],
    route: [
      [120, 567, 'ground'], [630, 497, 'ground'], [1150, 407, 'ground'], [0, 0, 'gate'],
    ],
  },
  {
    /* 2 — one wall, used once. Floor, wall and the ledge above are all in one
       composition, and the ledge is out of reach from the floor by a clear
       margin, so the wall is obviously the answer rather than a trick. */
    name: 'STONE SONG',
    tip: 'Fly into a wall to take hold of it, then aim again.',
    w: 760, h: 980,
    bg: ['#102542', '#040a18'], accent: [90, 190, 255],
    spawn: { x: 150, y: 700 },
    gate: { x: 200, y: 300 },
    solids: [
      { x: 380, y: 900, w: 760, h: 240 },      // floor, top 780
      { x: 650, y: 520, w: 120, h: 500 },      // the wall: left face at x = 590
      { x: 200, y: 400, w: 340, h: 70 },       // upper ledge, top 365
    ],
    route: [
      [150, 767, 'ground'], [577, 600, 'cling'], [200, 352, 'ground'], [0, 0, 'gate'],
    ],
  },
  {
    /* 3 — one node. The ledge above is higher than any leap can reach and the
       node hangs in plain sight between the two, so what it is for cannot be
       misread. The node sits clear of the ledge overhead: put it underneath
       and every leap out of it hits the ceiling. */
    name: 'EMBERWAY',
    tip: 'Touch near a glowing node in mid-air: it will catch you.',
    w: 800, h: 960,
    bg: ['#231640', '#08061c'], accent: [170, 130, 255],
    spawn: { x: 110, y: 640 },
    gate: { x: 230, y: 155 },
    solids: [
      { x: 170, y: 820, w: 340, h: 240 },      // start ledge, top 700
      { x: 230, y: 270, w: 380, h: 70 },       // destination, top 235
    ],
    nodes: [{ x: 590, y: 470 }],
    route: [
      [110, 687, 'ground'], [590, 470, 'node'], [230, 222, 'ground'], [0, 0, 'gate'],
    ],
  },
  {
    /* 4 — one spring, tilted so its arrow means something: it throws up and
       across onto a wide ledge you can see from the ground. The ledge is out
       of reach from the floor, so the bloom is the only way up, and nothing
       dangerous is anywhere near the arc. */
    name: 'BLOOMFALL',
    tip: 'A bloom throws you the way its arrow points.',
    w: 1150, h: 1080,
    bg: ['#0d2c34', '#040f18'], accent: [90, 220, 190],
    spawn: { x: 130, y: 840 },
    gate: { x: 830, y: 390 },
    solids: [
      { x: 575, y: 1000, w: 1150, h: 240 },    // floor, top 880
      { x: 830, y: 465, w: 400, h: 70 },       // destination, top 430
    ],
    springs: [
      { x: 330, y: 856, w: 200, h: 44, a: 17 },          // throws up and to the right
    ],
    route: [
      [130, 867, 'ground'], [330, 843, 'spring'], [830, 417, 'ground'], [0, 0, 'gate'],
    ],
  },
  {
    /* 5 — the first real challenge: wall, then node, with a rest ledge and a
       checkpoint between them so the second half is never retried from the
       very start. The spikes sit under the opening gap where they can be seen
       from the spawn, never under anything you are asked to jump to. */
    name: 'THE NARROWS',
    tip: 'Wall, then node. The mote on the way is a checkpoint.',
    w: 1000, h: 1180,
    bg: ['#2a1330', '#0a0418'], accent: [220, 120, 220],
    spawn: { x: 120, y: 900 },
    gate: { x: 320, y: 255 },
    solids: [
      { x: 160, y: 1070, w: 320, h: 240 },     // start ledge, top 950
      { x: 640, y: 790, w: 300, h: 70 },       // rest ledge, top 755
      { x: 890, y: 620, w: 120, h: 520 },      // the wall: left face at x = 830
      { x: 320, y: 330, w: 480, h: 70 },       // gate ledge, top 295
    ],
    nodes: [{ x: 680, y: 540 }],
    motes: [{ x: 640, y: 715 }],
    spikes: [{ x: 620, y: 1150, w: 620, h: 60 }],
    route: [
      [120, 937, 'ground'], [640, 742, 'ground'], [817, 600, 'cling'],
      [680, 540, 'node'], [320, 282, 'ground'], [0, 0, 'gate'],
    ],
  },
  {
    /* 6 — the flow level. Nothing new; it asks for the chain, in order: leap,
       take the wall, leap off it, be thrown by the bloom, be caught by the
       node, redirect home. The wall is deliberately on the far side of where
       you are going next, because a hold pushes you off the way it faces —
       so the wall itself turns you back toward the climb. */
    name: 'SKYWARD',
    tip: 'Leap, cling, be thrown, be caught. Keep the chain going.',
    w: 1120, h: 1520,
    bg: ['#191646', '#05061a'], accent: [140, 150, 255],
    spawn: { x: 120, y: 1240 },
    gate: { x: 300, y: 255 },
    solids: [
      { x: 180, y: 1400, w: 360, h: 240 },     // start ledge, top 1280
      { x: 760, y: 1090, w: 120, h: 480 },     // the wall: left face at x = 700
      { x: 280, y: 930, w: 380, h: 70 },       // bloom ledge, top 895
      { x: 300, y: 330, w: 400, h: 70 },       // gate ledge, top 295
    ],
    springs: [
      { x: 280, y: 876, w: 200, h: 44, a: 20 },          // throws up and to the right
    ],
    nodes: [{ x: 620, y: 430 }],
    motes: [{ x: 430, y: 855 }],
    spikes: [{ x: 700, y: 1490, w: 560, h: 60 }],
    beams: [
      { x: 520, y: 1180, w: 44, h: 260, pulse: { period: 3.0, phase: 0.25, duty: 0.3 } },
    ],
    route: [
      [120, 1267, 'ground'], [687, 1100, 'cling'], [280, 858, 'ground'],
      [280, 863, 'spring'], [620, 430, 'node'], [300, 282, 'ground'], [0, 0, 'gate'],
    ],
  },
];

/* ============================================================
   5. WORLD BUILDING
   ============================================================ */

const world = {
  solids: [],   // safe surfaces — everything the spirit can land on or cling to
  springs: [],
  nodes: [],
  motes: [],
  lethal: [],   // spikes and beams
  beams: [],
  movers: [],
  gate: null,
  w: VW, h: VH,
  bg: ['#141a44', '#06091c'],
  accent: [120, 170, 255],
};

const ENTITY_KINDS = {
  solid:  { list: 'solids',  init: () => {} },
  spring: { list: 'springs', init: (e) => { e.fire = 0; } },
  node:   { list: 'nodes',   init: (e) => { e.r = e.r || 26; e.cool = 0; e.glow = 0; e.spin = 0; } },
  mote:   { list: 'motes',   init: (e) => { e.r = e.r || 20; e.got = false; e.pop = 0; } },
  spike:  { list: 'lethal',  init: (e) => { e.spikes = true; } },
  beam:   { list: 'lethal',  also: 'beams', init: (e) => { e.k = 1; } },
};

function prepEntity(e, kind) {
  e.kind = kind;
  e.a = (e.a || 0) * DEG;
  e.bx = e.x; e.by = e.y; e.ba = e.a;
  e.px = e.x; e.py = e.y;
  e.vx = 0; e.vy = 0; e.av = 0;
  e.seed = Math.random() * 100;
  e.gfx = {};
  e.ca = Math.cos(e.a); e.sa = Math.sin(e.a);
  e.br = e.w !== undefined ? Math.hypot(e.w, e.h) / 2 : (e.r || 26);
  const spec = ENTITY_KINDS[kind];
  if (spec && spec.init) spec.init(e);
  return e;
}

function addEntity(e, kind) {
  prepEntity(e, kind);
  const spec = ENTITY_KINDS[kind];
  if (spec.list) world[spec.list].push(e);
  if (spec.also) world[spec.also].push(e);
  if (e.motion) world.movers.push(e);
  return e;
}

function buildWorld(src) {
  const L = clone(src);
  world.solids.length = 0; world.springs.length = 0; world.nodes.length = 0;
  world.motes.length = 0; world.lethal.length = 0; world.beams.length = 0;
  world.movers.length = 0;
  world.w = L.w; world.h = L.h;
  world.bg = L.bg; world.accent = L.accent;

  for (const e of (L.solids  || [])) addEntity(e, 'solid');
  for (const e of (L.springs || [])) addEntity(e, 'spring');
  for (const e of (L.nodes   || [])) addEntity(e, 'node');
  for (const e of (L.motes   || [])) addEntity(e, 'mote');
  for (const e of (L.spikes  || [])) addEntity(e, 'spike');
  for (const e of (L.beams   || [])) addEntity(e, 'beam');

  world.gate = prepEntity(Object.assign({ r: 40 }, L.gate), 'gate');
  world.gate.open = 0;
  return L;
}

function updateMotion(t) {
  for (const e of world.movers) {
    e.px = e.x; e.py = e.y;
    const pa = e.a;
    const m = e.motion;
    if (m.type === 'osc') {
      const ph = Math.sin((t / m.period + (m.phase || 0)) * TAU);
      e.x = e.bx + (m.dx || 0) * ph;
      e.y = e.by + (m.dy || 0) * ph;
    } else if (m.type === 'spin') {
      e.a = e.ba + m.speed * t;
    } else if (m.type === 'sweep') {
      e.a = e.ba + (m.amp || 1) * Math.sin((t / m.period + (m.phase || 0)) * TAU);
    }
    if (e.a !== pa) { e.ca = Math.cos(e.a); e.sa = Math.sin(e.a); }
    e.vx = e.x - e.px; e.vy = e.y - e.py; e.av = e.a - pa;
  }
}

/* How lit a pulsing beam is right now: 0 dark, 1 lethal. The ramp telegraphs
   the strike so a death is always the player's to avoid. */
function beamLevel(h, t) {
  if (!h.pulse) return 1;
  const p = h.pulse;
  const u = ((t / p.period) + (p.phase || 0)) % 1;
  const duty = p.duty || 0.42;
  if (u > duty) {
    const rem = (1 - u) / (1 - duty);
    return rem < 0.22 ? (0.22 - rem) / 0.22 * 0.34 : 0;
  }
  const ramp = 0.1;
  if (u < duty * ramp) return 0.34 + (u / (duty * ramp)) * 0.66;
  if (u > duty * (1 - ramp)) return 1 - ((u - duty * (1 - ramp)) / (duty * ramp)) * 0.7;
  return 1;
}

/* ============================================================
   6. COLLISION & MOTION
   ============================================================ */

function circleVsBox(px, py, r, e) {
  const dx = px - e.x, dy = py - e.y;
  // broad phase: one squared-distance test against the box's bounding circle
  const reach = e.br + r;
  if (dx * dx + dy * dy > reach * reach) return null;
  const ca = e.ca, sa = -e.sa;
  const lx = dx * ca - dy * sa;
  const ly = dx * sa + dy * ca;
  const hw = e.w / 2, hh = e.h / 2;
  const qx = clamp(lx, -hw, hw), qy = clamp(ly, -hh, hh);
  const ddx = lx - qx, ddy = ly - qy;
  const d2 = ddx * ddx + ddy * ddy;
  if (d2 > r * r) return null;
  let nx, ny, pen;
  if (d2 > 1e-7) {
    const d = Math.sqrt(d2);
    nx = ddx / d; ny = ddy / d; pen = r - d;
  } else {
    const ox = hw - Math.abs(lx), oy = hh - Math.abs(ly);
    if (ox < oy) { nx = lx < 0 ? -1 : 1; ny = 0; pen = ox + r; }
    else { nx = 0; ny = ly < 0 ? -1 : 1; pen = oy + r; }
  }
  const cb = e.ca, sb = e.sa;
  HIT.nx = nx * cb - ny * sb;
  HIT.ny = nx * sb + ny * cb;
  HIT.pen = pen;
  return HIT;
}
const HIT = { nx: 0, ny: 0, pen: 0 };

function overlapsBox(px, py, r, e) { return circleVsBox(px, py, r, e) !== null; }

/* --- contact accumulator -------------------------------------------------
   Every surface touched during one substep lands here. Position is corrected
   as each contact is found, so the body is never left overlapping, but the
   velocity response is deferred and applied once against the combined normal.

   That is what makes corners behave: resolving surfaces one at a time reflects
   the body twice in the same instant, so the outcome depends on the order of
   the list and a one-pixel difference can send the spirit anywhere. */
const CT = {
  n: 0, closing: 0,
  nx: 0, ny: 0, wsum: 0,
  ovx: 0, ovy: 0,
  cnx: new Float64Array(6), cny: new Float64Array(6),
  cvx: new Float64Array(6), cvy: new Float64Array(6),
  reset() {
    this.n = 0; this.closing = 0;
    this.nx = 0; this.ny = 0; this.wsum = 0; this.ovx = 0; this.ovy = 0;
  },
  add(nx, ny, pen, ovx, ovy, closing) {
    if (this.n < 6) {
      const i = this.n++;
      this.cnx[i] = nx; this.cny[i] = ny;
      this.cvx[i] = ovx; this.cvy[i] = ovy;
    }
    if (!closing) return;
    const w = pen > 0.05 ? pen : 0.05;
    this.nx += nx * w; this.ny += ny * w;
    this.ovx += ovx * w; this.ovy += ovy * w;
    this.wsum += w;
    this.closing++;
  },
};

/* What one step of motion ran into. */
const RES = {
  floor: false, wall: false, ceil: false,
  wallNx: 0, wallE: null,
  impact: 0, hx: 0, hy: 0, nx: 0, ny: 0,
  spring: null, lethal: null,
  reset() {
    this.floor = false; this.wall = false; this.ceil = false;
    this.wallNx = 0; this.wallE = null;
    this.impact = 0; this.spring = null; this.lethal = null;
  },
};

const SV = { x: 0, y: 0 };
function surfaceVel(e, px, py) {
  SV.x = e.vx || 0; SV.y = e.vy || 0;
  if (e.av) { SV.x += -e.av * (py - e.y); SV.y += e.av * (px - e.x); }
  return SV;
}

function collectSolid(s, e) {
  const hit = circleVsBox(s.x, s.y, s.r, e);
  if (!hit) return;
  const nx = hit.nx, ny = hit.ny;
  s.x += nx * (hit.pen + MOVE.slop);
  s.y += ny * (hit.pen + MOVE.slop);
  const sv = surfaceVel(e, s.x, s.y);
  const vn = (s.vx - sv.x) * nx + (s.vy - sv.y) * ny;
  CT.add(nx, ny, hit.pen, sv.x, sv.y, vn < 0);

  // classify the surface from its normal, so the player logic never has to
  // reason about geometry: a normal pointing up is something to stand on,
  // a normal pointing down is something you bonk, anything else is a wall
  if (ny < -MOVE.floorDot) RES.floor = true;
  else if (ny > MOVE.floorDot) RES.ceil = true;
  else if (!RES.wall || -vn > RES.impact) { RES.wall = true; RES.wallNx = nx; RES.wallE = e; }

  if (vn < 0 && -vn > RES.impact) {
    RES.impact = -vn; RES.nx = nx; RES.ny = ny;
    RES.hx = s.x - nx * s.r; RES.hy = s.y - ny * s.r;
  }
}

/* One velocity response per substep.

   There is no restitution here at all. An ordinary surface takes the whole
   normal component and hands back a fraction of the slide — the spirit arrives
   and stays arrived. Everything that throws the spirit back out into the world
   is a named object with its own rule. */
function resolveContactVel(s) {
  if (CT.closing && CT.wsum > 0) {
    const len = Math.hypot(CT.nx, CT.ny);
    // a near-zero combined normal means the contacts oppose each other: the
    // body is wedged, and the slide pass below is the whole answer
    if (len > CT.wsum * 0.2) {
      const nx = CT.nx / len, ny = CT.ny / len;
      const ovx = CT.ovx / CT.wsum, ovy = CT.ovy / CT.wsum;
      const rvx = s.vx - ovx, rvy = s.vy - ovy;
      const vn = rvx * nx + rvy * ny;
      if (vn < 0) {
        // how much slide survives depends on what was touched
        const keep = RES.floor ? MOVE.slideKeep : RES.ceil ? MOVE.ceilingKeep : 0.5;
        s.vx = (rvx - nx * vn) * keep + ovx;
        s.vy = (rvy - ny * vn) * keep + ovy;
      }
    }
  }
  // never end a substep still travelling into something being touched
  for (let i = 0; i < CT.n; i++) {
    const nx = CT.cnx[i], ny = CT.cny[i];
    const vn = (s.vx - CT.cvx[i]) * nx + (s.vy - CT.cvy[i]) * ny;
    if (vn < 0) { s.vx -= nx * vn; s.vy -= ny * vn; }
  }
}

/* A spring throws along its own face, whatever the approach. Predictable by
   construction: the arrow drawn on it is exactly where you will go. */
function fireSpring(s, sp) {
  if (!overlapsBox(s.x, s.y, s.r, sp)) return;
  const nx = sp.sa, ny = -sp.ca;             // local -y, rotated into the world
  const tvx = s.vx - nx * (s.vx * nx + s.vy * ny);
  const tvy = s.vy - ny * (s.vx * nx + s.vy * ny);
  s.vx = tvx * MOVE.springKeep + nx * MOVE.springSpeed;
  s.vy = tvy * MOVE.springKeep + ny * MOVE.springSpeed;
  s.x += nx * 4; s.y += ny * 4;
  RES.spring = sp;
}

const SUBSTEP_MAX = 10;

/* Advance a body by its velocity, resolving everything it meets on the way.
   Shared verbatim by the player and by the aim preview, so the dotted guide can
   never promise something the simulation will not do. */
function stepBody(s, live) {
  RES.reset();
  const sp = Math.hypot(s.vx, s.vy);
  const n = Math.min(SUBSTEP_MAX, Math.max(1, Math.ceil(sp / (s.r * 0.42))));
  const solids = world.solids;
  for (let i = 0; i < n; i++) {
    s.x += s.vx / n; s.y += s.vy / n;
    CT.reset();
    for (let k = 0; k < solids.length; k++) collectSolid(s, solids[k]);
    if (CT.n) resolveContactVel(s);

    for (let k = 0; k < world.lethal.length; k++) {
      const e = world.lethal[k];
      if (e.k !== undefined && e.k <= 0.35) continue;
      if (overlapsBox(s.x, s.y, s.r * 0.72, e)) { RES.lethal = e; return RES; }
    }
    // the world is an island in a void: leaving it in any direction dissolves
    // the spirit. The margin is generous so a near miss is never a cheap death
    if (s.y > world.h + 240 || s.x < -160 || s.x > world.w + 160) {
      RES.lethal = VOID; return RES;
    }

    for (let k = 0; k < world.springs.length; k++) {
      fireSpring(s, world.springs[k]);
      if (RES.spring) { i = n; break; }
    }
  }
  return RES;
}
const VOID = { kind: 'void' };

/* ---- landing assist -----------------------------------------------------
   Coming down a hand's width short of a ledge is the least satisfying way to
   fail: the player read the situation correctly and the game said no anyway.
   While falling near the height of a surface top, the spirit is accelerated
   gently toward the nearest edge it is about to miss.

   It is an acceleration, not a correction: it is small next to the speed the
   player already has, it only ever acts sideways, and it stops the moment the
   spirit is over the surface. So it removes near-misses without ever looking
   like the character was moved for you. */
function landingAssist(s) {
  if (s.vy < 1.2) return;                       // only on the way down
  const foot = s.y + s.r;
  let bestDir = 0, bestGap = MOVE.assistReach;
  for (let i = 0; i < world.solids.length; i++) {
    const e = world.solids[i];
    if (e.a || e.w < 60) continue;              // flat, standable tops only
    const top = e.y - e.h / 2;
    if (foot > top + 12 || foot < top - MOVE.assistBand) continue;
    const gapL = (e.x - e.w / 2) - s.x;         // >0: surface is to our right
    const gapR = s.x - (e.x + e.w / 2);         // >0: surface is to our left
    if (gapL > 0 && gapL < bestGap) { bestGap = gapL; bestDir = 1; }
    else if (gapR > 0 && gapR < bestGap) { bestGap = gapR; bestDir = -1; }
  }
  if (!bestDir) return;
  // The pull fades in as the gap closes, so it is strongest when the miss is
  // smallest, and it is capped: the spirit may drift toward the ledge, never
  // be flung at it. Past the cap the player is already moving that way on
  // their own and the assist has nothing to add.
  if (s.vx * bestDir >= MOVE.assistMax) return;
  const k = 1 - bestGap / MOVE.assistReach;
  s.vx += bestDir * MOVE.assistPull * k;
}

/* Gravity, air drag and the speed ceiling. The burst window suspends gravity
   for a few frames so a release reads as a deliberate throw rather than
   something that begins falling the instant it leaves. */
function integrate(s) {
  if (s.burst > 0) {
    s.burst -= STEP;
  } else {
    const slow = Math.abs(s.vy) < MOVE.floatBand;
    s.vy += MOVE.gravity * (slow ? MOVE.floatScale : 1);
    s.vx *= MOVE.airDrag;
    if (s.vy > MOVE.fallMax) s.vy = MOVE.fallMax;
  }
  const sp = Math.hypot(s.vx, s.vy);
  if (sp > MOVE.speedMax) { const f = MOVE.speedMax / sp; s.vx *= f; s.vy *= f; }
}

/* --- trajectory preview (the same integrator, nothing simulated twice) --- */
const probe = { x: 0, y: 0, vx: 0, vy: 0, r: MOVE.radius, burst: 0 };
const preview = {
  pts: [], n: 0, land: -1, lx: 0, ly: 0,
  landFloor: false,          // did it end on something you can stand on?
  danger: false, spring: false,
};

function predict(x, y, vx, vy, maxDist) {
  probe.x = x; probe.y = y; probe.vx = vx; probe.vy = vy;
  probe.burst = MOVE.burstTime;
  preview.n = 0; preview.land = -1; preview.landFloor = false;
  preview.danger = false; preview.spring = false;
  let travelled = 0, sinceDot = 1e9;
  for (let i = 0; i < 150; i++) {
    const ox = probe.x, oy = probe.y;
    integrate(probe);
    landingAssist(probe);          // the guide must include the help the player gets
    const r = stepBody(probe);
    if (r.lethal) { preview.danger = true; pushDot(probe.x, probe.y); break; }
    if (r.spring) { preview.spring = true; pushDot(probe.x, probe.y); break; }
    if (r.floor || r.wall || r.ceil) {
      preview.land = preview.n;
      preview.landFloor = r.floor || r.wall;   // both are places control returns
      preview.lx = probe.x; preview.ly = probe.y;
      pushDot(probe.x, probe.y);
      break;
    }
    const moved = Math.hypot(probe.x - ox, probe.y - oy);
    travelled += moved; sinceDot += moved;
    if (sinceDot >= 22) { sinceDot = 0; pushDot(probe.x, probe.y); }
    if (travelled > maxDist) break;
  }
  return preview;
}
function pushDot(x, y) {
  const i = preview.n++;
  if (!preview.pts[i]) preview.pts[i] = { x: 0, y: 0 };
  preview.pts[i].x = x; preview.pts[i].y = y;
}

/* ============================================================
   7. THE PLAYER
   ============================================================
   Four parts that only talk through small named interfaces, so the collision
   loop never writes a visual field and the renderer never writes a physics
   one.

     body  — position, velocity, radius. What the integrator moves.
     PS    — the state machine. Which of the six states the spirit is in, how
             long it has been there, and whether the player may aim right now.
     Vis   — everything cosmetic, driven by events (onBurst, onLand, ...).
     Aim   — the wind-up: where it is anchored, how far it is pulled, and the
             one place a release turns into a burst.
   ============================================================ */

const body = { x: 0, y: 0, vx: 0, vy: 0, r: MOVE.radius, burst: 0 };

/* grounded · airborne · clinging · held by a node · dissolving · reforming */
const PS = {
  state: 'spawn',
  t: 0,
  prev: 'spawn',
  speed: 0,
  facing: -Math.PI / 2,
  coyote: 0,          // grace after stepping off a surface
  clingT: 0,          // how long the current hold has lasted
  clingSide: 0,       // +1 the wall is to the left of us, -1 to the right
  node: null,         // the node currently holding us
  fallT: 0,           // how long we have been falling (for the landing weight)
  set(name) {
    if (this.state === name) return;
    this.prev = this.state; this.state = name; this.t = 0;
  },
};

/* The three states that hand control back. Everything else is committed
   motion, and the only ways out of it are a node, a wall, or the ground. */
function canAim() {
  if (G.phase !== 'play') return false;
  const s = PS.state;
  return s === 'ground' || s === 'cling' || s === 'node' ||
         (s === 'air' && PS.coyote > 0);
}

/* The nearest node that could catch us right now. Generous on purpose: this is
   the main mobile target in the game and it is moving. */
function nodeInReach() {
  if (PS.state !== 'air' || G.phase !== 'play') return null;
  let best = null, d2best = MOVE.nodeReach * MOVE.nodeReach;
  for (const n of world.nodes) {
    if (n.cool > 0) continue;
    const dx = n.x - body.x, dy = n.y - body.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < d2best) { d2best = d2; best = n; }
  }
  return best;
}

const Vis = {
  squash: 0, squashAng: 0,
  stretch: 0, stretchAng: 0,
  pulse: 0, flash: 0, scale: 1,
  landPop: 0, readyPop: 0, blink: 0, blinkT: 2,
  look: 0, lookT: -Math.PI / 2,      // where the creature is looking
  trail: [], trailN: 0,

  reset(x, y) {
    this.squash = 0; this.stretch = 0; this.flash = 0; this.scale = 1;
    this.landPop = 0; this.readyPop = 0; this.blink = 0; this.blinkT = 2;
    for (let i = 0; i < TRAIL_N; i++) { this.trail[i].x = x; this.trail[i].y = y; this.trail[i].v = 0; }
    this.trailN = 0;
  },

  step(sp) {
    this.pulse += STEP;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - STEP * 3.4);
    if (this.squash > 0) this.squash = Math.max(0, this.squash - STEP * 3.8);
    if (this.landPop > 0) this.landPop = Math.max(0, this.landPop - STEP * 4.2);
    if (this.readyPop > 0) this.readyPop = Math.max(0, this.readyPop - STEP * 2.8);
    // stretch follows speed rather than decaying, so fast travel leans forward
    const want = clamp(sp / 20, 0, 1) * 0.3;
    this.stretch += (want - this.stretch) * 0.2;
    if (sp > 0.6) this.stretchAng = PS.facing;
    // the creature looks where it is going, or where it is about to go
    const want2 = Aim.on ? Aim.angle : (sp > 1 ? PS.facing : this.lookT);
    let d = ((want2 - this.lookT + Math.PI) % TAU + TAU) % TAU - Math.PI;
    this.lookT += d * 0.22;
    // idle blink
    this.blinkT -= STEP;
    if (this.blinkT <= 0) { this.blink = 0.16; this.blinkT = rand(2.4, 5.5); }
    if (this.blink > 0) this.blink = Math.max(0, this.blink - STEP);
  },

  sample(x, y, sp) {
    const tp = this.trail[this.trailN % TRAIL_N];
    tp.x = x; tp.y = y; tp.v = sp;
    this.trailN++;
  },

  onBurst(ang, power) {
    this.squash = 0.5; this.squashAng = ang;
    this.stretch = 0.22 + power * 0.26; this.stretchAng = ang;
    this.flash = 1; this.trailN = 0;
  },
  onLand(hard) {
    this.squash = Math.max(this.squash, 0.24 + hard * 0.46);
    this.squashAng = Math.PI / 2;
    this.landPop = 0.6 + hard * 0.4;
  },
  onWall(nx) {
    this.squash = Math.max(this.squash, 0.3);
    this.squashAng = 0;
    this.stretch *= 0.3;
  },
  onReady() { this.readyPop = 1; },
};
const TRAIL_N = 20;
for (let i = 0; i < TRAIL_N; i++) Vis.trail.push({ x: 0, y: 0, v: 0 });

/* The wind-up. Input writes only to this; everything else reads it. */
const Aim = {
  on: false,
  from: '',            // which state the wind-up started in
  anchorX: 0, anchorY: 0,
  power: 0, angle: 0,
  held: 0,
  clear() { this.on = false; this.power = 0; this.held = 0; },
};

/* Leaving a wall.

   The rule is only ever "you cannot launch into the surface you are holding".
   A leap aimed away from the wall is left exactly as the player aimed it; one
   aimed along or into it is given just enough outward speed to clear the face.

   The previous version added a fixed outward shove to every wall leap, which
   meant a wall could silently fight the direction the player had chosen — the
   worst kind of unpredictability, because the input looked like it worked. */
function applyClingKick(ang, sp, out) {
  const nx = PS.clingSide;                 // +1 = wall on our left, push right
  let vx = Math.cos(ang) * sp, vy = Math.sin(ang) * sp;
  const want = MOVE.clingKick * sp;
  const outward = vx * nx;
  if (outward < want) vx += nx * (want - outward);
  out.x = vx; out.y = vy;
  return out;
}
const KICK = { x: 0, y: 0 };

/* The one place a wind-up becomes motion. */
function doBurst(ang, power) {
  const fromNode = PS.state === 'node' && PS.node;
  const p = burstCurve(clamp(power, 0, 1));
  const sp = fromNode ? lerp(MOVE.nodeMin, MOVE.nodeBurst, p)
                      : lerp(MOVE.burstMin, MOVE.burstMax, p);
  let vx = Math.cos(ang) * sp, vy = Math.sin(ang) * sp;

  if (PS.state === 'cling') {
    const k = applyClingKick(ang, sp, KICK);
    vx = k.x; vy = k.y;
  }
  body.vx = vx; body.vy = vy;
  body.burst = MOVE.burstTime;
  PS.facing = Math.atan2(vy, vx);
  PS.coyote = 0; PS.clingT = 0;

  const hue = fromNode ? HUE.node : HUE.spirit;
  if (fromNode) {
    const n = PS.node;
    n.cool = MOVE.nodeCool;
    n.glow = 1;
    FX.shock(n.x, n.y, n.r, n.r + 70, 0.4, HUE.node.rgb, 3);
    FX.spark(n.x, n.y, ang, 0.5, 4 + p * 4, 9, HUE.node.rgb,
             { life: 0.45, size: 2.6, shape: 1, len: 12, drag: 0.9 });
    Sfx.nodeFire(p);
    PS.node = null;
  } else {
    Sfx.burst(p);
  }
  PS.set('air');
  Vis.onBurst(ang, p);
  FX.spark(body.x - Math.cos(ang) * 10, body.y - Math.sin(ang) * 10, ang + Math.PI,
           0.55, 3 + p * 4, 7, hue.rgb, { life: 0.4, size: 2.4, shape: 1, len: 11, drag: 0.9 });
  FX.shock(body.x, body.y, body.r, body.r + 28 + p * 26, 0.32, hue.rgb, 3);
  cam.shake = Math.max(cam.shake, 1.4 + p * 3);
  cam.kx -= Math.cos(ang) * (1 + p * 2);
  cam.ky -= Math.sin(ang) * (1 + p * 2);
  G.bursts++;
  setHint('');
}

/* ============================================================
   8. GAME STATE
   ============================================================ */

const G = {
  phase: 'play',          // play | win | trans | done
  t: 0,
  phaseT: 0,
  levelIndex: 0,
  level: null,
  bursts: 0,
  totalBursts: 0,
  runTime: 0,
  spawnX: 0, spawnY: 0,   // the last claimed mote, or the level start
  deaths: 0,
  transDir: 0, transT: 0, transDur: 0.42, transNext: null,
  fadeIn: 0,
  deny: 0,
};

const cam = {
  x: 0, y: 0, shake: 0, sx: 0, sy: 0,
  kx: 0, ky: 0,           // directional impulse from a launch or a slam
  zoom: 1, zoomT: 1, punch: 0,
  flash: 0, flashCol: [255, 255, 255],
};

/* ---- DOM ---- */
const dom = {
  canvas: document.getElementById('game'),
  levelNum: document.getElementById('levelNum'),
  levelName: document.getElementById('levelName'),
  progress: document.getElementById('progressFill'),
  shotCount: document.getElementById('shotCount'),
  shots: document.getElementById('shots'),
  restart: document.getElementById('restartBtn'),
  banner: document.getElementById('banner'),
  bannerNum: document.querySelector('.banner-num'),
  bannerName: document.querySelector('.banner-name'),
  hint: document.getElementById('hint'),
  toast: document.getElementById('toast'),
  endCard: document.getElementById('endCard'),
  endRestart: document.getElementById('endRestart'),
  endShots: document.getElementById('endShots'),
  endTime: document.getElementById('endTime'),
  fps: document.getElementById('fps'),
  sound: document.getElementById('soundBtn'),
};
const ctx = dom.canvas.getContext('2d');

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function updateHud() {
  dom.shotCount.textContent = G.bursts;
}
function showBanner(i) {
  const L = LEVELS[i];
  dom.bannerNum.textContent = pad2(i + 1);
  dom.bannerName.textContent = L.name;
  dom.banner.classList.remove('show');
  void dom.banner.offsetWidth;
  dom.banner.classList.add('show');
}
function showToast(msg, quick) {
  dom.toast.textContent = msg;
  dom.toast.classList.remove('hidden', 'show', 'quick');
  void dom.toast.offsetWidth;
  dom.toast.classList.add('show');
  if (quick) dom.toast.classList.add('quick');
}
function setHint(text) {
  if (text) { dom.hint.textContent = text; dom.hint.classList.remove('hidden'); }
  else dom.hint.classList.add('hidden');
}

/* Put the spirit down at a point, fully reset, and let it reform. */
function placeSpirit(x, y) {
  body.x = x; body.y = y; body.vx = 0; body.vy = 0; body.burst = 0;
  PS.state = 'spawn'; PS.t = 0; PS.prev = 'spawn';
  PS.coyote = 0; PS.clingT = 0; PS.clingSide = 0; PS.node = null;
  PS.speed = 0; PS.facing = -Math.PI / 2; PS.fallT = 0;
  Aim.clear();
  clearBuffer();
  Vis.reset(x, y);
}

function startLevel(i) {
  G.levelIndex = i;
  G.level = buildWorld(LEVELS[i]);
  G.bursts = 0;
  G.t = 0;
  G.phase = 'play'; G.phaseT = 0;
  G.fadeIn = 0.5;
  G.spawnX = LEVELS[i].spawn.x; G.spawnY = LEVELS[i].spawn.y;
  clearFX();
  placeSpirit(G.spawnX, G.spawnY);
  updateCamera(true);
  dom.levelNum.textContent = pad2(i + 1);
  dom.levelName.textContent = LEVELS[i].name;
  dom.progress.style.width = ((i + 1) / LEVELS.length * 100) + '%';
  updateHud();
  showBanner(i);
  setHint('');
  setTimeout(() => {
    if (G.levelIndex === i && G.bursts === 0 && G.phase === 'play') setHint(LEVELS[i].tip);
  }, 1150);
}

function transitionTo(fn) {
  G.phase = 'trans'; G.transDir = 1; G.transT = 0; G.transNext = fn;
  Sfx.sweep();
}
function nextLevel() {
  const n = G.levelIndex + 1;
  transitionTo(n >= LEVELS.length ? finishRun : () => startLevel(n));
}
function finishRun() {
  G.phase = 'done';
  const secs = Math.round(G.runTime);
  dom.endShots.textContent = G.totalBursts;
  dom.endTime.textContent = Math.floor(secs / 60) + ':' + pad2(secs % 60);
  dom.endCard.classList.remove('hidden');
  Sfx.complete();
  G.level = buildWorld(LEVELS[LEVELS.length - 1]);
  placeSpirit(LEVELS[LEVELS.length - 1].spawn.x, LEVELS[LEVELS.length - 1].spawn.y);
  updateCamera(true);
}
function restartRun() {
  doneFrames = 0;
  dom.endCard.classList.add('hidden');
  G.totalBursts = 0; G.runTime = 0; G.deaths = 0;
  startLevel(0);
}
function restartLevel(silent) {
  if (G.phase === 'done' || G.transDir !== 0) return;
  if (!silent) Sfx.ui();
  startLevel(G.levelIndex);
  G.fadeIn = 0.3;
}

/* ---- failure: fast, cheap, and always back at the last mote ---- */
function killSpirit(kind) {
  if (PS.state === 'hurt' || PS.state === 'spawn' || G.phase !== 'play') return;
  PS.set('hurt');
  G.deaths++;
  Aim.clear(); clearBuffer();
  Sfx.tensionStop();
  const c = HUE.spirit;
  if (kind === 'void') {
    FX.spark(body.x, body.y, -Math.PI / 2, Math.PI, 2.4, 8, c.rgb, { life: 0.5, size: 2.2, drag: 0.92 });
    cam.shake = Math.max(cam.shake, 3);
  } else {
    FX.spark(body.x, body.y, 0, Math.PI, 5.5, 12, DANGER, { life: 0.42, size: 2.8, drag: 0.93, shape: 1, len: 9 });
    FX.spark(body.x, body.y, 0, Math.PI, 3, 6, c.rgb, { life: 0.4, size: 2.2, drag: 0.93 });
    FX.shock(body.x, body.y, 4, 76, 0.36, DANGER, 4);
    cam.shake = Math.max(cam.shake, 9);
    cam.flash = Math.max(cam.flash, 0.3); cam.flashCol = DANGER;
  }
  Sfx.fail();
}

function respawn() {
  placeSpirit(G.spawnX, G.spawnY);
  G.fadeIn = 0.12;
  FX.implode(G.spawnX, G.spawnY, 54, 9, HUE.spirit.hi, 0.34);
  Sfx.respawn();
  updateCamera(true);
}

function reachGate() {
  G.phase = 'win'; G.phaseT = 0;
  const g = world.gate;
  FX.implode(g.x, g.y, 92, 11, HUE.gate.hi, 0.5);
  FX.shock(g.x, g.y, g.r, g.r + 130, 0.7, HUE.gate.rgb, 4);
  cam.punch = 0.05; cam.flash = 0.3; cam.flashCol = HUE.gate.hi;
  Aim.clear(); clearBuffer();
  Sfx.gate(); Sfx.tensionStop();
  setHint('');
}

/* ---- swept triggers: motes and the gate, checked along the whole step ---- */
function checkTriggers(px, py) {
  const dx = body.x - px, dy = body.y - py;
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 8));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const sx = px + dx * t, sy = py + dy * t;
    for (const m of world.motes) {
      if (m.got) continue;
      if (Math.hypot(sx - m.x, sy - m.y) < m.r + body.r) {
        m.got = true; m.pop = 1;
        G.spawnX = m.x; G.spawnY = m.y - 26;
        FX.shock(m.x, m.y, m.r * 0.6, m.r + 64, 0.5, HUE.mote.rgb, 3);
        FX.spark(m.x, m.y, 0, Math.PI, 2.6, 8, HUE.mote.hi, { life: 0.5, size: 2.2, drag: 0.92 });
        cam.flash = Math.max(cam.flash, 0.12); cam.flashCol = HUE.mote.hi;
        Sfx.mote();
      }
    }
    const g = world.gate;
    // the trigger matches the ring you can see, plus a little of the body:
    // a gate you are visibly touching must always count
    if (Math.hypot(sx - g.x, sy - g.y) < g.r + body.r * 0.5) { body.x = sx; body.y = sy; reachGate(); return; }
  }
}

/* ---- one fixed simulation step ---- */
function simStep() {
  // A wind-up freezes the world. On a phone that is the difference between a
  // mechanic you can use and one you fumble, and it costs nothing: the spirit
  // is already held by the ground, a wall or a node whenever it is allowed.
  if (Aim.on) {
    Aim.held += STEP;
    refreshAimPreview();
    if (PS.state === 'node' && PS.node) {
      body.x = lerp(body.x, PS.node.x, MOVE.nodePull);
      body.y = lerp(body.y, PS.node.y, MOVE.nodePull);
    }
    Vis.step(PS.speed);
    if (Aim.held >= MOVE.aimHold) cancelAim();
    updateCamera(false);
    return;
  }

  G.t += STEP;
  if (G.phase !== 'done') G.runTime += STEP;
  G.phaseT += STEP;

  updateMotion(G.t);
  for (const b of world.beams) b.k = beamLevel(b, G.t);
  for (const n of world.nodes) {
    if (n.cool > 0) n.cool = Math.max(0, n.cool - STEP);
    if (n.glow > 0) n.glow = Math.max(0, n.glow - STEP * 2);
    n.spin += STEP * (n.cool > 0 ? 0.6 : 1.8);
  }
  for (const s of world.springs) if (s.fire > 0) s.fire = Math.max(0, s.fire - STEP * 2.6);
  for (const m of world.motes) if (m.pop > 0) m.pop = Math.max(0, m.pop - STEP * 2);
  if (world.gate.open > 0 && G.phase !== 'win') world.gate.open = Math.max(0, world.gate.open - STEP * 2);

  updateDust();
  updateParticles();

  cam.shake *= 0.86;
  if (cam.shake < 0.05) cam.shake = 0;
  cam.sx = rand(-1, 1) * cam.shake;
  cam.sy = rand(-1, 1) * cam.shake;
  cam.kx *= 0.82; cam.ky *= 0.82;
  if (Math.abs(cam.kx) < 0.02) cam.kx = 0;
  if (Math.abs(cam.ky) < 0.02) cam.ky = 0;
  cam.punch *= 0.90;
  if (Math.abs(cam.punch) < 0.002) cam.punch = 0;
  cam.flash *= 0.8;
  if (G.fadeIn > 0) G.fadeIn = Math.max(0, G.fadeIn - STEP);
  if (G.deny > 0) G.deny = Math.max(0, G.deny - STEP * 2.4);

  PS.t += STEP;

  if (G.phase === 'play') updateSpirit();
  else if (G.phase === 'win') {
    const g = world.gate;
    g.open = Math.min(1, g.open + STEP * 3);
    body.x = lerp(body.x, g.x, 0.2); body.y = lerp(body.y, g.y, 0.2);
    body.vx *= 0.8; body.vy *= 0.8;
    Vis.scale = Math.max(0, 1 - easeIn(clamp(G.phaseT / 0.45, 0, 1)));
    if (G.phaseT > 0.95) nextLevel();
  }

  Vis.step(PS.speed);
  updateCamera(false);

  if (G.transDir !== 0) {
    G.transT += STEP;
    if (G.transT >= G.transDur) {
      if (G.transDir === 1) {
        const fn = G.transNext; G.transNext = null;
        G.transDir = -1; G.transT = 0;
        if (fn) fn();
      } else { G.transDir = 0; G.transT = 0; }
    }
  }
}

/* The whole of the player's physical life, in the order it happens. */
function updateSpirit() {
  if (PS.state === 'hurt') {
    Vis.scale = Math.max(0, Vis.scale - STEP * 4);
    body.x += body.vx * 0.2; body.y += body.vy * 0.2;
    body.vx *= 0.9; body.vy *= 0.9;
    if (PS.t >= MOVE.hurtTime) respawn();
    return;
  }
  if (PS.state === 'spawn') {
    Vis.scale = Math.min(1, Vis.scale + STEP / MOVE.respawnTime);
    if (PS.t >= MOVE.respawnTime) { PS.set('air'); PS.coyote = MOVE.coyote; }
    return;
  }
  if (PS.state === 'node') return;         // held; only a release moves us

  const wasAimable = canAim();
  const px = body.x, py = body.y;
  const fallSpeed = body.vy;

  // A hold is not a suspended fall: while the spirit has the wall, it owns its
  // own velocity outright and gravity is simply not applied. Letting gravity
  // accumulate under a hold made the grip creep downward a little every frame,
  // which reads as the character slipping when it should look planted.
  if (PS.state === 'cling') {
    PS.clingT += STEP;
    if (PS.clingT >= MOVE.clingTime) {
      PS.set('air'); PS.coyote = MOVE.coyote;
      integrate(body);
    } else {
      body.vy = PS.clingT < MOVE.clingGrip ? 0 : MOVE.clingSlide;
      body.vx = -PS.clingSide * 0.7;       // stay pressed against the surface
      if (PS.clingT > MOVE.clingGrip && ((PS.clingT * 60) | 0) % 7 === 0) {
        FX.spark(body.x - PS.clingSide * body.r, body.y, Math.PI / 2, 0.5, 0.9, 1,
                 HUE.spirit.rgb, { life: 0.3, size: 1.5, drag: 0.9 });
      }
    }
  } else {
    integrate(body);
    landingAssist(body);
  }

  const r = stepBody(body, true);

  if (r.lethal) { killSpirit(r.lethal.kind === 'void' ? 'void' : 'hazard'); return; }

  if (r.spring) {
    const s = r.spring;
    s.fire = 1;
    PS.set('air');
    body.burst = MOVE.burstTime * 0.7;
    PS.facing = Math.atan2(body.vy, body.vx);
    Vis.onBurst(PS.facing, 1);
    FX.shock(s.x, s.y, 10, 92, 0.45, HUE.spring.rgb, 4);
    FX.spark(s.x, s.y, PS.facing, 0.6, 5.5, 10, HUE.spring.hi,
             { life: 0.5, size: 2.8, shape: 1, len: 13, drag: 0.92 });
    cam.shake = Math.max(cam.shake, 6);
    cam.flash = Math.max(cam.flash, 0.16); cam.flashCol = HUE.spring.hi;
    Sfx.spring();
  } else if (r.floor) {
    // arriving on something you can stand on
    if (PS.state !== 'ground') {
      const hard = clamp(fallSpeed / MOVE.landHard, 0, 1);
      Vis.onLand(hard);
      FX.spark(body.x, body.y + body.r * 0.7, -Math.PI / 2, 1.5, 1 + hard * 3.2,
               2 + (hard * 5 | 0), HUE.spirit.rgb, { life: 0.34, size: 2, drag: 0.88, grav: 0.12 });
      if (hard > 0.4) {
        FX.shock(body.x, body.y + body.r * 0.6, 6, 22 + hard * 40, 0.3, HUE.spirit.rgb, 2);
        cam.shake = Math.max(cam.shake, hard * 4.5);
      }
      Sfx.land(hard);
      PS.set('ground');
    }
    PS.coyote = MOVE.coyote;
    PS.clingT = 0;
    body.vx *= MOVE.groundDrag;
    if (Math.abs(body.vx) < MOVE.groundStop) body.vx = 0;
  } else if (r.wall) {
    // taking hold of a wall for the first time; the hold itself is run above
    if (PS.state !== 'cling') {
      PS.set('cling');
      PS.clingT = 0;
      PS.clingSide = RES.wallNx < 0 ? -1 : 1;
      body.vx = 0; body.vy = 0;
      Vis.onWall(RES.wallNx);
      FX.spark(RES.hx, RES.hy, Math.atan2(RES.ny, RES.nx), 1.1, 2.4, 4, HUE.spirit.rgb,
               { life: 0.34, size: 1.9, drag: 0.9 });
      cam.shake = Math.max(cam.shake, 1.6);
      Sfx.cling();
    }
  } else {
    if (PS.state === 'ground' || PS.state === 'cling') { PS.set('air'); PS.coyote = MOVE.coyote; }
    if (PS.state === 'air') PS.coyote = Math.max(0, PS.coyote - STEP);
    if (r.ceil) body.vy = Math.max(body.vy, 0.4);
  }

  PS.speed = Math.hypot(body.vx, body.vy);
  if (PS.speed > 0.8) PS.facing = Math.atan2(body.vy, body.vx);
  PS.fallT = PS.state === 'air' ? PS.fallT + STEP : 0;

  checkTriggers(px, py);
  if (G.phase !== 'play') return;

  Vis.sample(body.x, body.y, PS.speed);
  if (!wasAimable && canAim()) Vis.onReady();
  updateAimBuffer();
}

/* ---- camera ------------------------------------------------------------
   It leads the spirit rather than chasing it: the faster you travel the more
   of the world ahead you are shown, which is what lets a long leap be aimed at
   something you cannot yet see. */
const CAM_PAD = 95;   // how far past the world edge the view may drift

/* ---- camera -------------------------------------------------------------
   The camera's job here is fairness. A leap toward something you cannot see is
   not a challenge, it is a guess, so while the player is aiming the view
   slides toward where the leap is pointed and eases out — the further the leap
   would go, the more of the world ahead is shown. Once travelling, the view
   leads the spirit rather than chasing it, which leaves the screen space in
   front of the character where the player needs to look. */
function updateCamera(snap) {
  let tx = body.x, ty = body.y;
  let zoom = 1;

  if (Aim.on && Aim.power > 0.02 && preview.n > 0) {
    // Frame the leap: the spirit at one end, where it is predicted to end up
    // at the other, and enough zoom to hold both with room around them. This
    // is the whole answer to "never ask for a leap toward somewhere you cannot
    // see" — the view is built from the actual prediction, not from a guess
    // based on how hard the player is pulling.
    const e = previewEnd(PVEND);
    tx = (body.x + e.x) / 2;
    ty = (body.y + e.y) / 2;
    const needW = Math.abs(e.x - body.x) / 2 + MOVE.camFrame;
    const needH = Math.abs(e.y - body.y) / 2 + MOVE.camFrame;
    zoom = clamp(Math.min(VW / (2 * needW), VH / (2 * needH)), MOVE.zoomAim, 1);
  } else if (Aim.on && Aim.power > 0.02) {
    const lead = lerp(MOVE.camLeadMin, MOVE.camLead, Aim.power);
    tx += Math.cos(Aim.angle) * lead;
    ty += Math.sin(Aim.angle) * lead;
    zoom = lerp(1, MOVE.zoomAim, Aim.power);
  } else {
    tx += clamp(body.vx * MOVE.camFollow, -200, 200);
    ty += clamp(body.vy * MOVE.camFollow, -170, 250);
    const sp = Math.hypot(body.vx, body.vy);
    zoom = lerp(1, MOVE.zoomFast, clamp(sp / MOVE.burstMax, 0, 1));
  }
  ty -= 30;                        // a little more sky than floor

  // However far the view wants to lead, the spirit has to stay comfortably on
  // screen — it sits in the rear portion of the frame, never off the edge of
  // it. Leading past this point stops showing the player their character,
  // which is worse than not showing them the destination.
  const halfW = VW / (2 * zoom), halfH = VH / (2 * zoom);
  const maxX = halfW * MOVE.camHold, maxY = halfH * MOVE.camHold;
  tx = body.x + clamp(tx - body.x, -maxX, maxX);
  ty = body.y + clamp(ty - body.y, -maxY, maxY);

  // Keep the view inside the world, allowing for the fact that zooming out
  // shows more of it. The bounds are padded rather than hard: clamping exactly
  // to the world put the spirit against the very edge of the screen whenever
  // it took hold of a boundary wall, with its aim ring half cut off.
  const hw = halfW - CAM_PAD, hh = halfH - CAM_PAD;
  tx = world.w <= hw * 2 ? world.w / 2 : clamp(tx, hw, world.w - hw);
  ty = world.h <= hh * 2 ? world.h / 2 : clamp(ty, hh, world.h - hh);

  cam.zoomT = zoom;
  if (snap) { cam.x = tx; cam.y = ty; cam.zoom = zoom; return; }
  const ease = Aim.on ? MOVE.camEaseAim : MOVE.camEase;
  cam.x += (tx - cam.x) * ease;
  cam.y += (ty - cam.y) * ease;
  // the zoom eases here rather than in the step, because a held aim skips the
  // rest of the step entirely and the view still has to keep moving
  cam.zoom += (cam.zoomT + cam.punch - cam.zoom) * MOVE.zoomEase;
}

/* ============================================================
   9. RENDERING
   ============================================================ */

let RS = 1;
let canvasRect = { left: 0, top: 0, width: VW, height: VH };

function fit() {
  const rect = canvasRect = dom.canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  /* Pixel budget, not a DPR multiplier. Fill rate is what kills this game on a
     phone: every frame writes a background plus a stack of additive glows. */
  const budget = Q.level < 1 ? PIXEL_BUDGET_LOW : PIXEL_BUDGET;
  const maxScale = Math.sqrt(budget / (rect.width * rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2, maxScale);
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (dom.canvas.width !== w || dom.canvas.height !== h) {
    dom.canvas.width = w; dom.canvas.height = h;
    RS = w / VW;
  }
}

/* ---- background: a gradient, a parallax lattice and far-off shapes ------ */
const bgGfx = {};
function drawBackground(c) {
  const g = grad(bgGfx, 'sky' + world.bg[0], () => {
    const gr = c.createLinearGradient(0, 0, 0, VH);
    gr.addColorStop(0, world.bg[0]);
    gr.addColorStop(1, world.bg[1]);
    return gr;
  });
  c.fillStyle = g;
  c.fillRect(0, 0, VW, VH);

  const acc = world.accent;
  // two parallax lattices: cheap, and they make the world read as deep
  for (let layer = 0; layer < 2; layer++) {
    const p = layer === 0 ? 0.25 : 0.5;
    const step = layer === 0 ? 96 : 150;
    const ox = -(cam.x * p) % step, oy = -(cam.y * p) % step;
    c.strokeStyle = rgba(acc, layer === 0 ? 0.05 : 0.075);
    c.lineWidth = 1;
    c.beginPath();
    for (let x = ox; x < VW + step; x += step) { c.moveTo(x, 0); c.lineTo(x, VH); }
    for (let y = oy; y < VH + step; y += step) { c.moveTo(0, y); c.lineTo(VW, y); }
    c.stroke();
  }
  // a soft glow that drifts with the camera, so motion is felt even in the sky
  const r = 260;
  const gg = grad(bgGfx, 'glow' + acc[0], () => {
    const q = c.createRadialGradient(0, 0, 0, 0, 0, r);
    q.addColorStop(0, rgba(acc, 0.16));
    q.addColorStop(1, rgba(acc, 0));
    return q;
  });
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.translate(VW * 0.5 - (cam.x * 0.12) % (VW * 2), VH * 0.34 - (cam.y * 0.12) % (VH * 2));
  c.fillStyle = gg;
  c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
  c.restore();
}

function inView(e, pad) {
  pad = pad || 80;
  const reach = (e.br || e.r || 30) + pad;
  // zooming out shows more world, so the cull has to widen with it
  return Math.abs(e.x - cam.x) < VW / (2 * cam.zoom) + reach &&
         Math.abs(e.y - cam.y) < VH / (2 * cam.zoom) + reach;
}

/* ---- ordinary surface: stone the spirit can rest on ---------------------
   Boundary walls are thousands of units long and only ever a screen-height of
   them is visible, so an unrotated surface is drawn clipped to the view. The
   lit top edge — the line the player actually aims at — is kept whenever the
   real edge is on screen. */
function drawSolid(c, e) {
  let hw = e.w / 2, hh = e.h / 2;
  let ox = 0, oy = 0, topReal = true;
  if (!e.a && (e.w > VW || e.h > VH)) {
    const vw = VW / cam.zoom, vh = VH / cam.zoom;
    const x0 = Math.max(e.x - hw, cam.x - vw), x1 = Math.min(e.x + hw, cam.x + vw);
    const y0 = Math.max(e.y - hh, cam.y - vh), y1 = Math.min(e.y + hh, cam.y + vh);
    if (x1 <= x0 || y1 <= y0) return;
    topReal = y0 <= e.y - hh + 0.5;
    ox = (x0 + x1) / 2 - e.x; oy = (y0 + y1) / 2 - e.y;
    hw = (x1 - x0) / 2; hh = (y1 - y0) / 2;
  }
  const w = hw * 2, h = hh * 2;
  const col = HUE.stone;
  c.save();
  c.translate(e.x + ox, e.y + oy);
  if (e.a) c.rotate(e.a);

  c.fillStyle = 'rgba(10,14,32,0.92)';
  roundRect(c, -hw, -hh, w, h, Math.min(9, hh, hw));
  c.fill();
  if (!topReal) { c.restore(); return; }     // off-screen slice: body only

  // The lit face is drawn in its own space anchored at the top edge, so the
  // cached gradient stays valid even when the body below it is being clipped
  // to a different height each frame.
  c.globalCompositeOperation = 'lighter';
  const faceH = Math.min(26, h);
  const g = grad(e.gfx, 'face', () => {
    const q = c.createLinearGradient(0, 0, 0, 26);
    q.addColorStop(0, rgba(col.hi, 0.3));
    q.addColorStop(1, rgba(col.rgb, 0));
    return q;
  });
  c.save();
  c.translate(0, -hh);
  c.fillStyle = g;
  roundRect(c, -hw, 0, w, faceH, Math.min(9, hh, hw));
  c.fill();
  c.restore();
  c.globalCompositeOperation = 'source-over';

  // a lit lip along the top edge: this is the line the player actually aims at
  c.strokeStyle = rgba(col.hi, 0.5);
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(-hw + 6, -hh + 1); c.lineTo(hw - 6, -hh + 1);
  c.stroke();
  c.strokeStyle = rgba(col.rgb, 0.3);
  c.lineWidth = 1.2;
  roundRect(c, -hw + 1, -hh + 1, w - 2, h - 2, Math.min(8, hh, hw));
  c.stroke();
  c.restore();
}

/* ---- spirit spring: a bloom that throws you the way it points ----------- */
function drawSpring(c, s) {
  const col = HUE.spring;
  const hw = s.w / 2, hh = s.h / 2;
  const fire = s.fire;
  const breathe = 0.5 + 0.5 * Math.sin(Vis.pulse * 2.2 + s.seed);
  c.save();
  c.translate(s.x, s.y);
  c.rotate(s.a);

  c.fillStyle = 'rgba(8,20,22,0.9)';
  roundRect(c, -hw, -hh, s.w, s.h, hh);
  c.fill();

  c.globalCompositeOperation = 'lighter';
  const g = grad(s.gfx, 'bloom', () => {
    const q = c.createRadialGradient(0, 0, 4, 0, 0, hw * 1.3);
    q.addColorStop(0, rgba(col.rgb, 0.5));
    q.addColorStop(1, rgba(col.rgb, 0));
    return q;
  });
  c.globalAlpha = 0.5 + breathe * 0.2 + fire * 0.5;
  c.fillStyle = g;
  c.beginPath(); c.ellipse(0, 0, hw * 1.3, hh * 3.2, 0, 0, TAU); c.fill();
  c.globalAlpha = 1;

  // petals, leaning outward, opening when it fires
  const open = 0.2 + breathe * 0.12 + fire * 0.7;
  c.strokeStyle = rgba(col.hi, 0.75);
  c.lineWidth = 2.4;
  const n = Math.max(3, Math.round(s.w / 42));
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const x = lerp(-hw + 12, hw - 12, t);
    const lean = (t - 0.5) * 22;
    c.beginPath();
    c.moveTo(x, hh * 0.2);
    c.quadraticCurveTo(x + lean * 0.5, -hh - 10 - open * 16, x + lean, -hh - 16 - open * 26);
    c.stroke();
  }
  // A stream of motes drifting along the launch direction. The arrow says
  // which way; this says it again, continuously, without the player having to
  // read anything — the direction is legible from across the level.
  const flow = (Vis.pulse * 0.55 + s.seed) % 1;
  for (let i = 0; i < 4; i++) {
    const u = (flow + i / 4) % 1;
    const d = -hh - 8 - u * 92;
    const fade = Math.sin(u * Math.PI);
    c.fillStyle = rgba(col.hi, 0.5 * fade * (0.5 + fire * 0.5));
    c.beginPath();
    c.arc((i % 2 ? 1 : -1) * 14 * (1 - u * 0.6), d, 2.6 * (1 - u * 0.4), 0, TAU);
    c.fill();
  }

  // the arrow: this is the promise the object makes
  c.strokeStyle = rgba(col.hi, 0.55 + fire * 0.45);
  c.lineWidth = 3;
  const tip = -hh - 34 - open * 16;
  c.beginPath();
  c.moveTo(0, tip + 20); c.lineTo(0, tip);
  c.moveTo(-8, tip + 9); c.lineTo(0, tip); c.lineTo(8, tip + 9);
  c.stroke();
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

/* ---- energy node: the thing that catches you mid-flight ----------------- */
function drawNode(c, n) {
  const col = HUE.node;
  const charged = n.cool <= 0;
  const live = charged ? 1 : 1 - n.cool / MOVE.nodeCool;
  const near = PS.state === 'air' && charged &&
               Math.hypot(body.x - n.x, body.y - n.y) < MOVE.nodeReach;
  const held = PS.node === n;
  const breathe = 0.5 + 0.5 * Math.sin(Vis.pulse * 2.6 + n.seed);

  c.save();
  c.translate(n.x, n.y);
  c.globalCompositeOperation = 'lighter';

  // reach halo — only while it could actually take you, so it never lies
  if (near || held) {
    c.strokeStyle = rgba(col.rgb, held ? 0.3 : 0.16 + breathe * 0.1);
    c.lineWidth = 2;
    c.setLineDash([6, 10]);
    c.lineDashOffset = -n.spin * 22;
    c.beginPath(); c.arc(0, 0, MOVE.nodeReach * (held ? 0.5 : 0.9), 0, TAU); c.stroke();
    c.setLineDash([]);
  }

  const g = grad(n.gfx, 'glow', () => {
    const q = c.createRadialGradient(0, 0, 2, 0, 0, n.r * 2.6);
    q.addColorStop(0, rgba(col.rgb, 0.55));
    q.addColorStop(0.4, rgba(col.rgb, 0.16));
    q.addColorStop(1, rgba(col.rgb, 0));
    return q;
  });
  c.globalAlpha = charged ? 0.6 + breathe * 0.25 + n.glow * 0.4 + (near ? 0.25 : 0) : 0.14;
  c.fillStyle = g;
  c.beginPath(); c.arc(0, 0, n.r * 2.6, 0, TAU); c.fill();
  c.globalAlpha = 1;

  // three drifting petals
  c.rotate(n.spin * 0.6);
  c.strokeStyle = rgba(charged ? col.hi : col.rgb, charged ? 0.8 : 0.28);
  c.lineWidth = 2.2;
  for (let i = 0; i < 3; i++) {
    const a = i * TAU / 3;
    c.save(); c.rotate(a);
    const rr = n.r * (0.92 + (charged ? breathe * 0.12 : 0) + (near ? 0.14 : 0));
    c.beginPath();
    c.moveTo(0, -rr * 0.35);
    c.quadraticCurveTo(rr * 0.8, -rr * 0.6, 0, -rr * 1.25);
    c.quadraticCurveTo(-rr * 0.8, -rr * 0.6, 0, -rr * 0.35);
    c.stroke();
    c.restore();
  }
  c.rotate(-n.spin * 0.6);

  // core
  c.fillStyle = rgba(charged ? col.hi : col.rgb, charged ? 0.9 : 0.3);
  c.beginPath(); c.arc(0, 0, n.r * (0.3 + (charged ? breathe * 0.07 : 0)), 0, TAU); c.fill();

  // recharge arc — dark nodes say exactly when they come back
  if (!charged) {
    c.strokeStyle = rgba(col.rgb, 0.5);
    c.lineWidth = 2.6;
    c.beginPath();
    c.arc(0, 0, n.r * 1.05, -Math.PI / 2, -Math.PI / 2 + TAU * live);
    c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

/* ---- checkpoint mote ---------------------------------------------------- */
function drawMote(c, m) {
  const col = HUE.mote;
  const breathe = 0.5 + 0.5 * Math.sin(Vis.pulse * 1.8 + m.seed);
  c.save();
  c.translate(m.x, m.y + (m.got ? 0 : Math.sin(Vis.pulse * 1.4 + m.seed) * 3));
  c.globalCompositeOperation = 'lighter';
  const g = grad(m.gfx, 'glow', () => {
    const q = c.createRadialGradient(0, 0, 1, 0, 0, m.r * 2.4);
    q.addColorStop(0, rgba(col.rgb, 0.5));
    q.addColorStop(1, rgba(col.rgb, 0));
    return q;
  });
  c.globalAlpha = (m.got ? 0.85 : 0.3) + breathe * 0.15 + m.pop * 0.5;
  c.fillStyle = g;
  c.beginPath(); c.arc(0, 0, m.r * 2.4 * (1 + m.pop * 0.3), 0, TAU); c.fill();
  c.globalAlpha = 1;

  c.strokeStyle = rgba(col.hi, m.got ? 0.85 : 0.35);
  c.lineWidth = 2;
  c.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = i * TAU / 6 + (m.got ? Vis.pulse * 0.5 : 0);
    const rr = m.r * (m.got ? 0.95 : 0.7);
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.closePath(); c.stroke();
  c.fillStyle = rgba(col.hi, m.got ? 0.9 : 0.3);
  c.beginPath(); c.arc(0, 0, m.r * 0.26, 0, TAU); c.fill();
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

/* ---- lethal growth and beams -------------------------------------------- */
function drawLethal(c, e) {
  const k = e.k === undefined ? 1 : e.k;
  const hw = e.w / 2, hh = e.h / 2;
  c.save();
  c.translate(e.x, e.y);
  if (e.a) c.rotate(e.a);

  if (e.spikes) {
    const horizontal = e.w >= e.h;
    const len = Math.max(e.w, e.h), depth = Math.min(e.w, e.h);
    const teeth = Math.max(2, Math.round(len / 26));
    c.fillStyle = 'rgba(14,6,20,0.92)';
    roundRect(c, -hw, -hh, e.w, e.h, 4); c.fill();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = rgba(DANGER, 0.3);
    c.strokeStyle = rgba(DANGER, 0.85);
    c.lineWidth = 1.6;
    c.beginPath();
    for (let i = 0; i < teeth; i++) {
      const t0 = -len / 2 + i * (len / teeth), t1 = t0 + len / teeth;
      const tm = (t0 + t1) / 2;
      if (horizontal) {
        c.moveTo(t0, depth / 2); c.lineTo(tm, -depth / 2); c.lineTo(t1, depth / 2);
      } else {
        c.moveTo(depth / 2, t0); c.lineTo(-depth / 2, tm); c.lineTo(depth / 2, t1);
      }
    }
    c.fill(); c.stroke();
    c.globalCompositeOperation = 'source-over';
    c.restore();
    return;
  }

  // beam: a dim rail always, a lit column while it is dangerous
  c.fillStyle = rgba([60, 20, 40], 0.5);
  roundRect(c, -hw * 0.3, -hh, e.w * 0.3, e.h, 3); c.fill();
  c.strokeStyle = rgba(DANGER, 0.22);
  c.lineWidth = 1.2;
  roundRect(c, -hw * 0.3, -hh, e.w * 0.3, e.h, 3); c.stroke();

  if (k > 0.02) {
    c.globalCompositeOperation = 'lighter';
    const g = grad(e.gfx, 'beam', () => {
      const q = c.createLinearGradient(-hw, 0, hw, 0);
      q.addColorStop(0, rgba(DANGER, 0));
      q.addColorStop(0.5, rgba(DANGER, 0.7));
      q.addColorStop(1, rgba(DANGER, 0));
      return q;
    });
    c.globalAlpha = k;
    c.fillStyle = g;
    c.fillRect(-hw * 1.5, -hh, e.w * 1.5, e.h);
    c.fillStyle = rgba([255, 220, 236], 0.85 * k);
    c.fillRect(-hw * 0.16, -hh, e.w * 0.16, e.h);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }
  c.restore();
}

/* ---- the gate ----------------------------------------------------------- */
function drawGate(c, g) {
  const col = HUE.gate;
  const breathe = 0.5 + 0.5 * Math.sin(Vis.pulse * 1.6);
  c.save();
  c.translate(g.x, g.y);
  c.globalCompositeOperation = 'lighter';
  const gg = grad(g.gfx, 'glow', () => {
    const q = c.createRadialGradient(0, 0, 4, 0, 0, g.r * 2.6);
    q.addColorStop(0, rgba(col.rgb, 0.5));
    q.addColorStop(0.45, rgba(col.rgb, 0.14));
    q.addColorStop(1, rgba(col.rgb, 0));
    return q;
  });
  c.globalAlpha = 0.6 + breathe * 0.2 + g.open * 0.5;
  c.fillStyle = gg;
  c.beginPath(); c.arc(0, 0, g.r * 2.6 * (1 + g.open * 0.3), 0, TAU); c.fill();
  c.globalAlpha = 1;

  for (let i = 0; i < 3; i++) {
    const rr = g.r * (0.5 + i * 0.26) * (1 + g.open * 0.2);
    const sp = Vis.pulse * (0.4 + i * 0.22) * (i % 2 ? -1 : 1);
    c.strokeStyle = rgba(col.hi, 0.5 - i * 0.12 + g.open * 0.3);
    c.lineWidth = 2 - i * 0.4;
    c.beginPath();
    c.arc(0, 0, rr, sp, sp + TAU * 0.68);
    c.stroke();
  }
  c.fillStyle = rgba(col.hi, 0.75 + breathe * 0.2);
  c.beginPath(); c.arc(0, 0, g.r * 0.2 * (1 + g.open), 0, TAU); c.fill();
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

/* ---- the spirit --------------------------------------------------------- */
const spiritGfx = {};

function drawTrail(c) {
  if (PS.speed < 3 || PS.state === 'hurt') return;
  const n = Math.min(Vis.trailN, Q.level < 1 ? (TRAIL_N >> 1) : TRAIL_N);
  if (n < 3) return;
  const k = clamp(PS.speed / 18, 0, 1);
  c.globalCompositeOperation = 'lighter';
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.beginPath();
  for (let i = 1; i < n; i++) {
    const p = Vis.trail[(Vis.trailN - n + i + TRAIL_N * 4) % TRAIL_N];
    if (i === 1) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
  }
  const head = Vis.trail[(Vis.trailN - 1 + TRAIL_N * 4) % TRAIL_N];
  const tail = Vis.trail[(Vis.trailN - n + TRAIL_N * 4) % TRAIL_N];
  const g = c.createLinearGradient(tail.x, tail.y, head.x, head.y);
  g.addColorStop(0, rgba(HUE.spirit.rgb, 0));
  g.addColorStop(0.6, rgba(HUE.spirit.rgb, 0.14 * k));
  g.addColorStop(1, rgba(HUE.spirit.hi, 0.45 * (0.3 + k * 0.7)));
  c.strokeStyle = g;
  c.lineWidth = body.r * (0.55 + k * 0.6);
  c.stroke();
  c.globalCompositeOperation = 'source-over';
}

/* A small creature, drawn procedurally: a soft body, two long ears that trail
   behind the motion, and eyes that look where it is going. It is a placeholder
   for a modelled character, but it has to read as alive from the first frame,
   so everything here is driven by the same squash/stretch/look values a rig
   would eventually consume. */
function drawSpirit(c) {
  if (Vis.scale <= 0.02) return;
  const r = body.r * Vis.scale;
  const col = HUE.spirit;

  drawTrail(c);

  let stretch = Vis.stretch, sang = Vis.stretchAng;
  let ox = 0, oy = 0;
  if (Aim.on && Aim.power > 0) {
    // wind up: lean back into the pull, the way a body loads a jump
    const a = Aim.angle + Math.PI;
    ox = Math.cos(a) * Aim.power * 9;
    oy = Math.sin(a) * Aim.power * 9;
    stretch = Aim.power * 0.2;
    sang = a;
  }
  const sq = Vis.squash;
  const bob = PS.state === 'ground' && PS.speed < 0.5 ? Math.sin(Vis.pulse * 2.4) * 1.5 : 0;
  const x = body.x + ox, y = body.y + oy + bob;

  const pop = 1 + Vis.landPop * 0.0 + Vis.readyPop * 0.06;

  c.save();
  c.translate(x, y);
  if (pop !== 1) c.scale(pop, pop);

  // bloom
  c.globalCompositeOperation = 'lighter';
  const bloom = grad(spiritGfx, 'bloom', () => {
    const q = c.createRadialGradient(0, 0, body.r * 0.3, 0, 0, body.r * 3);
    q.addColorStop(0, rgba(col.rgb, 0.5));
    q.addColorStop(0.35, rgba(col.rgb, 0.15));
    q.addColorStop(1, rgba(col.rgb, 0));
    return q;
  });
  const bs = (r / body.r) * (1 + Vis.flash * 0.3 + Aim.power * 0.22 + clamp(PS.speed / 20, 0, 1) * 0.2);
  c.save();
  c.scale(bs, bs);
  c.globalAlpha = Math.min(1, 0.6 + Vis.flash * 0.3 + Aim.power * 0.2 + Vis.readyPop * 0.15);
  c.fillStyle = bloom;
  c.beginPath(); c.arc(0, 0, body.r * 3, 0, TAU); c.fill();
  c.globalAlpha = 1;
  c.restore();
  c.globalCompositeOperation = 'source-over';

  // --- body, deformed along whichever of stretch / squash is dominant ---
  c.save();
  const ang = sq > stretch ? Vis.squashAng : sang;
  c.rotate(ang);
  c.scale(1 + stretch + sq * 0.36, 1 - stretch * 0.52 - sq * 0.3);
  c.rotate(-ang);
  c.scale(r / body.r, r / body.r);

  const look = Vis.lookT;
  const lx = Math.cos(look), ly = Math.sin(look);
  const R = body.r;

  // Ears: two tapers off the top of the head. They sit on screen-up rather
  // than on the look direction, which is what keeps the creature reading as
  // upright however it is flying, and they trail behind the motion — that lean
  // is most of what sells the thing as alive rather than as a decorated disc.
  const lean = clamp(-body.vx / 26, -0.75, 0.75) +
               (PS.state === 'cling' ? PS.clingSide * 0.3 : 0);
  const lift = clamp(-body.vy / 40, -0.3, 0.3);
  c.save();
  c.lineCap = 'round';
  for (let i = 0; i < 2; i++) {
    const side = i ? 1 : -1;
    const base = -Math.PI / 2 + side * 0.52;
    const wob = Math.sin(Vis.pulse * 2.3 + i * 1.9) * 0.08;
    const tipA = base + side * 0.1 + lean + wob;
    const midA = base + side * 0.04 + lean * 0.45 + wob * 0.5;
    const bx = Math.cos(base) * R * 0.66, by = Math.sin(base) * R * 0.66;
    const mx = Math.cos(midA) * R * 1.35, my = Math.sin(midA) * R * 1.35 - lift * R * 0.3;
    const tx = Math.cos(tipA) * R * 2.05, ty2 = Math.sin(tipA) * R * 2.05 - lift * R * 0.5;
    // outer ear
    c.strokeStyle = rgba([110, 170, 225], 0.85);
    c.lineWidth = R * 0.34;
    c.beginPath(); c.moveTo(bx, by); c.quadraticCurveTo(mx, my, tx, ty2); c.stroke();
    // inner ear, shorter and brighter, so each ear reads as a shape not a line
    c.strokeStyle = rgba(col.hi, 0.9);
    c.lineWidth = R * 0.15;
    c.beginPath();
    c.moveTo(bx, by);
    c.quadraticCurveTo(mx * 0.96, my * 0.96, tx * 0.82, ty2 * 0.82);
    c.stroke();
  }
  c.restore();

  // body
  const shell = grad(spiritGfx, 'shell', () => {
    const q = c.createRadialGradient(-R * 0.3, -R * 0.35, R * 0.1, 0, 0, R * 1.05);
    q.addColorStop(0, rgba(col.hi, 0.98));
    q.addColorStop(0.45, rgba(col.rgb, 0.88));
    q.addColorStop(1, rgba([90, 150, 210], 0.6));
    return q;
  });
  c.fillStyle = shell;
  c.beginPath(); c.ellipse(0, R * 0.05, R * 0.98, R * 1.04, 0, 0, TAU); c.fill();

  // a little tail wisp, opposite the look direction
  c.globalCompositeOperation = 'lighter';
  c.strokeStyle = rgba(col.rgb, 0.5);
  c.lineWidth = R * 0.24;
  c.beginPath();
  c.moveTo(-lx * R * 0.7, -ly * R * 0.7 + R * 0.3);
  c.quadraticCurveTo(-lx * R * 1.5, -ly * R * 1.5 + R * 0.7,
                     -lx * R * 1.9 + ly * R * 0.5, -ly * R * 1.9 - lx * R * 0.5 + R * 0.5);
  c.stroke();
  c.globalCompositeOperation = 'source-over';

  // Face. The eyes stay a level pair in the upper half of the body and only
  // shift a little toward where the spirit is looking — letting them orbit the
  // whole body with the look direction made it read as a ball with a pattern
  // on it rather than as a face.
  const gx = lx * R * 0.26, gy = ly * R * 0.16 - R * 0.16;
  const open = Vis.blink > 0 ? 0.1 : 1;
  for (let i = 0; i < 2; i++) {
    const side = i ? 1 : -1;
    const ex = gx + side * R * 0.32, ey = gy;
    c.fillStyle = 'rgba(12,20,42,0.94)';
    c.beginPath();
    c.ellipse(ex, ey, R * 0.17, R * 0.24 * open, 0, 0, TAU);
    c.fill();
    if (open > 0.5) {
      c.fillStyle = 'rgba(255,255,255,0.95)';
      c.beginPath();
      c.arc(ex + lx * R * 0.04 + side * R * 0.04, ey - R * 0.08, R * 0.065, 0, TAU);
      c.fill();
    }
  }
  // a faint blush of light under the eyes, so the face has some volume
  c.globalCompositeOperation = 'lighter';
  c.fillStyle = rgba(col.hi, 0.18);
  c.beginPath(); c.ellipse(gx, gy + R * 0.42, R * 0.32, R * 0.13, 0, 0, TAU); c.fill();
  // two small marks low on the body, breathing with the idle pulse
  c.fillStyle = rgba(col.hi, 0.42 + Math.sin(Vis.pulse * 3) * 0.14);
  for (let i = 0; i < 2; i++) {
    const side = i ? 1 : -1;
    c.beginPath(); c.arc(side * R * 0.34, R * 0.62, R * 0.08, 0, TAU); c.fill();
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
  c.restore();
}

/* ---- the wind-up guide --------------------------------------------------
   The preview is refreshed by the simulation rather than by the renderer,
   because the camera needs it too: what the view has to frame is not "some
   distance along the aim" but the place this leap actually ends up. */
let lastPvx = NaN, lastPvy = NaN, lastPvf = -99;

/* The velocity the current wind-up would produce, wall rules included. */
function aimVelocity(out) {
  const fromNode = PS.state === 'node';
  const pc = burstCurve(Aim.power);
  const sp = fromNode ? lerp(MOVE.nodeMin, MOVE.nodeBurst, pc)
                      : lerp(MOVE.burstMin, MOVE.burstMax, pc);
  if (PS.state === 'cling') return applyClingKick(Aim.angle, sp, out);
  out.x = Math.cos(Aim.angle) * sp;
  out.y = Math.sin(Aim.angle) * sp;
  return out;
}
const AIMV = { x: 0, y: 0 };

function refreshAimPreview() {
  if (!Aim.on || Aim.power <= 0.02) { preview.n = 0; return; }
  const v = aimVelocity(AIMV);
  const moving = world.movers.length || world.beams.length;
  if (v.x !== lastPvx || v.y !== lastPvy || (moving && frameCount - lastPvf > 3)) {
    lastPvx = v.x; lastPvy = v.y; lastPvf = frameCount;
    // Long enough to reach the end of most arcs. In a gravity game the arc IS
    // the information — hiding where you come down turns aiming into guesswork
    // — so the guide runs to the landing and fades out rather than being cut
    // short. It still stops at the first thing it meets, never the whole route.
    predict(body.x, body.y, v.x, v.y, lerp(520, 1000, Aim.power));
  }
}

/* Where this leap is expected to end, for the camera to frame. */
function previewEnd(out) {
  if (preview.n > 0) {
    const q = preview.pts[preview.n - 1];
    out.x = q.x; out.y = q.y;
  } else { out.x = body.x; out.y = body.y; }
  return out;
}
const PVEND = { x: 0, y: 0 };

function drawAim(c) {
  if (!Aim.on || Aim.power <= 0.02) return;
  const fromNode = PS.state === 'node';
  const col = fromNode ? HUE.node : HUE.spirit;
  const a = Aim.angle, p = Aim.power;
  const pv = preview;
  if (!pv.n) return;

  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < pv.n; i++) {
    const u = i / Math.max(1, pv.n - 1);
    const q = pv.pts[i];
    const fade = 1 - u * u * 0.8;
    c.fillStyle = rgba(i < 2 ? col.hi : col.rgb, 0.14 + fade * 0.55);
    c.beginPath(); c.arc(q.x, q.y, lerp(4.2, 1.5, u), 0, TAU); c.fill();
  }

  /* Where it ends. This is the whole point of the guide: the player must be
     able to answer "if I let go now, where do I come down?" without having to
     try it. A safe arrival gets a landing ring with a small pad marked under
     it; a lethal one gets a cross; a spring gets the spring's own colour so it
     reads as "you will be thrown from here", not "you will stop here". */
  if (pv.n > 0) {
    const q = pv.pts[pv.n - 1];
    const bl = 0.6 + 0.4 * Math.sin(Vis.pulse * 5);
    if (pv.danger) {
      c.strokeStyle = rgba(DANGER, 0.55 + bl * 0.4);
      c.lineWidth = 2.4;
      c.beginPath(); c.arc(q.x, q.y, 11, 0, TAU); c.stroke();
      c.beginPath();
      c.moveTo(q.x - 5, q.y - 5); c.lineTo(q.x + 5, q.y + 5);
      c.moveTo(q.x + 5, q.y - 5); c.lineTo(q.x - 5, q.y + 5);
      c.stroke();
    } else if (pv.spring) {
      c.strokeStyle = rgba(HUE.spring.hi, 0.5 + bl * 0.3);
      c.lineWidth = 2.4;
      c.beginPath(); c.arc(q.x, q.y, 12, 0, TAU); c.stroke();
    } else if (pv.land >= 0) {
      const safe = pv.landFloor;
      const lc = safe ? HUE.spirit.hi : [200, 220, 255];
      c.strokeStyle = rgba(lc, 0.45 + bl * 0.3);
      c.lineWidth = 2.4;
      c.beginPath(); c.arc(q.x, q.y, 11, 0, TAU); c.stroke();
      if (safe) {
        // a flat pad under the ring: "this is a surface you can stand on"
        c.strokeStyle = rgba(lc, 0.5);
        c.lineWidth = 2.6;
        c.beginPath();
        c.moveTo(q.x - 15, q.y + body.r + 1); c.lineTo(q.x + 15, q.y + body.r + 1);
        c.stroke();
      }
    }
  }

  // The aim band points the way you are going, toward the finger. Direct
  // aiming means the line and the leap are the same direction — there is
  // nothing to reverse in your head.
  const R = body.r + 14 + p * 8;
  const hx = body.x + Math.cos(a) * (R + p * 46);
  const hy = body.y + Math.sin(a) * (R + p * 46);
  const g = c.createLinearGradient(body.x, body.y, hx, hy);
  g.addColorStop(0, rgba(col.hi, 0.55));
  g.addColorStop(1, rgba(col.rgb, 0.05));
  c.strokeStyle = g;
  c.lineWidth = lerp(2, 5, p);
  c.lineCap = 'round';
  c.beginPath(); c.moveTo(body.x, body.y); c.lineTo(hx, hy); c.stroke();

  c.strokeStyle = rgba(col.rgb, 0.2);
  c.lineWidth = 2.4;
  c.beginPath(); c.arc(body.x, body.y, R, 0, TAU); c.stroke();
  c.strokeStyle = rgba(col.hi, 0.9);
  c.lineWidth = 3;
  c.beginPath(); c.arc(body.x, body.y, R, -Math.PI / 2, -Math.PI / 2 + TAU * p); c.stroke();

  c.save();
  c.translate(body.x, body.y); c.rotate(a);
  for (let i = 0; i < 3; i++) {
    const d = R + 9 + i * 7, s = 4 + i * 0.6;
    c.strokeStyle = rgba(col.hi, (0.9 - i * 0.26) * (0.4 + p * 0.6));
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(d - 3, -s); c.lineTo(d + 2, 0); c.lineTo(d - 3, s);
    c.stroke();
  }
  c.restore();
  c.globalCompositeOperation = 'source-over';
}

/* A quiet ring when control comes back, and a slow breath if you just sit. */
function drawReady(c) {
  if (G.phase !== 'play' || Aim.on) return;
  const col = PS.state === 'cling' ? HUE.spirit : HUE.spirit;
  c.globalCompositeOperation = 'lighter';
  if (Vis.readyPop > 0.01) {
    const u = 1 - Vis.readyPop;
    c.strokeStyle = rgba(col.hi, Vis.readyPop * 0.5);
    c.lineWidth = 2.4 - u * 1.2;
    c.beginPath(); c.arc(body.x, body.y, body.r + 3 + easeOut(u) * 24, 0, TAU); c.stroke();
  }
  if (canAim() && PS.t > 1.2 && PS.speed < 1) {
    const t = (Vis.pulse * 0.9) % 1;
    c.strokeStyle = rgba(col.hi, (1 - t) * 0.4 * clamp((PS.t - 1.2) / 0.6, 0, 1));
    c.lineWidth = 2;
    c.beginPath(); c.arc(body.x, body.y, body.r + 7 + t * 30, 0, TAU); c.stroke();
  }
  // a cling running out: the grip ring closes as the hold does
  if (PS.state === 'cling') {
    const left = 1 - PS.clingT / MOVE.clingTime;
    c.strokeStyle = rgba(HUE.spirit.hi, 0.3 + left * 0.4);
    c.lineWidth = 2.4;
    c.beginPath();
    c.arc(body.x, body.y, body.r + 9, -Math.PI / 2, -Math.PI / 2 + TAU * left);
    c.stroke();
  }
  if (G.deny > 0.01) {
    c.strokeStyle = rgba([210, 225, 255], G.deny * 0.45);
    c.lineWidth = 2;
    c.beginPath(); c.arc(body.x, body.y, body.r + 34 - (1 - G.deny) * 22, 0, TAU); c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
}

function drawParticles(c) {
  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < PMAX; i++) {
    const p = parts[i];
    if (!p.on) continue;
    const u = p.life / p.max;
    c.fillStyle = rgba(p.col, u * 0.85);
    if (p.shape === 1) {
      c.strokeStyle = rgba(p.col, u * 0.8);
      c.lineWidth = p.size;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(p.x, p.y);
      c.lineTo(p.x - Math.cos(p.ang) * p.len * u, p.y - Math.sin(p.ang) * p.len * u);
      c.stroke();
    } else {
      c.beginPath(); c.arc(p.x, p.y, p.size * (0.4 + u * 0.6), 0, TAU); c.fill();
    }
  }
  for (let i = 0; i < RMAX; i++) {
    const r = rings[i];
    if (!r.on) continue;
    const u = 1 - r.life / r.max;
    c.strokeStyle = rgba(r.col, (1 - u) * 0.55);
    c.lineWidth = r.w * (1 - u * 0.7);
    c.beginPath(); c.arc(r.x, r.y, lerp(r.r0, r.r1, easeOut(u)), 0, TAU); c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
}

function drawDust(c) {
  c.globalCompositeOperation = 'lighter';
  for (const d of DUST) {
    c.fillStyle = rgba(world.accent, 0.1 + 0.16 * d.z * (0.6 + 0.4 * Math.sin(d.t)));
    c.beginPath(); c.arc(d.x, d.y, d.s * d.z, 0, TAU); c.fill();
  }
  c.globalCompositeOperation = 'source-over';
}

function drawTransition(c) {
  if (G.transDir === 0) return;
  const u = clamp(G.transT / G.transDur, 0, 1);
  const k = G.transDir === 1 ? easeInOut(u) : 1 - easeInOut(u);
  if (k <= 0) return;
  const h = VH / 2 * k;
  const acc = world.accent;
  c.fillStyle = '#05060f';
  c.fillRect(0, 0, VW, h);
  c.fillRect(0, VH - h, VW, h);
  c.globalCompositeOperation = 'lighter';
  const g1 = c.createLinearGradient(0, h - 40, 0, h);
  g1.addColorStop(0, rgba(acc, 0)); g1.addColorStop(1, rgba(acc, 0.55));
  c.fillStyle = g1; c.fillRect(0, h - 40, VW, 40);
  const g2 = c.createLinearGradient(0, VH - h + 40, 0, VH - h);
  g2.addColorStop(0, rgba(acc, 0)); g2.addColorStop(1, rgba(acc, 0.55));
  c.fillStyle = g2; c.fillRect(0, VH - h, VW, 40);
  c.fillStyle = rgba([220, 240, 255], 0.85);
  c.fillRect(0, h - 1.5, VW, 1.5);
  c.fillRect(0, VH - h, VW, 1.5);
  c.globalCompositeOperation = 'source-over';
}

function render() {
  const c = ctx;
  c.setTransform(RS, 0, 0, RS, 0, 0);

  drawBackground(c);
  drawDust(c);

  c.save();
  // camera: centre on the spirit, plus shake and the small launch impulse
  const z = cam.zoom;
  c.translate(VW / 2 + cam.sx + cam.kx, VH / 2 + cam.sy + cam.ky);
  c.scale(z, z);
  c.translate(-cam.x, -cam.y);

  for (const e of world.lethal) if (inView(e)) drawLethal(c, e);
  for (const e of world.solids) if (inView(e)) drawSolid(c, e);
  for (const e of world.springs) if (inView(e)) drawSpring(c, e);
  for (const e of world.motes) if (inView(e)) drawMote(c, e);
  for (const e of world.nodes) if (inView(e, MOVE.nodeReach)) drawNode(c, e);
  drawGate(c, world.gate);

  drawReady(c);
  drawAim(c);
  const pose = Player.syncPose();
  if (Player.rig) Player.rig.sync(pose, c); else drawSpirit(c);
  drawParticles(c);

  c.restore();

  if (cam.flash > 0.01) {
    c.fillStyle = rgba(cam.flashCol, Math.min(0.5, cam.flash * 0.45));
    c.fillRect(0, 0, VW, VH);
  }
  if (G.fadeIn > 0) {
    c.fillStyle = `rgba(5,6,15,${clamp(G.fadeIn / 0.5, 0, 1) * 0.85})`;
    c.fillRect(0, 0, VW, VH);
  }
  drawTransition(c);
}

/* ---- rig seam ----------------------------------------------------------
   A modelled character (a Three.js GLTF on a transparent layer, most likely)
   needs no access to the simulation: it needs a pose and a state name, once a
   frame. Assigning `Player.rig = { sync(pose, ctx) {...} }` takes over the
   character drawing and nothing else in the game changes. */
const Player = {
  body, rig: null,
  pose: {
    x: 0, y: 0, vx: 0, vy: 0, speed: 0, facing: 0, look: 0,
    state: 'spawn', aimable: false, grounded: false, clinging: false,
    clingSide: 0, squash: 0, squashAng: 0, stretch: 0, stretchAng: 0,
    scale: 1, flash: 0, aiming: false, aimAngle: 0, aimPower: 0,
  },
  syncPose() {
    const p = this.pose;
    p.x = body.x; p.y = body.y; p.vx = body.vx; p.vy = body.vy;
    p.speed = PS.speed; p.facing = PS.facing; p.look = Vis.lookT;
    p.state = PS.state; p.aimable = canAim();
    p.grounded = PS.state === 'ground'; p.clinging = PS.state === 'cling';
    p.clingSide = PS.clingSide;
    p.squash = Vis.squash; p.squashAng = Vis.squashAng;
    p.stretch = Vis.stretch; p.stretchAng = Vis.stretchAng;
    p.scale = Vis.scale; p.flash = Vis.flash;
    p.aiming = Aim.on; p.aimAngle = Aim.angle; p.aimPower = Aim.power;
    return p;
  },
};

/* ============================================================
   10. INPUT
   ============================================================
   Touch first. Every interaction in the game is the same gesture — press,
   drag, release — and the press is allowed to land anywhere on the screen, so
   there is never a small target to hit. What the press MEANS is decided here
   and nowhere else.
   ============================================================ */

const gp = { x: 0, y: 0 };
function toWorld(e) {
  const vx = (e.clientX - canvasRect.left) * (VW / canvasRect.width);
  const vy = (e.clientY - canvasRect.top) * (VH / canvasRect.height);
  gp.x = (vx - VW / 2 - cam.sx - cam.kx) / cam.zoom + cam.x;
  gp.y = (vy - VH / 2 - cam.sy - cam.ky) / cam.zoom + cam.y;
  return gp;
}

let pointerId = null;
const buffered = { on: false, t: 0, id: null };
function clearBuffer() { buffered.on = false; buffered.id = null; }

/* Direct aiming: you drag TOWARD where you want to go, and that is where the
   spirit goes. Dragging up-right leaps up-right. The distance sets the power.

   The previous build pulled backwards like a slingshot, which needs explaining
   before anyone can use it and puts your finger on the wrong side of the
   screen — you end up covering the ground you are trying to read. */
function updateDrag(px, py) {
  const dx = px - Aim.anchorX, dy = py - Aim.anchorY;
  const d = Math.hypot(dx, dy);
  const cl = Math.min(d, MOVE.dragFull);
  Aim.power = d < MOVE.dragDead ? 0 : clamp((cl - MOVE.dragDead) / (MOVE.dragFull - MOVE.dragDead), 0, 1);
  if (d > MOVE.dragDead) Aim.angle = Math.atan2(dy, dx);   // leap the way you dragged
  Sfx.tensionUpdate(Aim.power);
}

function beginAim(ax, ay, px, py, id) {
  Aim.on = true;
  Aim.from = PS.state;
  Aim.anchorX = ax; Aim.anchorY = ay;
  Aim.held = 0;
  Aim.power = 0;
  Aim.angle = PS.state === 'cling' ? (PS.clingSide > 0 ? 0 : Math.PI) : -Math.PI / 2;
  lastPvx = NaN;
  pointerId = id;
  if (id !== null && id !== undefined && dom.canvas.setPointerCapture) {
    try { dom.canvas.setPointerCapture(id); } catch (err) {}
  }
  Sfx.tensionStart();
  updateDrag(px, py);
  setHint('');
}

/* Take hold of a node: it draws the spirit in, and the world stops while the
   player decides where to go. */
function grabNode(n, px, py, id) {
  PS.node = n;
  PS.set('node');
  n.glow = 1;
  body.vx = 0; body.vy = 0; body.burst = 0;
  FX.shock(n.x, n.y, n.r * 2.2, n.r * 0.8, 0.3, HUE.node.rgb, 2);
  FX.spark(n.x, n.y, 0, Math.PI, 1.8, 6, HUE.node.hi, { life: 0.4, size: 2, drag: 0.9 });
  cam.punch = 0.035;
  Sfx.nodeCatch();
  beginAim(px, py, px, py, id);
}

function onDown(e) {
  if (Aim.on || (e.button !== undefined && e.button !== 0)) return;
  if (buffered.on && e.pointerId !== buffered.id) return;
  Sfx.unlock();
  clearBuffer();
  if (G.phase === 'done') return;
  if (e.target === dom.restart || dom.restart.contains(e.target)) return;
  if (G.phase !== 'play') return;
  if (PS.state === 'hurt' || PS.state === 'spawn') return;

  canvasRect = dom.canvas.getBoundingClientRect();
  const p = toWorld(e);

  if (canAim()) {
    // The drag is always measured from wherever the finger landed, never from
    // the creature. That way a press starts at zero power no matter where on
    // the screen it happened, and "drag the way you want to go" means exactly
    // that — the gesture is the same whether you touched the spirit or not.
    beginAim(p.x, p.y, p.x, p.y, e.pointerId);
    e.preventDefault();
    return;
  }

  const n = nodeInReach();
  if (n) { grabNode(n, p.x, p.y, e.pointerId); e.preventDefault(); return; }

  // Nothing to act on yet. Hold the press briefly: if a wall, the ground or a
  // node arrives within the buffer window, it is spent there instead of lost.
  if (PS.state === 'air') {
    buffered.on = true; buffered.t = 0; buffered.id = e.pointerId;
    e.preventDefault();
    return;
  }
  G.deny = 1;
}

/* Spend a held press the moment something can answer it. */
function updateAimBuffer() {
  if (!buffered.on) return;
  buffered.t += STEP;
  if (G.phase !== 'play' || PS.state === 'hurt' || PS.state === 'spawn') { clearBuffer(); return; }
  if (canAim()) {
    const id = buffered.id; clearBuffer();
    beginAim(body.x, body.y, body.x, body.y, id);
    return;
  }
  const n = nodeInReach();
  if (n) { const id = buffered.id; clearBuffer(); grabNode(n, body.x, body.y, id); return; }
  if (buffered.t >= MOVE.buffer) { clearBuffer(); G.deny = 1; }
}

function onMove(e) {
  if (buffered.on && e.pointerId === buffered.id) { e.preventDefault(); return; }
  if (!Aim.on || (pointerId !== null && e.pointerId !== pointerId)) return;
  const p = toWorld(e);
  updateDrag(p.x, p.y);
  e.preventDefault();
}

function onUp(e) {
  if (buffered.on && e.pointerId === buffered.id) { clearBuffer(); e.preventDefault(); return; }
  if (!Aim.on || (pointerId !== null && e.pointerId !== pointerId)) return;
  const p = Aim.power, a = Aim.angle;
  const ok = canAim();
  Aim.on = false;
  pointerId = null;
  Sfx.tensionStop();
  if (p > 0.02 && ok) doBurst(a, p);
  else if (PS.state === 'node') { PS.node.cool = 0.5; PS.node = null; PS.set('air'); }
  Aim.power = 0;
  e.preventDefault();
}

function cancelAim() {
  if (PS.state === 'node' && PS.node) { PS.node.cool = 0.5; PS.node = null; PS.set('air'); }
  Aim.clear();
  pointerId = null;
  clearBuffer();
  lastPvx = NaN;
  Sfx.tensionStop();
}

dom.canvas.addEventListener('pointerdown', onDown, { passive: false });
window.addEventListener('pointermove', onMove, { passive: false });
window.addEventListener('pointerup', onUp, { passive: false });
window.addEventListener('pointercancel', cancelAim);
dom.canvas.addEventListener('lostpointercapture', cancelAim);
window.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
window.addEventListener('touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });

dom.restart.addEventListener('click', (e) => { e.stopPropagation(); Sfx.unlock(); restartLevel(); });

let muted = false;
function applyMute(v) {
  muted = v;
  Sfx.setMuted(v);
  dom.sound.classList.toggle('muted', v);
  dom.sound.setAttribute('aria-pressed', String(!v));
  try { localStorage.setItem('flux.muted', v ? '1' : '0'); } catch (err) {}
}
dom.sound.addEventListener('click', (e) => {
  e.stopPropagation(); Sfx.unlock(); applyMute(!muted); if (!muted) Sfx.ui();
});
dom.endRestart.addEventListener('click', () => { Sfx.unlock(); Sfx.ui(); restartRun(); });

const DEV = (() => {
  try {
    if (/[?&]dev=1/.test(location.search)) { localStorage.setItem('flux.dev', '1'); return true; }
    if (/[?&]dev=0/.test(location.search)) { localStorage.removeItem('flux.dev'); return false; }
    return localStorage.getItem('flux.dev') === '1';
  } catch (err) { return /[?&]dev=1/.test(location.search); }
})();

window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') restartLevel();
  if (e.key === 'm' || e.key === 'M') applyMute(!muted);
  if (DEV && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    e.preventDefault();
    cancelAim();
    G.transDir = 0;
    startLevel(clamp(G.levelIndex + (e.key === 'ArrowRight' ? 1 : -1), 0, LEVELS.length - 1));
  }
  if (DEV && (e.key === 'f' || e.key === 'F')) {
    fpsOn = !fpsOn;
    dom.fps.classList.toggle('hidden', !fpsOn);
    fpsFrames = 0; fpsSince = performance.now();
  }
});

window.addEventListener('resize', fit);
window.addEventListener('orientationchange', () => setTimeout(fit, 120));
if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(dom.canvas);

/* ============================================================
   11. MAIN LOOP
   ============================================================ */

const DT_MAX = 1 / 15;

let last = 0, acc = 0, frameCount = 0, doneFrames = 0;
let fpsOn = false, fpsFrames = 0, fpsSince = 0;
let frameId = 0;

function frame(now) {
  frameId = requestAnimationFrame(frame);
  if (document.hidden) return;
  if (G.phase === 'done' && G.transDir === 0 && doneFrames >= 3) { last = now; acc = 0; return; }
  if (!last) last = now;
  const rawDt = (now - last) / 1000;
  let dt = rawDt;
  last = now;
  const workStart = performance.now();

  if (dt > DT_MAX) dt = DT_MAX;
  acc += dt;
  let guard = 0;
  while (acc >= STEP && guard < 4) { simStep(); acc -= STEP; guard++; }
  if (acc > STEP) acc = 0;

  if (rawDt > 0 && rawDt < 0.25) Q.avg += (rawDt * 1000 - Q.avg) * 0.08;
  if (!guard) return;
  frameCount++;
  render();
  if (G.phase === 'done' && G.transDir === 0) doneFrames++;
  Q.work += (performance.now() - workStart - Q.work) * 0.08;

  if (Q.level === 1) {
    if (Q.avg > 21 || Q.work > 14) { if (++Q.bad > 40) { Q.level = 0; Q.particleScale = 0.55; Q.bad = 0; fit(); } }
    else Q.bad = 0;
  } else {
    if (Q.avg < 18 && Q.work < 7) { if (++Q.good > 480) { Q.level = 1; Q.particleScale = 1; Q.good = 0; fit(); } }
    else Q.good = 0;
  }

  if (fpsOn) {
    fpsFrames++;
    if (now - fpsSince >= 500) {
      const f = Math.round(fpsFrames * 1000 / (now - fpsSince));
      dom.fps.textContent = f + ' FPS · ' + Q.avg.toFixed(1) + ' ms · ' + PS.state;
      fpsFrames = 0; fpsSince = now;
    }
  }
}

document.addEventListener('visibilitychange', () => {
  cancelAnimationFrame(frameId);
  cancelAim();
  last = 0; acc = 0;
  Q.bad = 0; Q.good = 0;
  fpsFrames = 0; fpsSince = performance.now();
  if (!document.hidden) { fit(); frameId = requestAnimationFrame(frame); }
});

try { if (localStorage.getItem('flux.muted') === '1') applyMute(true); } catch (err) {}
if (DEV) { fpsOn = true; dom.fps.classList.remove('hidden'); }

startLevel(0);
fit();
frameId = requestAnimationFrame(frame);

/* ---- debug / automation surface ---- */
window.FLUX = {
  G, body, PS, Vis, Aim, world, LEVELS, MOVE, Q, Player, cam,
  go: (i) => startLevel(clamp(i | 0, 0, LEVELS.length - 1)),
  burst: (ang, power) => { if (canAim()) doBurst(ang, clamp(power, 0, 1)); },
  tick: (n) => { for (let i = 0; i < n; i++) simStep(); },
  state: () => PS.state,
  aimable: () => canAim(),
  mute: (v) => { muted = !!v; Sfx.setMuted(muted); },
  bench: (n) => {
    n = n || 120;
    render();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) render();
    const ms = (performance.now() - t0) / n;
    return { frameMs: +ms.toFixed(3), budgetPct: +(ms / 16.67 * 100).toFixed(1) };
  },
};


})();
