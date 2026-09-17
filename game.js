/* ============================================================
   FLUX — neon physics puzzle prototype
   ------------------------------------------------------------
   Sections
     1. Config & math
     2. Audio (Web Audio synthesis)
     3. Particles & shockwaves
     4. Level data
     5. World building
     6. Physics & collision
     7. Game state machine
     8. Rendering
     9. Input
    10. Main loop
   ============================================================ */
(() => {
'use strict';

/* ============================================================
   1. CONFIG & MATH
   ============================================================ */

const VW = 540, VH = 960;          // virtual playfield units
const STEP = 1 / 60;               // fixed physics step (seconds)

const CFG = {
  orbR: 15,
  maxDrag: 168,        // pull distance for full power
  minDrag: 12,         // below this a release is treated as a cancel
  grabRadius: 132,     // "close enough to the character" for a centred pull
  airGrabRadius: 96,   // forgiving touch target for catching a flying character
  paintSpeed: 1.6,     // min contact speed to take a wall colour
  iceSpeed: 5.5,       // min contact speed to damage ice
  paintCooldown: 0.12, // seconds between colour transfers
};

/* ---------------------------------------------------------------------------
   MOVEMENT TUNING
   ---------------------------------------------------------------------------
   The single source of truth for how the character moves. Nothing outside this
   table may invent a speed threshold, a damping factor or a restitution value:
   if a rule needs a number, it is named here.

   All speeds are in playfield units per fixed 1/60 s step. A useful reference:
   the playfield is 540 x 960 units, so 10 units/step crosses the short side in
   about nine tenths of a second.

   The feel this describes is deliberately *not* realistic. Drag is almost
   absent while the character is genuinely travelling — a leap carries, and
   chained rebounds keep their energy — and then rises steeply once it drops
   into the settle band, so the character lands and comes to rest decisively
   instead of creeping to a halt. Restitution works the same way round: hard
   impacts rebound hard, and contacts softer than `bounceStick` are fully
   inelastic, which is what kills micro-bouncing and surface vibration.
--------------------------------------------------------------------------- */
const MOVE = {
  /* --- launch ---------------------------------------------------------- */
  launchMin:   4.2,     // a deliberate nudge, never a dribble
  launchMax:   19.5,    // full-commitment leap
  launchCurve: 0.42,    // 0 = linear power ramp, 1 = fully quadratic
  dashTime:    0.13,    // seconds of drag-free burst straight after a launch

  /* --- speed bands ------------------------------------------------------
     Every state decision in the game reads these and only these. */
  speedStop:   0.40,    // below this the character is parked outright
  speedRest:   1.30,    // settled: idle bob, ready ring, no trail
  speedSettle: 3.60,    // still drifting but controllable -> aiming allowed
  speedFlow:   11.0,    // ordinary travel
  speedDash:   17.0,    // committed dash: strongest trail and glow
  speedMax:    30.0,    // hard clamp, for physics stability only

  /* --- drag, per band (velocity retained per step) ---------------------- */
  dragFlow:    0.9930,  // at or above speedFlow — momentum is preserved
  dragSettle:  0.9800,  // in the settle band — bleeds off with intent
  dragRest:    0.9300,  // near standstill — parks instead of creeping

  /* --- surface response ------------------------------------------------- */
  bounceStick: 1.15,    // normal speed below this: inelastic, no micro-bounce
  bounceMin:   0.32,    // restitution just above the stick threshold
  bounceMax:   0.84,    // restitution at bounceRamp and beyond
  bounceRamp:  9.0,     // normal speed at which bounceMax is reached
  slide:       0.988,   // tangential retention — grazing a wall keeps flow
  slop:        0.06,    // extra separation so a resting contact stays quiet
  bumperMax:   26.0,    // ceiling on bumper output

  /* --- impact feedback --------------------------------------------------- */
  hitQuiet:    1.20,    // impacts below this produce no burst and no sound
  hitCool:     0.05,    // seconds between impact sounds (no machine-gunning)

  /* --- input forgiveness -------------------------------------------------
     A touch that lands a fraction of a second too early is the player being
     eager, not the player being wrong. Below `catchSpeed` an early touch is
     held and spent the instant control returns, rather than being thrown away
     with a refusal. Above it the character is genuinely committed and the
     touch is refused, so this can never become a free mid-air dash.

     `catchSpeed` is chosen so that a character at that speed reaches the
     settle band inside `aimBuffer` — the two numbers have to agree, or a
     buffered touch expires with a refusal instead of being spent. */
  catchSpeed:  6.0,     // fast enough to buffer a touch, not to act on one
  aimBuffer:   0.60,    // seconds an early touch is held for
};

/* Power ramp: fine control at the low end, punch at the top. */
const launchPower = (p) => p * (1 - MOVE.launchCurve) + p * p * MOVE.launchCurve;
const launchSpeed = (p) => lerp(MOVE.launchMin, MOVE.launchMax, launchPower(clamp(p, 0, 1)));

const FIELD = { x0: 15, y0: 93, x1: 525, y1: 941 };
const FAIL_HOLD = 0.45;      // seconds from failure to a live orb again

// backing-store budget in device pixels (see fit())
const PIXEL_BUDGET = 1100000;
const PIXEL_BUDGET_LOW = 700000;

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
const easeInOut = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const DEG = Math.PI / 180;

const ENERGY = {
  violet:  { rgb: [166, 108, 255], hi: [238, 224, 255] },
  cyan:    { rgb: [ 46, 226, 255], hi: [216, 250, 255] },
  magenta: { rgb: [255,  74, 186], hi: [255, 214, 240] },
  orange:  { rgb: [255, 150,  60], hi: [255, 232, 198] },
  lime:    { rgb: [178, 255,  88], hi: [238, 255, 210] },
};
const NEUTRAL = { rgb: [180, 200, 255], hi: [240, 246, 255] };
const DANGER = [255, 45, 110];

const energy = (k) => (k && ENERGY[k]) || NEUTRAL;
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

const clone = (o) => JSON.parse(JSON.stringify(o));

/* ---- adaptive quality -------------------------------------------------
   Only decorative work scales: physics, collision and input never change,
   so the game plays identically on a slow phone and a fast desktop. */
const Q = {
  level: 1,          // 1 = full, 0 = reduced decoration
  avg: 16.7,         // rolling frame time (ms)
  work: 0,          // CPU submission time, separate from display refresh rate
  bad: 0, good: 0,
  particleScale: 1,
};

/* Gradients are built once and then modulated with globalAlpha. Rebuilding a
   gradient every frame costs an allocation *and* a colour-ramp rasterisation;
   the shapes here never change size, only brightness. */
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
  const MIX = {                 // one place to balance the whole game
    master: 0.42,
    launch: 0.5,
    bumper: 0.5,
    node:   0.5,
    bounce: 0.18,
    shift:  0.42,
    portal: 0.5,
    fail:   0.36,
    reject: 0.3,
    ui:     0.22,
    sweep:  0.3,
  };

  let ctx = null, master = null, bus = null, air = null, noiseBuf = null;
  let on = true, ready = false, tension = null;
  let voices = 0;               // crude polyphony guard
  let lastBounce = -1;

  function build() {
    if (ctx || !on) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { on = false; return null; }
    try { ctx = new AC(); } catch (e) { on = false; return null; }

    master = ctx.createGain();
    master.gain.value = MIX.master;

    // gentle ceiling so overlapping events never stack into something harsh
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22; comp.knee.value = 26; comp.ratio.value = 6;
    comp.attack.value = 0.006; comp.release.value = 0.25;

    // takes the edge off every voice at once
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 7200;
    tone.Q.value = 0.4;

    bus = ctx.createGain();
    bus.connect(tone); tone.connect(comp); comp.connect(master);
    master.connect(ctx.destination);

    // a two-tap damped delay: costs almost nothing and gives the kit space
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

  /* one soft tone: sine/triangle with an eased envelope, optional glide */
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

  /* airy layer: band-passed noise, never bright enough to hiss */
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

  /* --- continuous drag tension: one voice, held, gently filtered --- */
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

    /* energy released: low pulse + gentle rise + a breath of air */
    launch(p) {
      const v = MIX.launch;
      tone({ type: 'sine', f0: 88 + p * 34, f1: 176 + p * 90, dur: 0.3, glide: 0.13,
             peak: 0.2 * v, attack: 0.008, lp: 1400, lp1: 620, send: 0.12 });
      tone({ type: 'triangle', f0: 232 + p * 120, f1: 420 + p * 210, dur: 0.24, glide: 0.11,
             peak: 0.085 * v, attack: 0.012, lp: 2400, send: 0.16 });
      air_noise({ dur: 0.2, peak: 0.05 * v, f0: 620, f1: 2100 + p * 900, q: 0.7, cap: 4200, send: 0.2 });
    },

    /* muted tonal pop; quiet, rate-limited, and scaled by impact */
    bounce(v) {
      const s = clamp((v - 2.2) / 12, 0, 1);
      if (s <= 0.02) return;
      const now = ready ? ctx.currentTime : 0;
      if (now - lastBounce < 0.055) return;     // no machine-gun contacts
      lastBounce = now;
      const m = MIX.bounce * (0.35 + s * 0.65);
      tone({ type: 'sine', f0: 168 + s * 150, f1: 112 + s * 70, dur: 0.075, glide: 0.06,
             peak: 0.5 * m, attack: 0.004, lp: 1100 + s * 900 });
      air_noise({ dur: 0.045, peak: 0.34 * m, f0: 900 + s * 1200, f1: 500, q: 1.2, cap: 3600 });
    },

    /* soft bassy boop with an upward tail */
    bumper(soft) {
      const v = MIX.bumper * (soft ? 0.82 : 1);
      tone({ type: 'sine', f0: 76, f1: 132, dur: 0.26, glide: 0.1,
             peak: 0.34 * v, attack: 0.006, lp: 900, send: 0.1 });
      tone({ type: 'triangle', f0: 262, f1: 524, dur: 0.22, glide: 0.12,
             peak: 0.11 * v, attack: 0.012, lp: 2600, send: 0.2 });
      air_noise({ dur: 0.08, peak: 0.06 * v, f0: 1400, f1: 700, q: 1.1, cap: 4000 });
    },

    /* colour change: short shimmer, ascending, with a sparkle on top */
    shift() {
      const v = MIX.shift;
      const root = 392;                                  // G4
      [1, 1.25, 1.5].forEach((m, i) => {                 // major triad, soft
        tone({ type: 'sine', f0: root * m * 0.86, f1: root * m, dur: 0.5 - i * 0.06,
               glide: 0.16, peak: (0.16 - i * 0.035) * v, attack: 0.016 + i * 0.008,
               delay: i * 0.028, lp: 4200, send: 0.34 });
      });
      tone({ type: 'triangle', f0: root * 2, f1: root * 3, dur: 0.3, glide: 0.2,
             peak: 0.05 * v, attack: 0.02, delay: 0.04, lp: 5200, send: 0.4 });
      air_noise({ dur: 0.34, peak: 0.055 * v, f0: 1800, f1: 5200, q: 0.8, cap: 6000,
                  attack: 0.05, send: 0.4 });
    },

    /* exit: a soft chord that opens upward, airy tail, no fanfare */
    portal() {
      const v = MIX.portal;
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

    /* energy draining away — soft, short, no buzzer */
    fail() {
      const v = MIX.fail;
      tone({ type: 'sine', f0: 210, f1: 62, dur: 0.46, glide: 0.34,
             peak: 0.3 * v, attack: 0.008, lp: 1500, lp1: 220, send: 0.2 });
      tone({ type: 'triangle', f0: 314, f1: 96, dur: 0.34, glide: 0.26,
             peak: 0.1 * v, attack: 0.012, lp: 1200, send: 0.25 });
      air_noise({ dur: 0.36, peak: 0.07 * v, f0: 1700, f1: 240, q: 0.7, cap: 3400, send: 0.3 });
    },

    /* portal refusing the wrong signature: a dull, polite thud */
    reject() {
      const v = MIX.reject;
      tone({ type: 'sine', f0: 190, f1: 140, dur: 0.16, glide: 0.1,
             peak: 0.3 * v, attack: 0.006, lp: 700 });
      air_noise({ dur: 0.1, peak: 0.06 * v, f0: 460, f1: 240, q: 1.4, cap: 2200 });
    },

    /* ice: a dry, glassy tick — distinct from a wall bounce but never sharp */
    iceCrack() {
      const v = MIX.bounce * 2.2;
      air_noise({ dur: 0.1, peak: 0.5 * v, f0: 2600, f1: 1100, q: 2.2, cap: 5200 });
      tone({ type: 'triangle', f0: 620, f1: 430, dur: 0.1, glide: 0.07,
             peak: 0.3 * v, attack: 0.004, lp: 3000 });
    },
    /* ice breaking: the tick opens into a soft glassy wash */
    iceBreak() {
      const v = MIX.shift;
      air_noise({ dur: 0.42, peak: 0.24 * v, f0: 3200, f1: 700, q: 0.8, cap: 6000, send: 0.4 });
      tone({ type: 'sine', f0: 880, f1: 494, dur: 0.34, glide: 0.2,
             peak: 0.26 * v, attack: 0.006, lp: 4200, send: 0.3 });
      tone({ type: 'triangle', f0: 1320, f1: 740, dur: 0.26, glide: 0.18,
             peak: 0.12 * v, attack: 0.01, delay: 0.03, lp: 5000, send: 0.4 });
      tone({ type: 'sine', f0: 160, f1: 96, dur: 0.24, glide: 0.16,
             peak: 0.2 * v, attack: 0.006, lp: 900 });
    },
    /* crystal yielding to its own colour: a bright, short bell burst */
    crystal() {
      const v = MIX.shift;
      [659.3, 987.8, 1318.5].forEach((f, i) => {
        tone({ type: 'sine', f0: f, f1: f * 1.02, dur: 0.6 - i * 0.1,
               peak: (0.2 - i * 0.05) * v, attack: 0.006 + i * 0.004,
               delay: i * 0.022, lp: 5200, send: 0.45 });
      });
      air_noise({ dur: 0.36, peak: 0.16 * v, f0: 2400, f1: 900, q: 1.1, cap: 6000, send: 0.4 });
    },
    /* void: a soft downward slide, nothing percussive */
    failVoid() {
      const v = MIX.fail;
      tone({ type: 'sine', f0: 240, f1: 52, dur: 0.66, glide: 0.56,
             peak: 0.26 * v, attack: 0.03, lp: 1100, lp1: 200, send: 0.35 });
      air_noise({ dur: 0.5, peak: 0.05 * v, f0: 900, f1: 160, q: 0.6, cap: 2400,
                  attack: 0.1, send: 0.35 });
    },
    /* laser: a short energy slice, bright but filtered well below harsh */
    failLaser() {
      const v = MIX.fail;
      air_noise({ dur: 0.16, peak: 0.34 * v, f0: 4200, f1: 900, q: 1.6, cap: 5400 });
      tone({ type: 'triangle', f0: 720, f1: 180, dur: 0.3, glide: 0.2,
             peak: 0.22 * v, attack: 0.004, lp: 2600, send: 0.25 });
      tone({ type: 'sine', f0: 150, f1: 70, dur: 0.28, glide: 0.2, peak: 0.2 * v, attack: 0.006, lp: 800 });
    },
    /* out of energy: a power-down, no sting */
    failPower() {
      const v = MIX.fail;
      [392, 294, 196].forEach((f, i) => {
        tone({ type: 'sine', f0: f, f1: f * 0.82, dur: 0.42 - i * 0.05, glide: 0.3,
               peak: (0.17 - i * 0.04) * v, attack: 0.02, delay: i * 0.08, lp: 2400, send: 0.3 });
      });
      air_noise({ dur: 0.4, peak: 0.04 * v, f0: 700, f1: 200, q: 0.7, cap: 2200, attack: 0.08 });
    },
    ui() {
      tone({ type: 'sine', f0: 660, f1: 520, dur: 0.075, glide: 0.06,
             peak: 0.34 * MIX.ui, attack: 0.006, lp: 2600, send: 0.16 });
    },

    /* level change whoosh, felt more than heard */
    sweep() {
      const v = MIX.sweep;
      air_noise({ dur: 0.5, peak: 0.07 * v, f0: 300, f1: 2600, q: 0.5, cap: 4200,
                  attack: 0.14, send: 0.35 });
      tone({ type: 'sine', f0: 110, f1: 240, dur: 0.44, glide: 0.34,
             peak: 0.16 * v, attack: 0.06, lp: 1200, send: 0.2 });
    },

    complete() {
      const v = MIX.portal;
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

const PMAX = 64;            // hard cap on simultaneous particles
const parts = new Array(PMAX);
for (let i = 0; i < PMAX; i++) {
  parts[i] = { on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 2,
               col: NEUTRAL.rgb, drag: 0.94, shape: 0, ang: 0, spin: 0, len: 0, grow: 0 };
}
let pCursor = 0;
function newPart() {
  for (let i = 0; i < PMAX; i++) {
    const p = parts[(pCursor + i) % PMAX];
    if (!p.on) { pCursor = (pCursor + i + 1) % PMAX; return p; }
  }
  const p = parts[pCursor]; pCursor = (pCursor + 1) % PMAX; return p;
}

const RMAX = 10;
const rings = new Array(RMAX);
for (let i = 0; i < RMAX; i++) rings[i] = { on: false, x: 0, y: 0, r0: 0, r1: 0, life: 0, max: 1, col: NEUTRAL.rgb, w: 3 };
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
      p.size = rand(1.4, 3.2); p.col = col; p.drag = 1.0; p.shape = 0; p.grow = -0.4;
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

/* ---- ambient dust (background, never collides) ---- */
const DUST = [];
for (let i = 0; i < 28; i++) {
  DUST.push({ x: rand(0, VW), y: rand(0, VH), z: rand(0.25, 1),
              vx: rand(-0.09, 0.09), vy: rand(-0.16, -0.03), s: rand(0.6, 2.0), t: rand(0, TAU) });
}
let dustPhase = 0;
function updateDust() {
  // decorative: stepped at 30Hz, which is plenty for drifting motes
  if ((dustPhase ^= 1)) return;
  for (const d of DUST) {
    d.x += d.vx * d.z; d.y += d.vy * d.z; d.t += 0.04 * d.z;
    if (d.y < -8) { d.y = VH + 8; d.x = rand(0, VW); }
    if (d.x < -8) d.x = VW + 8; else if (d.x > VW + 8) d.x = -8;
  }
}

/* ============================================================
   4. LEVEL DATA
   ============================================================
   Everything is data. Adding an entity type means adding a kind
   to ENTITY_KINDS and a draw function — never a new level branch.

   wall    : {x,y,w,h,a?,color?}   solid. A colour repaints the orb on contact.
   ice     : {x,y,w,h,a?}          solid; two solid hits to shatter.
   crystal : {x,y,r,color}         solid; shatters only for its own colour.
   gate    : {x,y,w,h,a?,color}    solid unless the orb already carries its colour.
   bumper  : {x,y,r,power}         radial launcher.
   hazard  : {x,y,w,h,a?,pulse?}   destroys the orb while lit.
   portal  : {x,y,r?,color?}       exit; color null accepts any signature.
   motion  : {type:'osc',dx,dy,period,phase} | {type:'spin',speed}
             may be attached to any entity.

   Design rule used throughout: neutral geometry is for navigating,
   coloured surfaces are for changing state. That keeps every puzzle
   readable — "which colour do I touch last before the exit?"
   ============================================================ */

const LEVELS = [
  {
    /* 1 — teach: launch, wall colour, matching exit. */
    name: 'SPECTRUM',
    tip: 'Near a gold spark: hold, aim where you want to go, release.',
    bg: ['#191c44', '#07091b'], accent: [140, 130, 255],
    start: { x: 110, y: 850 }, color: 'violet',
    portal: { x: 430, y: 230, color: 'cyan' },
    walls: [
      { x: 508, y: 585, w: 20, h: 570, color: 'cyan' },   // unmissable cyan face
      { x: 190, y: 510, w: 350, h: 22 },
    ],
    deadly: [
      { x: 300, y: 715, w: 180, h: 18 },
      { x: 425, y: 400, w: 100, h: 28, spikes: true },
    ],
  },
  {
    /* 2 — teach: not every colour is the right one. */
    name: 'CROSSROADS',
    tip: 'Choose orange. The centre divider makes you commit to a lane.',
    bg: ['#15204a', '#06091c'], accent: [90, 170, 255],
    start: { x: 270, y: 862 }, color: 'violet',
    portal: { x: 270, y: 200, color: 'orange' },
    walls: [
      { x: 92,  y: 700, w: 180, h: 20, a: -35, color: 'magenta' },  // left route
      { x: 448, y: 700, w: 180, h: 20, a: 35, color: 'orange' },    // right route
      { x: 110, y: 470, w: 190, h: 22 },
      { x: 430, y: 470, w: 190, h: 22 },
      { x: 270, y: 620, w: 22, h: 190 },
      { x: 128, y: 292, w: 170, h: 18, a: 20 },           // funnel into the exit
      { x: 412, y: 292, w: 170, h: 18, a: -20 },
      { x: 60,  y: 420, w: 20,  h: 130 },
      { x: 480, y: 420, w: 20,  h: 130 },
    ],
    deadly: [
      { x: 96, y: 386, w: 150, h: 18 },
      { x: 365, y: 590, w: 115, h: 28, spikes: true },
      { x: 260, y: 365, w: 115, h: 18 },
    ],
  },
  {
    /* 3 — teach: ice takes two solid hits. No colour in play. */
    name: 'GLACIER',
    tip: 'Dodge the red bar. Break the ice. Watch the spikes above.',
    bg: ['#102a44', '#050f20'], accent: [70, 190, 255],
    start: { x: 270, y: 806 }, color: 'violet',
    portal: { x: 270, y: 195 },
    walls: [
      { x: 115, y: 520, w: 200, h: 22 },
      { x: 425, y: 520, w: 200, h: 22 },
      { x: 128, y: 700, w: 170, h: 18, a: 22 },           // lips of the pit
      { x: 412, y: 700, w: 170, h: 18, a: -22 },
      { x: 110, y: 330, w: 170, h: 18 },
      { x: 430, y: 330, w: 170, h: 18 },
      { x: 60,  y: 600, w: 20,  h: 120 },
      { x: 480, y: 600, w: 20,  h: 120 },
    ],
    ice: [{ x: 270, y: 520, w: 110, h: 46 }],
    deadly: [
      { x: 270, y: 665, w: 115, h: 18 },
      { x: 170, y: 420, w: 140, h: 28, spikes: true },
      { x: 365, y: 260, w: 130, h: 28, spikes: true },
    ],
  },
  {
    /* 4 — introduce timing: take cyan, then cross the pulsing choke point. */
    name: 'CROSSFIRE',
    tip: 'Take cyan. Wait below the beam, then cross while it is dark.',
    bg: ['#2a1236', '#0a0618'], accent: [230, 100, 180],
    start: { x: 270, y: 862 }, color: 'violet',
    portal: { x: 430, y: 215, color: 'cyan' },
    walls: [
      { x: 100, y: 520, w: 170, h: 22 },
      { x: 440, y: 520, w: 170, h: 22 },
      { x: 508, y: 700, w: 20, h: 280, color: 'cyan' },
      { x: 32,  y: 700, w: 20, h: 280, color: 'magenta' },
      { x: 140, y: 290, w: 160, h: 18 },
      { x: 430, y: 400, w: 140, h: 18, a: -22 },
      { x: 150, y: 830, w: 170, h: 18, a: -18 },
      { x: 390, y: 830, w: 170, h: 18, a: 18 },
    ],
    hazards: [{ x: 270, y: 520, w: 170, h: 14,
      pulse: { period: 4.8, duty: 0.38, phase: 0.1 } }],
    deadly: [
      { x: 330, y: 700, w: 165, h: 18, a: -16 },
      { x: 220, y: 375, w: 130, h: 28, spikes: true },
      { x: 360, y: 285, w: 90, h: 18 },
    ],
    shots: 6,
  },
  {
    /* 5 — teach: a gate only opens for its own colour. */
    name: 'LOCKDOWN',
    tip: 'Cyan opens the first lock. Orange opens the exit.',
    bg: ['#0f2540', '#050e1e'], accent: [60, 210, 255],
    start: { x: 270, y: 864 }, color: 'violet',
    portal: { x: 270, y: 205, color: 'orange' },
    walls: [
      { x: 115, y: 470, w: 200, h: 22 },
      { x: 425, y: 470, w: 200, h: 22 },
      { x: 508, y: 680, w: 20, h: 300, color: 'cyan' },
      { x: 32,  y: 680, w: 20, h: 300, color: 'magenta' },// wrong key
      { x: 160, y: 800, w: 180, h: 18, a: -16 },
      { x: 380, y: 800, w: 180, h: 18, a: 16 },
      { x: 138, y: 310, w: 170, h: 18, a: 22 },
      { x: 402, y: 310, w: 170, h: 18, a: -22 },
      { x: 80,  y: 620, w: 20,  h: 120 },
      { x: 460, y: 620, w: 20,  h: 120 },
      { x: 508, y: 290, w: 20, h: 190, color: 'orange' },
    ],
    gates: [{ x: 270, y: 470, w: 110, h: 22, color: 'cyan' }],
    hazards: [{ x: 108, y: 248, w: 130, h: 14 }],   // punishes drifting left up top
    deadly: [
      { x: 270, y: 670, w: 160, h: 28, spikes: true },
      { x: 360, y: 565, w: 100, h: 18, a: 24 },
      { x: 185, y: 380, w: 100, h: 28, spikes: true },
    ],
    shots: 6,
  },
  {
    /* 6 — combine: the bumper supplies the speed, but it throws you at the
       wrong colour. Touching the right one last is the puzzle. */
    name: 'KINETIC BLOOM',
    tip: 'Which colour do you touch last?',
    bg: ['#1f1748', '#08091f'], accent: [170, 120, 255],
    start: { x: 270, y: 872 }, color: 'violet',
    portal: { x: 128, y: 220, color: 'cyan' },
    walls: [
      { x: 110, y: 470, w: 190, h: 22 },
      { x: 430, y: 470, w: 190, h: 22 },
      { x: 508, y: 360, w: 20, h: 190, color: 'magenta' },  // decoy, where the bumper throws you
      { x: 32,  y: 392, w: 20, h: 150, color: 'cyan' },      // what the exit wants
      { x: 232, y: 300, w: 180, h: 18 },
      { x: 70,  y: 700, w: 20,  h: 170 },
      { x: 470, y: 700, w: 20,  h: 170 },
      { x: 118, y: 874, w: 160, h: 18, a: 16 },
      { x: 422, y: 874, w: 160, h: 18, a: -16 },
      { x: 330, y: 180, w: 150, h: 18 },
    ],
    bumpers: [{ x: 270, y: 640, r: 36, power: 15 }],
    deadly: [
      { x: 155, y: 570, w: 90, h: 28, spikes: true },
      { x: 390, y: 735, w: 95, h: 18, a: -25 },
      { x: 150, y: 370, w: 85, h: 18 },
    ],
    hazards: [
      { x: 336, y: 360, w: 130, h: 14,
        motion: { type: 'osc', dx: 68, dy: 0, period: 7.0, phase: 0 } },
    ],
    shots: 5,
  },
  {
    /* 7 — combine: break through, then route around a live wall to reach
       the colour the exit wants. */
    name: 'FRACTURE',
    tip: 'Break the left passage. Cross right for lime, then time the beam.',
    bg: ['#14294a', '#060d1e'], accent: [90, 200, 235],
    start: { x: 110, y: 862 }, color: 'violet',
    portal: { x: 420, y: 225, color: 'lime' },
    walls: [
      { x: 62.5, y: 560, w: 95, h: 22 },
      { x: 367.5, y: 560, w: 315, h: 22 },
      { x: 508, y: 380, w: 20, h: 260, color: 'lime' },
      { x: 32,  y: 380, w: 20, h: 240, color: 'magenta' },
      { x: 150, y: 200, w: 170, h: 18 },
      { x: 60,  y: 730, w: 20,  h: 160 },
      { x: 400, y: 840, w: 190, h: 18, a: 14 },
      { x: 436, y: 470, w: 120, h: 16, a: -25 },
    ],
    ice: [{ x: 160, y: 560, w: 100, h: 46 }],
    deadly: [
      { x: 148, y: 360, w: 120, h: 18 },
      { x: 200, y: 725, w: 130, h: 28, spikes: true },
      { x: 285, y: 435, w: 130, h: 18, a: -20 },
      { x: 325, y: 240, w: 28, h: 95, spikes: true },
    ],
    hazards: [{ x: 390, y: 302, w: 180, h: 14,
      pulse: { period: 4.2, duty: 0.48, phase: 0.35 } }],
    shots: 7,
  },
  {
    /* 8 — teach: a crystal only yields to its own colour. */
    name: 'PRISM CORE',
    tip: 'Lime shatters the crystal. Keep it to pass the energy filter.',
    bg: ['#241540', '#0a0819'], accent: [190, 120, 255],
    start: { x: 270, y: 868 }, color: 'violet',
    portal: { x: 270, y: 200, color: 'lime' },
    walls: [
      { x: 122.5, y: 500, w: 215, h: 22 },
      { x: 417.5, y: 500, w: 215, h: 22 },
      { x: 508, y: 700, w: 20, h: 260, color: 'lime' },
      { x: 32,  y: 700, w: 20, h: 260, color: 'magenta' },
      { x: 150, y: 810, w: 190, h: 18, a: -18 },
      { x: 390, y: 810, w: 190, h: 18, a: 18 },
      { x: 110, y: 330, w: 170, h: 18 },
      { x: 430, y: 330, w: 170, h: 18 },
      { x: 270, y: 640, w: 22, h: 110 },
    ],
    crystals: [{ x: 270, y: 500, r: 40, color: 'lime' }],
    hazards: [{ x: 262, y: 332, w: 104, h: 24, safe: 'lime' }],  // lime passes
    deadly: [
      { x: 390, y: 665, w: 115, h: 28, spikes: true },
      { x: 140, y: 605, w: 105, h: 18 },
      { x: 310, y: 415, w: 130, h: 28, spikes: true },
      { x: 170, y: 230, w: 28, h: 85, spikes: true },
    ],
    shots: 6,
  },
  {
    /* 9 — order puzzle: the cyan source sits behind the ice, the gate needs cyan. */
    name: 'CASCADE',
    tip: 'Break ice, collect cyan on the left, then cross to the right lock.',
    bg: ['#102542', '#050f1f'], accent: [70, 195, 255],
    start: { x: 110, y: 872 }, color: 'violet',
    portal: { x: 430, y: 220, color: 'cyan' },
    walls: [
      { x: 105, y: 620, w: 180, h: 22 },
      { x: 415, y: 620, w: 220, h: 22 },
      { x: 170, y: 300, w: 310, h: 22 },
      { x: 475, y: 300, w: 100, h: 22 },
      { x: 32,  y: 462, w: 20, h: 290, color: 'cyan' },   // only cyan, mid chamber
      { x: 200, y: 210, w: 200, h: 18 },
      { x: 430, y: 420, w: 140, h: 18, a: -22 },
      { x: 158, y: 782, w: 170, h: 18, a: -16 },
      { x: 480, y: 780, w: 20,  h: 140 },
    ],
    ice: [{ x: 250, y: 620, w: 110, h: 46 }],
    gates: [{ x: 375, y: 300, w: 100, h: 22, color: 'cyan' }],
    bumpers: [{ x: 320, y: 790, r: 32, power: 14 }],
    deadly: [
      { x: 430, y: 494, w: 150, h: 18 },
      { x: 170, y: 705, w: 125, h: 28, spikes: true },
      { x: 175, y: 395, w: 110, h: 18, a: -25 },
      { x: 325, y: 200, w: 28, h: 85, spikes: true },
    ],
    hazards: [{ x: 245, y: 450, w: 100, h: 14,
      pulse: { period: 3.8, duty: 0.48, phase: 0.2 } }],
    shots: 7,
  },
  {
    /* 10 — the finale. The gate wants cyan; the exit wants orange; the only
       orange is on the far side of the gate. That is the whole puzzle. */
    name: 'SINGULARITY',
    tip: 'Cyan, ice, moving beam, lock, then orange. Plan every launch.',
    bg: ['#2b1034', '#090616'], accent: [255, 110, 190],
    start: { x: 100, y: 872 }, color: 'violet',
    portal: { x: 445, y: 205, color: 'orange' },
    walls: [
      { x: 105, y: 640, w: 180, h: 22 },
      { x: 415, y: 640, w: 220, h: 22 },
      { x: 115, y: 330, w: 200, h: 22 },
      { x: 425, y: 330, w: 200, h: 22 },
      { x: 32,  y: 790, w: 20, h: 200, color: 'cyan' },   // key for the gate
      { x: 508, y: 200, w: 20, h: 180, color: 'orange' }, // key for the exit, past it
      { x: 170, y: 215, w: 200, h: 18 },
      { x: 412, y: 292, w: 130, h: 18, a: -20 },
      { x: 214, y: 782, w: 170, h: 18, a: -16 },
    ],
    ice: [{ x: 250, y: 640, w: 110, h: 46 }],
    gates: [{ x: 270, y: 330, w: 110, h: 22, color: 'cyan' }],
    bumpers: [{ x: 300, y: 784, r: 34, power: 14.5 }],
    deadly: [
      { x: 150, y: 715, w: 135, h: 28, spikes: true },
      { x: 365, y: 590, w: 135, h: 18 },
      { x: 145, y: 475, w: 28, h: 135, spikes: true },
      { x: 365, y: 385, w: 110, h: 28, spikes: true },
      { x: 350, y: 190, w: 28, h: 90, spikes: true },
    ],
    hazards: [
      { x: 396, y: 500, w: 130, h: 14,
        motion: { type: 'osc', dx: 62, dy: 0, period: 5.2, phase: 0.2 } },
      { x: 270, y: 410, w: 170, h: 14,
        pulse: { period: 3.6, duty: 0.52, phase: 0.15 } },
    ],
    shots: 6,
  },
];

const BORDER = [
  { x: 270, y: 80,  w: 580, h: 26 },
  { x: 270, y: 954, w: 580, h: 26 },
  { x: 2,   y: 517, w: 26,  h: 920 },
  { x: 538, y: 517, w: 26,  h: 920 },
];

// Bash is a short, target-assisted redirect, not a free mid-air grab.
const BASH = { target: null, angle: -Math.PI / 2, held: 0, radius: 105,
  speed: 18, holdLimit: 2, projectiles: [], emitters: [] };
const BASH_LANES = [
  [810, 605, 345], [820, 560, 380], [780, 610, 410, 245],
  [780, 620, 450, 245], [850, 720, 540, 400, 235],
  [800, 560, 410, 245], [820, 640, 490, 285],
  [860, 750, 565, 410, 245], [860, 700, 550, 365, 240],
  [880, 710, 570, 450, 260],
];
function resetBash(src) {
  BASH.target = null; BASH.held = 0; BASH.projectiles.length = 0;
  const index = Math.max(0, LEVELS.indexOf(src));
  BASH.emitters = BASH_LANES[index].map((y, i) => ({
    x: i % 2 ? 66 : 474, y, vx: i % 2 ? 2.6 : -2.6,
    wait: i * .35, period: 2.4,
  }));
}
function bashTarget() {
  let best = null, distance = BASH.radius;
  for (const p of BASH.projectiles) {
    if (p.cooldown > 0 || p.life <= 0) continue;
    const d = Math.hypot(p.x - orb.x, p.y - orb.y);
    if (d < distance) { best = p; distance = d; }
  }
  return best;
}
function updateBashProjectiles() {
  for (const e of BASH.emitters) {
    e.wait -= STEP;
    if (e.wait <= 0) {
      e.wait += e.period;
      if (BASH.projectiles.length < 28) BASH.projectiles.push({
        x: e.x, y: e.y, vx: e.vx, vy: 0, r: 8, life: 7,
        cooldown: 0, reflected: false, color: null,
      });
    }
  }
  for (const p of BASH.projectiles) {
    p.life -= STEP; p.cooldown = Math.max(0, p.cooldown - STEP);
    const steps = Math.ceil(Math.hypot(p.vx, p.vy) / 5);
    for (let i = 0; i < steps && p.life > 0; i++) {
      p.x += p.vx / steps; p.y += p.vy / steps;
      if (p.x < FIELD.x0 || p.x > FIELD.x1 || p.y < FIELD.y0 || p.y > FIELD.y1) { p.life = 0; break; }
      for (const e of world.solids) {
        if (e.dead || isPassable(e, p.color)) continue;
        const hit = e.spikes ? touchesSpikes(p, e) : e.round ? overlapsRound(p.x, p.y, p.r, e) : overlapsBox(p.x, p.y, p.r, e);
        if (!hit) continue;
        if (p.reflected && (e.kind === 'ice' || (e.kind === 'crystal' && e.color === p.color))) {
          e.dead = true; world.dirty = true;
          FX.shock(e.x, e.y, 8, 65, .4, energy(p.color).rgb, 3);
          Sfx.iceBreak();
        }
        p.life = 0; break;
      }
    }
  }
  let n = 0;
  for (const p of BASH.projectiles) if (p.life > 0) BASH.projectiles[n++] = p;
  BASH.projectiles.length = n;
  compactWorld();
}
function releaseBash() {
  const p = BASH.target;
  if (!p || G.phase !== 'play' || !orb.alive) { cancelAim(); return; }
  const dx = Math.cos(BASH.angle), dy = Math.sin(BASH.angle);
  orb.vx = dx * BASH.speed; orb.vy = dy * BASH.speed;
  orb.dash = MOVE.dashTime;
  PS.facing = BASH.angle;
  Vis.onLaunch(BASH.angle, 0.8);
  p.vx = -dx * BASH.speed; p.vy = -dy * BASH.speed;
  p.reflected = true; p.color = orb.color; p.cooldown = .3; p.life = 4;
  FX.shock(orb.x, orb.y, 12, 80, .35, [255, 214, 112], 3);
  cam.shake = Math.max(cam.shake, 3);
  Sfx.launch(.8);
  cancelAim();
}
function drawBash(c) {
  const target = BASH.target || (G.phase === 'play' && orb.alive ? bashTarget() : null);
  c.save();
  for (const e of BASH.emitters) {
    c.strokeStyle = '#bd954c'; c.lineWidth = 2;
    c.beginPath(); c.arc(e.x, e.y, 10, 0, TAU); c.stroke();
  }
  for (const p of BASH.projectiles) {
    c.strokeStyle = p.reflected ? '#2ee6ff' : '#ffd670'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(p.x - p.vx * 3, p.y - p.vy * 3); c.lineTo(p.x, p.y); c.stroke();
    c.fillStyle = p.reflected ? '#dcfcff' : '#fff3bd';
    c.beginPath(); c.arc(p.x, p.y, p.r, 0, TAU); c.fill();
    if (p === target) {
      c.lineWidth = 2; c.beginPath(); c.arc(p.x, p.y, 20, 0, TAU); c.stroke();
      c.setLineDash([3, 5]); c.beginPath(); c.moveTo(orb.x, orb.y); c.lineTo(p.x, p.y); c.stroke(); c.setLineDash([]);
    }
  }
  if (BASH.target) {
    c.translate(orb.x, orb.y); c.rotate(BASH.angle);
    c.strokeStyle = '#fff3bd'; c.lineWidth = 4;
    c.beginPath(); c.moveTo(22, 0); c.lineTo(90, 0); c.lineTo(73, -12); c.moveTo(90, 0); c.lineTo(73, 12); c.stroke();
    c.strokeStyle = '#2ee6ff'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(-24, 0); c.lineTo(-60, 0); c.lineTo(-50, -8); c.moveTo(-60, 0); c.lineTo(-50, 8); c.stroke();
    c.rotate(-BASH.angle);
    c.strokeStyle = '#ffd670'; c.lineWidth = 3;
    c.beginPath(); c.arc(0, 0, 29, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - BASH.held / BASH.holdLimit)); c.stroke();
  } else if (target) {
    c.fillStyle = '#fff3bd'; c.font = 'bold 13px sans-serif'; c.textAlign = 'center';
    c.fillText('HOLD · AIM · RELEASE', orb.x, orb.y - 36);
  }
  c.restore();
}

/* ============================================================
   5. WORLD BUILDING
   ============================================================ */

const world = {
  solids: [],    // every collidable rect: walls, ice, crystals, closed gates
  statics: [],   // bakeable subset (plain neutral walls only)
  paints: [],    // coloured walls — drawn live so their glow can breathe
  movers: [],    // entities with motion
  bumpers: [],
  ice: [],
  crystals: [],
  hazards: [],
  livewalls: [],
  voids: [],
  gates: [],
  portal: null,
  dirty: false,
  bg: ['#191c44', '#07091b'],
  accent: [140, 130, 255],
};

/* One table describes how each entity kind is built and stored. Adding a new
   type (boost pad, teleport pair, slow field, door…) means one entry here plus
   a draw function — the level data and the collision loop need no changes. */
const ENTITY_KINDS = {
  wall:    { list: 'solids', init: (e) => { e.solid = true; } },
  ice:     { list: 'solids', also: 'ice',      init: (e) => { e.solid = true; e.hp = 2; e.crack = 0; e.shake = 0; } },
  crystal: { list: 'solids', also: 'crystals', init: (e) => { e.solid = true; e.round = true; e.reject = 0; e.pulse = 0; } },
  gate:    { list: 'solids', also: 'gates',    init: (e) => { e.solid = true; e.reject = 0; e.flash = 0; } },
  bumper:  { list: 'bumpers', init: (e) => { e.hit = 0; } },
  hazard:  { list: 'hazards', init: (e) => { e.k = 1; } },
  // dangerous energy wall: solid, never repaints, always fatal
  livewall:{ list: 'solids', also: 'livewalls', init: (e) => { e.solid = true; e.deadly = true; } },
  // void: not solid at all, simply somewhere the orb must not end up
  gap:     { list: 'voids', init: (e) => {} },
  portal:  { list: null, init: (e) => { e.open = 0; e.reject = 0; } },
  // room to grow: boost pads, slow fields, teleport pairs, doors and switches
  // all fit this shape — a list to live in, an init, and a draw function.
};

function prepEntity(e, kind) {
  e.kind = kind;
  e.a = (e.a || 0) * DEG;
  e.bx = e.x; e.by = e.y; e.ba = e.a;
  e.px = e.x; e.py = e.y;
  e.vx = 0; e.vy = 0; e.av = 0;
  e.dead = false;
  e.seed = Math.random() * 100;
  e.gfx = {};                 // per-entity gradient cache (built on first draw)
  // collision constants, resolved once at load: orientation and the radius of
  // the bounding circle used for the broad-phase reject
  e.ca = Math.cos(e.a); e.sa = Math.sin(e.a);
  e.br = e.w !== undefined ? Math.hypot(e.w, e.h) / 2 : (e.r || 0);
  if (e.spikes) {
    const horizontal = e.w >= e.h;
    const length = Math.max(e.w, e.h), depth = Math.min(e.w, e.h);
    const teeth = Math.max(2, Math.round(length / 22)), pitch = length / teeth;
    e.outline = [];
    const point = (x, y) => e.outline.push(horizontal ? { x, y } : { x: y, y: x });
    point(-length / 2, -depth / 6);
    for (let i = 0; i < teeth; i++) {
      point(-length / 2 + (i + .5) * pitch, -depth / 2);
      point(-length / 2 + (i + 1) * pitch, -depth / 6);
    }
    point(length / 2, depth / 6);
    for (let i = teeth - 1; i >= 0; i--) {
      point(-length / 2 + (i + .5) * pitch, depth / 2);
      point(-length / 2 + i * pitch, depth / 6);
    }
  }
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
  // only plain, still, uncoloured walls can be baked into the background
  else if (kind === 'wall' && !e.color) world.statics.push(e);
  else if (kind === 'wall') world.paints.push(e);
  return e;
}

function buildWorld(src) {
  resetBash(src);
  const L = clone(src);
  world.solids.length = 0; world.statics.length = 0; world.paints.length = 0;
  world.movers.length = 0; world.bumpers.length = 0; world.ice.length = 0;
  world.crystals.length = 0; world.hazards.length = 0; world.gates.length = 0;
  world.livewalls.length = 0; world.voids.length = 0;
  world.bg = L.bg; world.accent = L.accent;

  for (const w of (L.walls || []).concat(clone(BORDER))) addEntity(w, 'wall');
  for (const i of (L.ice || [])) addEntity(i, 'ice');
  for (const c of (L.crystals || [])) addEntity(c, 'crystal');
  for (const g of (L.gates || [])) addEntity(g, 'gate');
  for (const b of (L.bumpers || [])) addEntity(b, 'bumper');
  for (const h of (L.hazards || [])) addEntity(h, 'hazard');
  for (const d of (L.deadly || [])) addEntity(d, 'livewall');
  for (const v of (L.voids || [])) addEntity(v, 'gap');

  world.portal = prepEntity(Object.assign({ r: 34, color: null }, L.portal), 'portal');
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

function hazardLevel(h, t) {
  if (!h.pulse) return 1;
  const p = h.pulse;
  const u = ((t / p.period) + (p.phase || 0)) % 1;
  const duty = p.duty || 0.42;
  if (u > duty) {
    // charging: last 22% of the off window telegraphs the strike
    const rem = (1 - u) / (1 - duty);
    return rem < 0.22 ? (0.22 - rem) / 0.22 * 0.34 : 0;
  }
  const ramp = 0.1;
  if (u < duty * ramp) return 0.34 + (u / (duty * ramp)) * 0.66;
  if (u > duty * (1 - ramp)) return 1 - ((u - duty * (1 - ramp)) / (duty * ramp)) * 0.7;
  return 1;
}

/* ============================================================
   6. PHYSICS & COLLISION
   ============================================================ */

function circleVsBox(px, py, r, e) {
  const dx = px - e.x, dy = py - e.y;
  // broad phase: one squared-distance test against the box's bounding circle
  // rejects every wall the orb is nowhere near, before any trig runs
  const reach = e.br + r;
  if (dx * dx + dy * dy > reach * reach) return null;
  // orientation is cached at load (and refreshed only for entities that spin)
  const ca = e.ca, sa = -e.sa;
  const lx = dx * ca - dy * sa;
  const ly = dx * sa + dy * ca;
  const hw = e.w / 2, hh = e.h / 2;
  const qx = clamp(lx, -hw, hw), qy = clamp(ly, -hh, hh);
  let ddx = lx - qx, ddy = ly - qy;
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
  return { nx: nx * cb - ny * sb, ny: nx * sb + ny * cb, pen };
}

function overlapsRound(px, py, r, e) {
  const dx = px - e.x, dy = py - e.y, rr = r + e.r;
  return dx * dx + dy * dy <= rr * rr;
}

function overlapsBox(px, py, r, e) {
  return circleVsBox(px, py, r, e) !== null;
}

// Test the visible serrated outline, including the tooth tips and valleys.
function touchesSpikes(s, e) {
  const dx = s.x - e.x, dy = s.y - e.y;
  if (dx * dx + dy * dy > (e.br + s.r) ** 2) return false;
  const x = dx * e.ca + dy * e.sa, y = -dx * e.sa + dy * e.ca;
  let inside = false;
  const pts = e.outline;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j], b = pts[i], vx = b.x - a.x, vy = b.y - a.y;
    const t = clamp(((x - a.x) * vx + (y - a.y) * vy) / (vx * vx + vy * vy), 0, 1);
    if ((x - a.x - t * vx) ** 2 + (y - a.y - t * vy) ** 2 <= s.r * s.r) return true;
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const RES = { impact: 0, wall: false, bumper: null, nx: 0, ny: 0, hx: 0, hy: 0 };

/* Contacts made during one step, so every entity that was actually touched can
   react (repaint, crack, shatter, reject) instead of only the hardest one.
   Fixed-size and reused — no allocation in the physics loop. */
const HITS = {
  n: 0,
  e: new Array(8),
  imp: new Float64Array(8),
  x: new Float64Array(8),
  y: new Float64Array(8),
  add(e, imp, x, y) {
    for (let i = 0; i < this.n; i++) {
      if (this.e[i] === e) {                 // keep the hardest contact per entity
        if (imp > this.imp[i]) { this.imp[i] = imp; this.x[i] = x; this.y[i] = y; }
        return;
      }
    }
    if (this.n >= 8) return;
    const i = this.n++;
    this.e[i] = e; this.imp[i] = imp; this.x[i] = x; this.y[i] = y;
  },
};

/* A gate is open only to its own signature; everything else it stops.
   `pass` is the generic form, used by any future one-way / keyed geometry. */
function isPassable(e, color) {
  if (e.dead) return true;
  if (e.kind === 'gate') return e.color === color;
  if (e.pass !== undefined) return e.pass === color;
  return false;
}

/* --- contact accumulator -------------------------------------------------
   Every surface touched during one substep lands here. Position is corrected
   the moment a contact is found, so the body is never left overlapping, but
   the *velocity* response is deferred and applied once, against the combined
   normal of everything that was actually being driven into.

   That single change is what makes corners behave. Resolving each wall in turn
   reflected the body twice in the same instant — the second reflection undid
   the first, so the outgoing angle depended on the order of the solids list
   and a one-pixel difference in approach could send the character anywhere. A
   corner now produces one reflection off the corner, which is both stable and
   predictable, and a wedge produces a slide rather than a vibration. */
const CT = {
  n: 0,                       // contacts recorded (capped at the array size)
  closing: 0,                 // how many were being driven into
  nx: 0, ny: 0, wsum: 0,      // penetration-weighted combined normal
  ovx: 0, ovy: 0,             // weighted surface velocity of those contacts
  cnx: new Float64Array(6), cny: new Float64Array(6),
  cvx: new Float64Array(6), cvy: new Float64Array(6),
  reset() {
    this.n = 0; this.closing = 0;
    this.nx = 0; this.ny = 0; this.wsum = 0;
    this.ovx = 0; this.ovy = 0;
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

/* Impacts below the stick threshold do not rebound at all: a body settling
   against a floor stops dead instead of chattering. Above it, restitution
   climbs with the impact so a real slam still rings off the wall. */
function restitutionFor(speed) {
  if (speed < MOVE.bounceStick) return 0;
  const k = clamp((speed - MOVE.bounceStick) / (MOVE.bounceRamp - MOVE.bounceStick), 0, 1);
  return lerp(MOVE.bounceMin, MOVE.bounceMax, k);
}

/* The surface velocity of a contact point, including any spin. */
const SV = { x: 0, y: 0 };
function surfaceVel(e, px, py) {
  SV.x = e.vx || 0; SV.y = e.vy || 0;
  if (e.av) { SV.x += -e.av * (py - e.y); SV.y += e.av * (px - e.x); }
  return SV;
}

function collectBox(s, e, record) {
  const hit = circleVsBox(s.x, s.y, s.r, e);
  if (!hit) return;
  s.x += hit.nx * (hit.pen + MOVE.slop);
  s.y += hit.ny * (hit.pen + MOVE.slop);
  const sv = surfaceVel(e, s.x, s.y);
  const vn = (s.vx - sv.x) * hit.nx + (s.vy - sv.y) * hit.ny;
  CT.add(hit.nx, hit.ny, hit.pen, sv.x, sv.y, vn < 0);
  if (vn >= 0) return;                       // resting or already separating
  const hx = s.x - hit.nx * s.r, hy = s.y - hit.ny * s.r;
  if (-vn > RES.impact) {
    RES.impact = -vn; RES.nx = hit.nx; RES.ny = hit.ny;
    RES.hx = hx; RES.hy = hy;
  }
  RES.wall = true;
  if (record) HITS.add(e, -vn, hx, hy);
}

/* A round solid (crystal): same response as a wall, circle maths.
   Box entities carry w/h, round ones carry r — the solids loop dispatches on
   `e.round` so both can share one list. */
function collectRound(s, e, record) {
  const dx = s.x - e.x, dy = s.y - e.y;
  const rr = s.r + e.r;
  const d2 = dx * dx + dy * dy;
  if (d2 > rr * rr) return;
  const d = Math.sqrt(d2) || 0.0001;
  const nx = dx / d, ny = dy / d;
  const pen = rr - d;
  s.x = e.x + nx * (rr + MOVE.slop); s.y = e.y + ny * (rr + MOVE.slop);
  const sv = surfaceVel(e, s.x, s.y);
  const vn = (s.vx - sv.x) * nx + (s.vy - sv.y) * ny;
  CT.add(nx, ny, pen, sv.x, sv.y, vn < 0);
  if (vn >= 0) return;
  const hx = e.x + nx * e.r, hy = e.y + ny * e.r;
  if (-vn > RES.impact) {
    RES.impact = -vn; RES.nx = nx; RES.ny = ny; RES.hx = hx; RES.hy = hy;
  }
  RES.wall = true;
  if (record) HITS.add(e, -vn, hx, hy);
}

/* One velocity response for the whole substep. */
function resolveContactVel(s) {
  if (CT.closing && CT.wsum > 0) {
    const len = Math.hypot(CT.nx, CT.ny);
    // A near-zero combined normal means the contacts oppose each other: the
    // body is wedged. There is no sensible direction to rebound in, so it is
    // left to the slide pass below, which simply removes the trapped motion.
    if (len > CT.wsum * 0.2) {
      const nx = CT.nx / len, ny = CT.ny / len;
      const ovx = CT.ovx / CT.wsum, ovy = CT.ovy / CT.wsum;
      const rvx = s.vx - ovx, rvy = s.vy - ovy;
      const vn = rvx * nx + rvy * ny;
      if (vn < 0) {
        const rest = restitutionFor(-vn);
        const nvx = nx * vn, nvy = ny * vn;
        s.vx = (rvx - nvx) * MOVE.slide - nvx * rest + ovx;
        s.vy = (rvy - nvy) * MOVE.slide - nvy * rest + ovy;
      }
    }
  }
  // Never end a substep still travelling into a surface that is being touched.
  // For a single contact the rebound above has already handled it, so this is
  // a no-op; for a corner or a wedge it is what stops the body burrowing into
  // one wall because the other one pushed it there.
  for (let i = 0; i < CT.n; i++) {
    const nx = CT.cnx[i], ny = CT.cny[i];
    const vn = (s.vx - CT.cvx[i]) * nx + (s.vy - CT.cvy[i]) * ny;
    if (vn < 0) { s.vx -= nx * vn; s.vy -= ny * vn; }
  }
}

function resolveBumper(s, b) {
  const dx = s.x - b.x, dy = s.y - b.y;
  const rr = s.r + b.r;
  const d2 = dx * dx + dy * dy;
  if (d2 > rr * rr) return;
  const d = Math.sqrt(d2) || 0.0001;
  const nx = dx / d, ny = dy / d;
  s.x = b.x + nx * (rr + MOVE.slop); s.y = b.y + ny * (rr + MOVE.slop);
  const vn = s.vx * nx + s.vy * ny;
  const out = Math.min(MOVE.bumperMax, b.power + Math.max(0, -vn) * 0.45);
  const tvx = s.vx - nx * vn, tvy = s.vy - ny * vn;
  s.vx = tvx * 0.5 + nx * out;
  s.vy = tvy * 0.5 + ny * out;
  RES.bumper = b; RES.impact = Math.max(RES.impact, out);
  RES.hx = b.x + nx * b.r; RES.hy = b.y + ny * b.r;
  RES.nx = nx; RES.ny = ny;
}

/* Substep length is bounded by a fraction of the body radius, so a fast pass
   can never skip past thin geometry, and the substep count is capped so a
   pathological velocity cannot turn one frame into an unbounded loop. */
const SUBSTEP_MAX = 10;

function stepBody(s, useBumpers, record) {
  RES.impact = 0; RES.wall = false; RES.bumper = null;
  RES.deadly = false;
  if (record) HITS.n = 0;
  const sp = Math.hypot(s.vx, s.vy);
  const n = Math.min(SUBSTEP_MAX, Math.max(1, Math.ceil(sp / (s.r * 0.42))));
  const solids = world.solids;
  for (let i = 0; i < n; i++) {
    // velocity is re-read every substep: after a bounce the remainder of the
    // step continues along the new direction instead of ploughing on
    s.x += s.vx / n; s.y += s.vy / n;
    CT.reset();
    for (let k = 0; k < solids.length; k++) {
      const e = solids[k];
      if (e.dead || isPassable(e, orb.color)) continue;
      if (e.deadly) {
        const touched = e.spikes ? touchesSpikes(s, e) : overlapsBox(s.x, s.y, s.r, e);
        if (touched) {
          RES.deadly = true;
          if (record) HITS.add(e, 1, s.x, s.y);
          return RES;
        }
        continue;
      }
      if (e.round) collectRound(s, e, record); else collectBox(s, e, record);
    }
    if (CT.n) resolveContactVel(s);
    if (useBumpers) {
      for (let k = 0; k < world.bumpers.length; k++) resolveBumper(s, world.bumpers[k]);
      if (RES.bumper) break;
    }
  }
  return RES;
}

/* Drag by band. Almost nothing is taken off a body that is genuinely moving —
   that is what lets a leap carry and rebounds chain — and then it rises
   steeply through the settle band so the character parks with intent instead
   of drifting for another second and a half. */
function dragAt(sp) {
  if (sp >= MOVE.speedFlow) return MOVE.dragFlow;
  if (sp >= MOVE.speedSettle) {
    return lerp(MOVE.dragSettle, MOVE.dragFlow,
                (sp - MOVE.speedSettle) / (MOVE.speedFlow - MOVE.speedSettle));
  }
  return lerp(MOVE.dragRest, MOVE.dragSettle,
              clamp((sp - MOVE.speedStop) / (MOVE.speedSettle - MOVE.speedStop), 0, 1));
}

function applyDamping(s) {
  let sp = Math.hypot(s.vx, s.vy);
  if (sp === 0) return;
  if (sp > MOVE.speedMax) { const f = MOVE.speedMax / sp; s.vx *= f; s.vy *= f; sp = MOVE.speedMax; }
  // A launch is a burst of energy, not a push: for a moment after release the
  // character holds its speed outright, which is what makes the dash read as
  // deliberate rather than as something that started decaying immediately.
  if (s.dash > 0) { s.dash -= STEP; return; }
  const d = dragAt(sp);
  s.vx *= d; s.vy *= d;
  if (sp * d < MOVE.speedStop) { s.vx = 0; s.vy = 0; }
}

/* --- trajectory prediction (shares the exact same integrator) --- */
const probe = { x: 0, y: 0, vx: 0, vy: 0, r: CFG.orbR, dash: 0 };
const preview = {
  pts: [], n: 0, blocked: false, hazard: false,
  bounce: -1,                    // index of the dot nearest the first rebound
  bx: 0, by: 0, bnx: 0, bny: 0,  // where that rebound happens, and its normal
};

/* The guide is a fixed *length* of path, not a fixed time, and the length is
   set by the caller from the launch power: a gentle nudge is previewed almost
   to its resting point, a committed leap only gets its opening stretch. The
   character's whole route is never drawn — reading the rebound is the skill. */
function predict(x, y, vx, vy, maxBounce, maxDist) {
  probe.x = x; probe.y = y; probe.vx = vx; probe.vy = vy;
  probe.dash = MOVE.dashTime;          // the preview launches the same way a real one does
  preview.n = 0; preview.blocked = false; preview.hazard = false;
  preview.bounce = -1;
  let bounces = 0, travelled = 0, sinceDot = 1e9;
  const steps = 96;
  if (maxDist === undefined) maxDist = 340;
  for (let i = 0; i < steps; i++) {
    const ox = probe.x, oy = probe.y;
    const r = stepBody(probe, true);
    if (r.deadly) {
      const idx = preview.n++;
      if (!preview.pts[idx]) preview.pts[idx] = { x: 0, y: 0 };
      preview.pts[idx].x = probe.x; preview.pts[idx].y = probe.y;
      preview.hazard = true;
      break;
    }
    if (r.wall) {
      if (bounces === 0 && r.impact > MOVE.hitQuiet) {
        // remember the first real rebound so the aim guide can mark it
        preview.bounce = preview.n;
        preview.bx = RES.hx; preview.by = RES.hy;
        preview.bnx = RES.nx; preview.bny = RES.ny;
      }
      bounces++;
    }
    applyDamping(probe);
    const moved = Math.hypot(probe.x - ox, probe.y - oy);
    travelled += moved; sinceDot += moved;
    if (sinceDot >= 19) {                 // evenly spaced dots, whatever the speed
      sinceDot = 0;
      const idx = preview.n++;
      if (!preview.pts[idx]) preview.pts[idx] = { x: 0, y: 0 };
      preview.pts[idx].x = probe.x; preview.pts[idx].y = probe.y;
    }
    for (let k = 0; k < world.hazards.length; k++) {
      const h = world.hazards[k];
      if (h.k > 0.35 && overlapsBox(probe.x, probe.y, probe.r, h)) { preview.hazard = true; i = steps; break; }
    }
    if (r.bumper || bounces > maxBounce) { preview.blocked = true; break; }
    if (travelled > maxDist) break;
    if (probe.vx === 0 && probe.vy === 0) break;
  }
  return preview;
}

/* ============================================================
   7. GAME STATE
   ============================================================ */

const G = {
  phase: 'play',          // play | win | fail | trans | done
  t: 0,                   // world clock (drives motion)
  phaseT: 0,
  levelIndex: 0,
  level: null,
  shots: 0,
  shotLimit: 0,
  totalShots: 0,
  runTime: 0,
  aiming: false,
  anchorX: 0, anchorY: 0,
  power: 0,
  pullX: 0, pullY: 0,
  transDir: 0, transT: 0, transDur: 0.42, transNext: null,
  fadeIn: 0,
  deny: 0,                // "not yet" feedback when grabbing a moving orb
};

/* ---------------------------------------------------------------------------
   THE PLAYER
   ---------------------------------------------------------------------------
   The character is split into four parts that only talk through small, named
   interfaces. Nothing here is clever; the point is simply that the collision
   loop never writes a visual field, and the renderer never writes a physics
   one, so the orb can be swapped for an animated model later without any of
   the movement code being touched.

     orb    — the physics body: position, velocity, radius, energy signature.
              This is what the integrator, the collision loop and the level
              logic operate on, and the only part that decides the outcome of
              a launch.
     PS     — the state machine: which speed band the body is in, whether the
              player may aim, and how long each of those has been true.
     Vis    — everything cosmetic: squash, stretch, flash, trail, scale. The
              gameplay code calls its event methods (onLaunch, onImpact, …)
              and never pokes its fields.
     Player — the seam a future renderer plugs into: `Player.pose` is refreshed
              once a frame with everything a character rig needs, and if
              `Player.rig` is set, the orb drawing is handed over to it.

   Input lives in section 9 and writes only to `G.aiming/power/pull*`, which is
   read here and by the aim guide. --------------------------------------- */

const orb = {
  x: 0, y: 0, vx: 0, vy: 0, r: CFG.orbR,
  dash: 0,                  // seconds of drag-free burst left from a launch
  color: 'violet', prevColor: 'violet', colorMix: 1,
  alive: true, failKind: 'energy',
};

const TRAIL_N = 18;

/* ---- player state machine ------------------------------------------------
   MOVING / AIRBORNE versus STABLE / AIMABLE, expressed as four speed bands so
   the renderer, the audio and the input all read the same answer. `ready` is
   the one the player actually feels: it is what decides whether a touch starts
   an aim, and its rising edge is what the ready pulse and ring respond to. */
const BAND = ['rest', 'settle', 'flow', 'dash'];
const PS = {
  state: 'rest',
  prev: 'rest',
  stateT: 0,
  speed: 0,
  facing: -Math.PI / 2,     // last meaningful direction of travel
  ready: false,             // stable enough to aim right now
  readyT: 0,                // seconds spent ready (drives the idle ring)
  airT: 0,                  // seconds spent unable to aim
  landT: 99,                // seconds since the last real surface contact
};

function speedBand(sp) {
  if (sp >= MOVE.speedDash) return 'dash';
  if (sp >= MOVE.speedSettle) return 'flow';
  if (sp >= MOVE.speedRest) return 'settle';
  return 'rest';
}

/* True when the character is calm enough to be caught and re-aimed in place.
   Deliberately generous: it is the forgiving end of the movement, not a
   loophole — anything above the settle band still needs a Bash target. Read
   straight from the body so input answers the same question the simulation
   does, even when a touch lands between two fixed steps. */
function isStable(sp) {
  if (sp === undefined) sp = Math.hypot(orb.vx, orb.vy);
  return sp < MOVE.speedSettle;
}

function updatePlayerState() {
  const sp = Math.hypot(orb.vx, orb.vy);
  PS.speed = sp;
  if (sp > 0.05) PS.facing = Math.atan2(orb.vy, orb.vx);
  // while aiming the body is frozen, so the band it was in is held rather than
  // collapsing to 'rest' and flickering back on release
  const band = G.aiming ? PS.state : speedBand(sp);
  if (band !== PS.state) { PS.prev = PS.state; PS.state = band; PS.stateT = 0; }
  else PS.stateT += STEP;
  PS.landT += STEP;

  const ready = orb.alive && !G.aiming && isStable(sp) && canGrab();
  if (ready) {
    if (!PS.ready) { PS.readyT = 0; Vis.onReady(); }
    PS.readyT += STEP;
    PS.airT = 0;
  } else {
    PS.airT += STEP;
  }
  PS.ready = ready;
}

/* ---- player visuals ------------------------------------------------------
   Purely cosmetic state, driven by events rather than by polling the physics.
   Everything decays on the fixed step, so the look is frame-rate independent
   and a stalled tab cannot leave the character stretched. */
const Vis = {
  squash: 0, squashAng: 0,     // compression along a contact
  stretch: 0, stretchAng: 0,   // elongation along travel, strongest on a dash
  pulse: 0,                    // free-running clock for idle motion
  flash: 0, pop: 0, scale: 1,
  readyPop: 0,                 // one-shot pulse when aiming becomes possible
  landPop: 0,                  // one-shot pulse on a solid landing
  trail: [], trailN: 0,

  reset(x, y) {
    this.squash = 0; this.stretch = 0; this.flash = 0; this.pop = 0;
    this.scale = 1; this.readyPop = 0; this.landPop = 0;
    for (let i = 0; i < TRAIL_N; i++) { this.trail[i].x = x; this.trail[i].y = y; this.trail[i].v = 0; }
    this.trailN = 0;
  },

  step(sp) {
    this.pulse += STEP;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - STEP * 3.4);
    if (this.pop > 0) this.pop = Math.max(0, this.pop - STEP * 5.5);
    if (this.squash > 0) this.squash = Math.max(0, this.squash - STEP * 3.6);
    if (this.readyPop > 0) this.readyPop = Math.max(0, this.readyPop - STEP * 2.6);
    if (this.landPop > 0) this.landPop = Math.max(0, this.landPop - STEP * 4.2);
    // speed stretch is a follow, not a decay: it tracks the dash band so the
    // character leans into fast travel and relaxes as it settles
    const want = clamp((sp - MOVE.speedFlow) / (MOVE.speedDash - MOVE.speedFlow), 0, 1) * 0.2 +
                 clamp(sp / MOVE.speedFlow, 0, 1) * 0.1;
    this.stretch += (want - this.stretch) * 0.18;
    if (sp > 0.5) this.stretchAng = PS.facing;
  },

  sample(x, y, sp) {
    const tp = this.trail[this.trailN % TRAIL_N];
    tp.x = x; tp.y = y; tp.v = sp;
    this.trailN++;
  },

  onLaunch(ang, power) {
    this.squash = 0.55; this.squashAng = ang;
    this.stretch = 0.16 + power * 0.2; this.stretchAng = ang;
    this.flash = 1;
    this.trailN = 0;
  },

  onImpact(imp, nx, ny) {
    const s = clamp(imp / 14, 0, 1);
    this.squash = Math.max(this.squash, Math.min(0.6, 0.18 + s * 0.5));
    this.squashAng = Math.atan2(ny, nx) + Math.PI / 2;
    this.stretch *= 0.35;
  },

  onBumper(ang) {
    this.squash = 0.7; this.squashAng = ang; this.flash = 0.9;
  },

  onLand() { this.landPop = 1; },
  onReady() { this.readyPop = 1; },
  onShift() { this.flash = 1; this.pop = 1; },
};
for (let i = 0; i < TRAIL_N; i++) Vis.trail.push({ x: 0, y: 0, v: 0 });

/* ---- rig seam ------------------------------------------------------------
   A future character (a Three.js GLTF model on a transparent canvas layered
   over this one, most likely) needs no access to the physics: it needs a pose
   and a state name, once a frame. `Player.pose` is that contract. Assigning
   `Player.rig = { sync(pose) {...} }` takes over the character drawing and
   nothing else in the game changes. Keeping the contract this narrow is the
   whole point — the movement code must never learn what is rendering it. */
const Player = {
  body: orb,
  rig: null,
  pose: {
    x: 0, y: 0, vx: 0, vy: 0, speed: 0,
    facing: -Math.PI / 2, state: 'rest', ready: false,
    squash: 0, squashAng: 0, stretch: 0, stretchAng: 0,
    scale: 1, flash: 0, color: 'violet', alive: true,
  },
  syncPose() {
    const p = this.pose;
    p.x = orb.x; p.y = orb.y; p.vx = orb.vx; p.vy = orb.vy;
    p.speed = PS.speed; p.facing = PS.facing;
    p.state = PS.state; p.ready = PS.ready;
    p.squash = Vis.squash; p.squashAng = Vis.squashAng;
    p.stretch = Vis.stretch; p.stretchAng = Vis.stretchAng;
    p.scale = Vis.scale; p.flash = Vis.flash;
    p.color = orb.color; p.alive = orb.alive;
    return p;
  },
};

let lastPaint = -9;          // clock of the last colour transfer
let lastHitSfx = -9;         // clock of the last impact sound (anti machine-gun)

const cam = {
  shake: 0, sx: 0, sy: 0, zoom: 1, zoomT: 1, flash: 0, flashCol: [255, 255, 255],
  kx: 0, ky: 0,              // directional impulse (a launch shoves the view)
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

/* Shot limits exist to make the player plan, so the counter has to read as
   energy remaining rather than a score. Only limited levels show a total. */
function updateShotHud() {
  const lim = G.shotLimit;
  dom.shotCount.textContent = lim ? (lim - G.shots) : G.shots;
  dom.shots.title = lim ? 'Launches remaining' : 'Launches used';
  dom.shots.classList.toggle('limited', !!lim);
  dom.shots.classList.toggle('low', !!lim && lim - G.shots <= 2);
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

function resetOrb() {
  lastPaint = -9;
  lastHitSfx = -9;
  lastPvx = NaN;
  clearBuffer();               // a held touch never survives a respawn
  const s = G.level.start;
  orb.x = s.x; orb.y = s.y; orb.vx = 0; orb.vy = 0;
  orb.dash = 0;
  orb.color = G.level.color || 'violet';
  orb.prevColor = orb.color; orb.colorMix = 1;
  orb.alive = true;
  PS.state = 'rest'; PS.prev = 'rest'; PS.stateT = 0; PS.speed = 0;
  PS.facing = -Math.PI / 2; PS.ready = false; PS.readyT = 0; PS.airT = 0; PS.landT = 99;
  Vis.reset(orb.x, orb.y);
}

function startLevel(i) {
  G.levelIndex = i;
  G.level = buildWorld(LEVELS[i]);
  G.shotLimit = LEVELS[i].shots || 0;
  G.shots = 0;
  G.t = 0;
  G.phase = 'play'; G.phaseT = 0;
  G.aiming = false;
  G.fadeIn = 0.5;
  clearFX();
  resetOrb();
  bakeStatic();
  dom.levelNum.textContent = pad2(i + 1);
  dom.levelName.textContent = LEVELS[i].name;
  dom.progress.style.width = ((i + 1) / LEVELS.length * 100) + '%';
  updateShotHud();
  showBanner(i);
  setHint('');
  setTimeout(() => { if (G.levelIndex === i && G.shots === 0 && G.phase === 'play') setHint(LEVELS[i].tip); }, 1150);
}

function transitionTo(fn) {
  G.phase = 'trans'; G.transDir = 1; G.transT = 0; G.transNext = fn;
  Sfx.sweep();
}

function nextLevel() {
  const n = G.levelIndex + 1;
  if (n >= LEVELS.length) {
    transitionTo(() => finishRun());
  } else {
    transitionTo(() => startLevel(n));
  }
}

function finishRun() {
  G.phase = 'done';
  const secs = Math.round(G.runTime);
  dom.endShots.textContent = G.totalShots;
  dom.endTime.textContent = Math.floor(secs / 60) + ':' + pad2(secs % 60);
  dom.endCard.classList.remove('hidden');
  Sfx.complete();
  // keep a calm field behind the card
  G.level = buildWorld(LEVELS[LEVELS.length - 1]);
  resetOrb();
  bakeStatic();
}

function restartRun() {
  doneFrames = 0;
  dom.endCard.classList.add('hidden');
  G.totalShots = 0; G.runTime = 0;
  startLevel(0);
}

function restartLevel(silent) {
  if (G.phase === 'done' || G.transDir !== 0) return;
  if (!silent) Sfx.ui();
  const i = G.levelIndex;
  G.level = buildWorld(LEVELS[i]);
  G.shotLimit = LEVELS[i].shots || 0;
  G.shots = 0;
  G.phase = 'play'; G.phaseT = 0; G.aiming = false;
  G.fadeIn = 0.35;
  clearFX();
  resetOrb();
  bakeStatic();
  updateShotHud();
  Sfx.tensionStop();
}

function canGrab() {
  if (G.shotLimit && G.shots >= G.shotLimit) return false;
  return G.phase === 'play' && G.transDir === 0 && orb.alive;
}

/* A launch is the character throwing itself, not a cue striking a ball: it
   leaves at a speed set by the power curve, holds that speed for the length of
   the dash window, and only then starts paying drag. */
function launch(ang, power) {
  const sp = launchSpeed(power);
  orb.vx = Math.cos(ang) * sp;
  orb.vy = Math.sin(ang) * sp;
  orb.dash = MOVE.dashTime;
  PS.facing = ang;
  PS.state = speedBand(sp); PS.stateT = 0; PS.ready = false; PS.airT = 0;
  Vis.onLaunch(ang, power);
  G.shots++; G.totalShots++;
  updateShotHud();
  dom.shots.classList.remove('bump'); void dom.shots.offsetWidth; dom.shots.classList.add('bump');
  const c = energy(orb.color);
  FX.spark(orb.x - Math.cos(ang) * 12, orb.y - Math.sin(ang) * 12, ang + Math.PI, 0.5, 4 + power * 4, 8, c.rgb,
           { life: 0.4, size: 2.6, shape: 1, len: 12, drag: 0.9 });
  FX.spark(orb.x, orb.y, ang, 0.9, 2.2, 4, c.hi, { life: 0.28, size: 2 });
  FX.shock(orb.x, orb.y, orb.r, orb.r + 34 + power * 26, 0.34, c.rgb, 3);
  cam.shake = Math.max(cam.shake, 2 + power * 4);
  // a short shove of the view *against* the leap: enough to feel the push,
  // far too small to move the playfield out from under the player's finger
  cam.kx -= Math.cos(ang) * (1.2 + power * 2.2);
  cam.ky -= Math.sin(ang) * (1.2 + power * 2.2);
  cam.flash = Math.max(cam.flash, 0.1 + power * 0.14); cam.flashCol = c.hi;
  Sfx.launch(power);
  setHint('');
}

/* Single place where the orb's energy signature changes, so gates and energy
   nodes feel identical: white core flash, 200ms colour blend (trail and glow
   follow automatically), scale pop, shockwave, a few matching sparks. */
function shiftOrbColor(key, x, y) {
  if (!key || orb.color === key) return false;
  if (G.t - lastPaint < CFG.paintCooldown) return false;   // never re-fire per frame
  lastPaint = G.t;
  orb.prevColor = orb.color;
  orb.color = key;
  orb.colorMix = 0;
  Vis.onShift();
  const c = energy(key);
  FX.spark(x, y, 0, Math.PI, 3.6, 4, c.rgb, { life: 0.4, size: 2.6, drag: 0.92 });
  FX.spark(x, y, 0, Math.PI, 1.8, 2, c.hi, { life: 0.3, size: 2 });
  FX.shock(x, y, 6, 58, 0.38, c.rgb, 3);
  cam.flash = Math.max(cam.flash, 0.16); cam.flashCol = c.hi;
  cam.shake = Math.max(cam.shake, 2.5);
  Sfx.shift();
  return true;
}

/* Everything the orb touched this step gets its reaction here. Keeping it in
   one place is what lets levels be pure data: a new entity kind adds a branch,
   never a special case somewhere in the loop. */
function resolveContacts() {
  for (let i = 0; i < HITS.n; i++) {
    const e = HITS.e[i];
    if (e.dead) continue;
    const imp = HITS.imp[i], hx = HITS.x[i], hy = HITS.y[i];

    if (e.kind === 'livewall') {
      orb.x = hx; orb.y = hy;
      killOrb('energy');
      return;
    } else if (e.kind === 'wall') {
      // colour transfer: only on a real contact with a *different* signature,
      // so resting against a wall cannot re-fire the effect every frame
      if (e.color && e.color !== orb.color && imp > CFG.paintSpeed) {
        shiftOrbColor(e.color, hx, hy);
        e.flash = 1;
      }
    } else if (e.kind === 'ice') {
      if (imp >= CFG.iceSpeed) {
        e.hp--;
        e.shake = 1;
        if (e.hp <= 0) {
          e.dead = true;
          world.dirty = true;
          FX.spark(e.x, e.y, 0, Math.PI, 4.2, 11, ICE_RGB,
                   { life: 0.55, size: 3.2, drag: 0.93, shape: 2 });
          FX.shock(e.x, e.y, 8, 76, 0.45, ICE_HI, 3);
          cam.shake = Math.max(cam.shake, 7);
          cam.flash = Math.max(cam.flash, 0.18); cam.flashCol = ICE_HI;
          Sfx.iceBreak();
        } else {
          e.crack = 1;
          FX.spark(hx, hy, Math.atan2(hy - e.y, hx - e.x), 1.1, 2.6, 5, ICE_HI,
                   { life: 0.4, size: 2.2, drag: 0.92, shape: 2 });
          cam.shake = Math.max(cam.shake, 4);
          Sfx.iceCrack();
        }
      }
    } else if (e.kind === 'crystal') {
      if (e.color === orb.color && imp > 2.4) {
        e.dead = true;
        world.dirty = true;
        const c = energy(e.color);
        FX.spark(e.x, e.y, 0, Math.PI, 4.6, 12, c.rgb,
                 { life: 0.6, size: 3, drag: 0.93, shape: 2 });
        FX.shock(e.x, e.y, 10, 90, 0.5, c.hi, 3);
        cam.shake = Math.max(cam.shake, 8);
        cam.flash = Math.max(cam.flash, 0.22); cam.flashCol = c.hi;
        Sfx.crystal();
      } else if (imp > 1.5 && e.reject <= 0) {
        e.reject = 1;
        Sfx.reject();
        showToast('NEEDS ' + (e.color || '').toUpperCase());
      }
    } else if (e.kind === 'gate') {
      if (imp > 1.5 && e.reject <= 0) {
        e.reject = 1;
        Sfx.reject();
      }
    }
  }
}

/* Drop shattered geometry out of the collision list once per step. */
function compactWorld() {
  if (!world.dirty) return;
  world.dirty = false;
  for (const list of [world.solids, world.ice, world.crystals]) {
    let w = 0;
    for (let i = 0; i < list.length; i++) if (!list[i].dead) list[w++] = list[i];
    list.length = w;
  }
}

/* Every failure names its cause. The player should never wonder what killed
   them, so each kind gets its own burst, its own sound and its own word. */
const FAIL_TEXT = {
  energy: 'ENERGY LOST',
  laser:  'CUT DOWN',
  colour: 'WRONG SIGNATURE',
  void:   'LOST TO THE VOID',
  power:  'OUT OF ENERGY',
};

function killOrb(kind, nx, ny) {
  if (!orb.alive) return;
  kind = kind || 'energy';
  orb.alive = false;
  orb.failKind = kind;
  G.phase = 'fail'; G.phaseT = 0;
  const c = energy(orb.color);

  if (kind === 'void') {
    // no bang: the orb is simply drawn away and fades out
    FX.spark(orb.x, orb.y, 0, Math.PI, 1.6, 6, c.rgb, { life: 0.5, size: 2.2, drag: 0.9 });
    cam.shake = 3;
    Sfx.failVoid();
  } else if (kind === 'laser') {
    // slash along the beam, then breakup
    const a = Math.atan2(ny || 0, nx || 1) + Math.PI / 2;
    FX.spark(orb.x, orb.y, a, 0.18, 9, 6, [255, 240, 245], { life: 0.3, size: 2.6, shape: 1, len: 16 });
    FX.spark(orb.x, orb.y, a + Math.PI, 0.18, 9, 6, [255, 240, 245], { life: 0.3, size: 2.6, shape: 1, len: 16 });
    FX.shock(orb.x, orb.y, 3, 70, 0.34, DANGER, 3);
    cam.shake = 12; cam.flash = 0.42; cam.flashCol = [255, 230, 240];
    Sfx.failLaser();
  } else if (kind === 'colour') {
    FX.shock(orb.x, orb.y, 6, 64, 0.3, c.rgb, 4);
    FX.spark(orb.x, orb.y, 0, Math.PI, 5, 8, c.rgb, { life: 0.4, size: 2.6, drag: 0.93 });
    cam.shake = 10; cam.flash = 0.38; cam.flashCol = c.hi;
    Sfx.fail();
  } else if (kind === 'power') {
    FX.implode(orb.x, orb.y, 46, 8, c.rgb, 0.4);
    cam.shake = 4;
    Sfx.failPower();
  } else {
    FX.spark(orb.x, orb.y, 0, Math.PI, 7, 9, DANGER, { life: 0.45, size: 3, drag: 0.94, shape: 1, len: 9 });
    FX.spark(orb.x, orb.y, 0, Math.PI, 4, 4, c.rgb, { life: 0.4, size: 2.4, drag: 0.93 });
    FX.shock(orb.x, orb.y, 4, 84, 0.42, DANGER, 4);
    cam.shake = 13; cam.flash = 0.46; cam.flashCol = DANGER;
    Sfx.fail();
  }
  showToast(FAIL_TEXT[kind] || FAIL_TEXT.energy, true);
  Sfx.tensionStop();
}

function winLevel() {
  G.phase = 'win'; G.phaseT = 0;
  const p = world.portal;
  const c = energy(p.color || orb.color);
  FX.implode(p.x, p.y, 92, 10, c.hi, 0.5);
  FX.shock(p.x, p.y, p.r, p.r + 120, 0.7, c.rgb, 4);
  cam.zoomT = 1.045; cam.flash = 0.34; cam.flashCol = c.hi;
  orb.vx *= 0.2; orb.vy *= 0.2;
  Sfx.portal();
  Sfx.tensionStop();
  setHint('');
}

/* ---- triggers: swept along the step so nothing is tunnelled ---- */
function checkTriggers(px, py) {
  const p = world.portal;
  const dx = orb.x - px, dy = orb.y - py;
  const dist = Math.hypot(dx, dy);
  const n = Math.max(1, Math.ceil(dist / 7));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const sx = px + dx * t, sy = py + dy * t;

    for (let k = 0; k < world.hazards.length; k++) {
      const h = world.hazards[k];
      if (h.k > 0.35 && overlapsBox(sx, sy, orb.r * 0.8, h)) {
        if (h.safe && h.safe === orb.color) continue;   // tuned to this signature
        orb.x = sx; orb.y = sy;
        killOrb(h.safe ? 'colour' : (h.motion ? 'laser' : 'energy'), h.ca, h.sa);
        return;
      }
    }
    for (let k = 0; k < world.voids.length; k++) {
      const v = world.voids[k];
      // the orb's centre must actually cross the lip: dying just outside a
      // hole you can see is indistinguishable from an invisible wall
      if (overlapsBox(sx, sy, orb.r * 0.15, v)) {
        orb.x = sx; orb.y = sy; killOrb('void'); return;
      }
    }
    const pd = Math.hypot(sx - p.x, sy - p.y);
    if (pd < p.r * 0.66) {
      if (!p.color || p.color === orb.color) { orb.x = sx; orb.y = sy; winLevel(); return; }
      if (p.reject <= 0) {
        p.reject = 1;
        const nx = (sx - p.x) / (pd || 1), ny = (sy - p.y) / (pd || 1);
        orb.x = p.x + nx * p.r * 0.8; orb.y = p.y + ny * p.r * 0.8;
        const sp = Math.max(6, Math.hypot(orb.vx, orb.vy) * 0.7);
        orb.vx = nx * sp; orb.vy = ny * sp;
        FX.shock(p.x, p.y, p.r * 0.6, p.r + 40, 0.4, energy(p.color).rgb, 3);
        FX.spark(sx, sy, Math.atan2(ny, nx), 1.1, 3, 6, energy(p.color).rgb, { life: 0.36, size: 2.2 });
        cam.shake = Math.max(cam.shake, 5);
        Sfx.reject();
        showToast('WRONG SIGNATURE');
        return;
      }
    }
  }
}

/* ---- one fixed simulation step ---- */
function simStep() {
  if (G.aiming && BASH.target) {
    BASH.held += STEP;
    if (BASH.held >= BASH.holdLimit) cancelAim();
    return;
  }
  G.t += STEP;
  if (G.phase !== 'done') G.runTime += STEP;
  G.phaseT += STEP;

  updateMotion(G.t);
  if (G.phase === 'play') updateBashProjectiles();
  for (const h of world.hazards) h.k = hazardLevel(h, G.t);
  for (const b of world.bumpers) if (b.hit > 0) b.hit = Math.max(0, b.hit - STEP * 3.2);
  for (const i of world.ice) if (i.shake > 0) i.shake = Math.max(0, i.shake - STEP * 4);
  for (const cr of world.crystals) { if (cr.reject > 0) cr.reject = Math.max(0, cr.reject - STEP * 1.6); cr.pulse += STEP; }
  for (const w of world.paints) if (w.flash > 0) w.flash = Math.max(0, w.flash - STEP * 2.6);
  for (const g of world.gates) { if (g.flash > 0) g.flash = Math.max(0, g.flash - STEP * 2.4); if (g.reject > 0) g.reject = Math.max(0, g.reject - STEP * 1.8); }
  const p = world.portal;
  if (p.reject > 0) p.reject = Math.max(0, p.reject - STEP * 1.6);

  updateDust();
  updateParticles();

  // camera
  cam.shake *= 0.86;
  if (cam.shake < 0.05) cam.shake = 0;
  cam.sx = rand(-1, 1) * cam.shake;
  cam.sy = rand(-1, 1) * cam.shake;
  cam.zoom += (cam.zoomT - cam.zoom) * 0.09;
  cam.zoomT += (1 - cam.zoomT) * 0.05;
  cam.flash *= 0.8;
  cam.kx *= 0.80; cam.ky *= 0.80;
  if (Math.abs(cam.kx) < 0.02) cam.kx = 0;
  if (Math.abs(cam.ky) < 0.02) cam.ky = 0;
  if (G.fadeIn > 0) G.fadeIn = Math.max(0, G.fadeIn - STEP);

  if (G.deny > 0) G.deny = Math.max(0, G.deny - STEP * 2.4);
  if (orb.colorMix < 1) orb.colorMix = Math.min(1, orb.colorMix + STEP * 5);
  Vis.step(PS.speed);

  if (G.phase === 'play' && orb.alive) {
    const px = orb.x, py = orb.y;
    const wasFast = PS.speed >= MOVE.speedSettle;
    if (!G.aiming) {
      const r = stepBody(orb, true, true);
      applyDamping(orb);
      if (r.bumper) {
        const b = r.bumper; b.hit = 1;
        FX.shock(b.x, b.y, b.r * 0.7, b.r + 70, 0.5, BUMPER_RGB, 4);
        FX.spark(RES.hx, RES.hy, Math.atan2(RES.ny, RES.nx), 1.0, 5, 8, [200, 240, 255],
                 { life: 0.4, size: 2.6, shape: 1, len: 10 });
        Vis.onBumper(Math.atan2(orb.vy, orb.vx));
        PS.landT = 0;
        cam.shake = Math.max(cam.shake, 7);
        cam.flash = Math.max(cam.flash, 0.2);
        cam.flashCol = [200, 240, 255];
        Sfx.bumper();
        if (b.color) shiftOrbColor(b.color, RES.hx, RES.hy);
      } else if (r.wall && r.impact > MOVE.hitQuiet) {
        // Impact feedback scales with the hit and is rate-limited, so grazing a
        // wall stays quiet and a corner cannot fire the same burst three steps
        // running. The character still *always* answers a real contact.
        const s = clamp(r.impact / 14, 0, 1);
        const c = energy(orb.color);
        FX.spark(RES.hx, RES.hy, Math.atan2(RES.ny, RES.nx), 1.0, 1.4 + s * 4, 2 + (s * 2 | 0), c.rgb,
                 { life: 0.3, size: 1.9, shape: 1, len: 7, drag: 0.9 });
        Vis.onImpact(r.impact, RES.nx, RES.ny);
        PS.landT = 0;
        if (s > 0.45) cam.shake = Math.max(cam.shake, s * 5);
        if (G.t - lastHitSfx >= MOVE.hitCool) { lastHitSfx = G.t; Sfx.bounce(r.impact); }
      }
      resolveContacts();
      compactWorld();
      if (orb.alive) checkTriggers(px, py);
    }
    // out of energy — checked only once the final launch has played out, so a
    // last-second win always counts
    if (G.phase === 'play' && orb.alive && !G.aiming && G.shotLimit && G.shots >= G.shotLimit &&
        Math.hypot(orb.vx, orb.vy) < MOVE.speedStop) {
      killOrb('power');
    }

    if (orb.alive) {
      updatePlayerState();
      // the moment travel drops into the controllable band after a real flight
      if (wasFast && PS.speed < MOVE.speedSettle && PS.landT < 0.5) Vis.onLand();
      Vis.sample(orb.x, orb.y, PS.speed);
      updateAimBuffer();
    }
  } else if (G.phase === 'fail') {
    // the void drags the orb away while it fades; other kinds just burst
    if (orb.failKind === 'void') {
      orb.x += orb.vx * 0.35; orb.y += orb.vy * 0.35;
      orb.vx *= 0.94; orb.vy *= 0.94;
      Vis.scale = Math.max(0, Vis.scale - STEP * 2.6);
    } else if (orb.failKind === 'power') {
      Vis.scale = Math.max(0, Vis.scale - STEP * 2.2);
    }
    if (G.phaseT > FAIL_HOLD) {
      // a retry is a clean slate: ice, crystals and launch energy all restored
      G.level = buildWorld(LEVELS[G.levelIndex]);
      G.shots = 0;
      updateShotHud();
      bakeStatic();
      G.phase = 'play'; G.phaseT = 0; G.fadeIn = 0.22;
      resetOrb();
    }
  } else if (G.phase === 'win') {
    const p2 = world.portal;
    p2.open = Math.min(1, p2.open + STEP * 3);
    const k = clamp(G.phaseT / 0.42, 0, 1);
    orb.x = lerp(orb.x, p2.x, 0.22);
    orb.y = lerp(orb.y, p2.y, 0.22);
    Vis.scale = Math.max(0, 1 - easeIn(k));
    orb.vx *= 0.8; orb.vy *= 0.8;
    if (G.phaseT > 0.92) nextLevel();
  }

  // curtain runs on its own clock so it can also reveal the end card
  if (G.transDir !== 0) {
    G.transT += STEP;
    if (G.transT >= G.transDur) {
      if (G.transDir === 1) {
        const fn = G.transNext; G.transNext = null;
        G.transDir = -1; G.transT = 0;
        if (fn) fn();
      } else {
        G.transDir = 0; G.transT = 0;
      }
    }
  }

  if (world.portal.open > 0 && G.phase !== 'win') {
    world.portal.open = Math.max(0, world.portal.open - STEP * 2);
  }
}

/* ============================================================
   8. RENDERING
   ============================================================ */

let RS = 1;                       // render scale (device px per game unit)
const bakeCv = document.createElement('canvas');
const bakeCtx = bakeCv.getContext('2d');

let canvasRect = { left: 0, top: 0, width: VW, height: VH };

function fit() {
  const rect = canvasRect = dom.canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;

  /* Pixel budget, not a DPR multiplier.
     Fill-rate is what kills this game on a phone: every frame writes the
     background plus a stack of additive glows over the whole canvas. A 3x
     device at 412 CSS px wide would mean a 1236x2196 buffer — 2.7M pixels
     touched several times per frame, which is exactly how 60fps becomes 15.
     Budgeting the buffer instead bounds that cost on every device, and at
     ~1.1M pixels a 9:16 phone still renders at ~1.8x: visually sharp. */
  const budget = Q.level < 1 ? PIXEL_BUDGET_LOW : PIXEL_BUDGET;
  const cssPx = rect.width * rect.height;
  const maxScale = Math.sqrt(budget / cssPx);
  // Large desktop windows must also be allowed to render below 1x.
  const dpr = Math.min(window.devicePixelRatio || 1, 2, maxScale);
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (dom.canvas.width !== w || dom.canvas.height !== h) {
    dom.canvas.width = w; dom.canvas.height = h;
    RS = w / VW;
    bakeStatic();
  }
}

function bakeStatic() {
  if (!world.bg) return;
  const w = Math.max(1, Math.round(VW * RS)), h = Math.max(1, Math.round(VH * RS));
  if (bakeCv.width !== w || bakeCv.height !== h) { bakeCv.width = w; bakeCv.height = h; }
  const c = bakeCtx;
  c.setTransform(RS, 0, 0, RS, 0, 0);
  c.clearRect(0, 0, VW, VH);

  // base gradient
  const g = c.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, world.bg[0]);
  g.addColorStop(0.55, world.bg[1]);
  g.addColorStop(1, '#04050e');
  c.fillStyle = g; c.fillRect(0, 0, VW, VH);

  // large soft lights
  const acc = world.accent;
  c.globalCompositeOperation = 'lighter';
  // baked once per level — these carry the ambient depth that used to be
  // redrawn (expensively) every frame
  const lights = [
    [VW * 0.16, VH * 0.20, 340, 0.22],
    [VW * 0.90, VH * 0.56, 320, 0.19],
    [VW * 0.42, VH * 0.95, 380, 0.16],
    [VW * 0.62, VH * 0.34, 280, 0.13],
  ];
  for (const [lx, ly, lr, la] of lights) {
    const rg = c.createRadialGradient(lx, ly, 0, lx, ly, lr);
    rg.addColorStop(0, rgba(acc, la));
    rg.addColorStop(1, rgba(acc, 0));
    c.fillStyle = rg; c.beginPath(); c.arc(lx, ly, lr, 0, TAU); c.fill();
  }
  c.globalCompositeOperation = 'source-over';

  // grid
  c.save();
  c.strokeStyle = rgba(acc, 0.075);
  c.lineWidth = 1;
  c.beginPath();
  for (let x = 30; x < VW; x += 45) { c.moveTo(x, 0); c.lineTo(x, VH); }
  for (let y = 30; y < VH; y += 45) { c.moveTo(0, y); c.lineTo(VW, y); }
  c.stroke();
  // accent cross-hatch near the floor
  c.strokeStyle = rgba(acc, 0.05);
  c.beginPath();
  for (let i = -VH; i < VW; i += 90) { c.moveTo(i, VH); c.lineTo(i + VH, 0); }
  c.stroke();
  c.restore();

  // vignette
  const vg = c.createRadialGradient(VW / 2, VH / 2, VH * 0.28, VW / 2, VH / 2, VH * 0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.5)');
  c.fillStyle = vg; c.fillRect(0, 0, VW, VH);

  for (const w2 of world.statics) drawWall(c, w2, false);
}

function drawWall(c, e, live) {
  const w = e.w, h = e.h;
  c.save();
  c.translate(e.x, e.y); c.rotate(e.a);
  const r = Math.min(9, Math.min(w, h) / 2);

  // Outer glow. shadowBlur is a per-pixel CPU blur, so it is affordable while
  // baking the static layer once but never for a wall that moves every frame —
  // those get a cheap wide translucent stroke instead.
  if (live) {
    c.strokeStyle = 'rgba(120,150,255,0.12)';
    c.lineWidth = 7;
    roundRect(c, -w / 2, -h / 2, w, h, r);
    c.stroke();
  } else {
    c.shadowColor = 'rgba(120,150,255,0.5)';
    c.shadowBlur = 16;
    roundRect(c, -w / 2, -h / 2, w, h, r);
    c.fillStyle = '#0d1230';
    c.fill();
    c.shadowBlur = 0;
  }

  // body (cached only for live walls — a gradient belongs to the context that
  // made it, and the static ones are rasterised into the bake layer anyway)
  const mkBody = () => {
    const g = c.createLinearGradient(0, -h / 2, 0, h / 2);
    g.addColorStop(0, '#222a58');
    g.addColorStop(0.42, '#141a3c');
    g.addColorStop(1, '#0a0e26');
    return g;
  };
  roundRect(c, -w / 2, -h / 2, w, h, r);
  c.fillStyle = live ? grad(e.gfx, 'body', mkBody) : mkBody();
  c.fill();

  c.strokeStyle = 'rgba(140,175,255,0.30)';
  c.lineWidth = 1.3;
  c.stroke();

  // neon top edge + inner detail
  c.globalCompositeOperation = 'lighter';
  const long = w >= h;
  const mkEdge = () => {
    const eg = long
      ? c.createLinearGradient(-w / 2, 0, w / 2, 0)
      : c.createLinearGradient(0, -h / 2, 0, h / 2);
    eg.addColorStop(0, 'rgba(120,160,255,0)');
    eg.addColorStop(0.5, 'rgba(150,190,255,0.55)');
    eg.addColorStop(1, 'rgba(120,160,255,0)');
    return eg;
  };
  c.fillStyle = live ? grad(e.gfx, 'edge', mkEdge) : mkEdge();
  if (long) c.fillRect(-w / 2 + r, -h / 2 + 1.5, w - r * 2, 1.6);
  else c.fillRect(-w / 2 + 1.5, -h / 2 + r, 1.6, h - r * 2);

  // dashes
  c.fillStyle = 'rgba(120,160,255,0.16)';
  if (long && w > 60) {
    for (let x = -w / 2 + 12; x < w / 2 - 10; x += 16) c.fillRect(x, -1, 7, 1.4);
  } else if (!long && h > 60) {
    for (let y = -h / 2 + 12; y < h / 2 - 10; y += 16) c.fillRect(-1, y, 1.4, 7);
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

const BUMPER_RGB = [120, 210, 255];
const ICE_RGB = [130, 226, 255];
const ICE_HI = [224, 250, 255];

/* Bumpers and energy nodes share a body; a node carries an energy colour and
   wears a hexagonal frame so the two read as related but distinct. */
function drawBumper(c, b) {
  const node = !!b.color;   // a coloured bumper reads as an energy node
  const col = node ? energy(b.color).rgb : BUMPER_RGB;
  const hi = node ? energy(b.color).hi : [230, 250, 255];
  const squeeze = 1 - b.hit * 0.16;
  const t = G.t;
  const pu = 0.5 + 0.5 * Math.sin(t * 3 + b.seed);

  c.save();
  c.translate(b.x, b.y);
  c.scale(squeeze, squeeze);

  // halo — cached ramp, brightness comes from globalAlpha
  const HR = b.r * 1.65;
  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = 0.5 + b.hit * 0.5;
  c.fillStyle = grad(b.gfx, 'halo', () => {
    const g = c.createRadialGradient(0, 0, b.r * 0.2, 0, 0, HR);
    g.addColorStop(0, rgba(col, 0.42));
    g.addColorStop(0.45, rgba(col, 0.14));
    g.addColorStop(1, rgba(col, 0));
    return g;
  });
  c.beginPath(); c.arc(0, 0, HR, 0, TAU); c.fill();
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';

  // body
  c.fillStyle = grad(b.gfx, 'body', () => {
    const g = c.createRadialGradient(-b.r * 0.25, -b.r * 0.3, b.r * 0.1, 0, 0, b.r);
    g.addColorStop(0, node ? 'rgba(46,44,96,0.95)' : 'rgba(40,80,140,0.95)');
    g.addColorStop(0.7, 'rgba(14,22,58,0.95)');
    g.addColorStop(1, 'rgba(8,12,38,0.98)');
    return g;
  });
  c.beginPath(); c.arc(0, 0, b.r, 0, TAU); c.fill();

  // inner core
  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = 0.62 + pu * 0.22 + b.hit * 0.16;
  c.fillStyle = grad(b.gfx, 'core', () => {
    const g = c.createRadialGradient(0, 0, 0, 0, 0, b.r * 0.72);
    g.addColorStop(0, rgba(hi, 0.85));
    g.addColorStop(0.5, rgba(col, 0.42));
    g.addColorStop(1, rgba(col, 0));
    return g;
  });
  c.beginPath(); c.arc(0, 0, b.r * 0.72, 0, TAU); c.fill();
  c.globalAlpha = 1;

  if (node) {
    // hexagonal frame + counter-rotating inner triangle
    const rot = t * 0.5 + b.seed;
    c.strokeStyle = rgba(col, 0.9);
    c.lineWidth = 2.4;
    c.beginPath();
    for (let i = 0; i <= 6; i++) {
      const a = rot + i * TAU / 6;
      const x = Math.cos(a) * (b.r - 1.5), y = Math.sin(a) * (b.r - 1.5);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
    c.strokeStyle = rgba(hi, 0.4 + pu * 0.3);
    c.lineWidth = 1.5;
    c.beginPath();
    for (let i = 0; i <= 3; i++) {
      const a = -rot * 1.6 + i * TAU / 3;
      const x = Math.cos(a) * b.r * 0.46, y = Math.sin(a) * b.r * 0.46;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
    // orbiting motes — drawn procedurally so they never touch the particle pool
    c.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const a = t * (0.7 + i * 0.16) + i * TAU / 3 + b.seed;
      const rr = b.r * (0.95 + 0.22 * Math.sin(t * 1.6 + i * 2));
      c.fillStyle = rgba(hi, 0.5 + 0.28 * Math.sin(t * 2.4 + i));
      c.beginPath(); c.arc(Math.cos(a) * rr, Math.sin(a) * rr, 1.6, 0, TAU); c.fill();
    }
  } else {
    c.strokeStyle = rgba(col, 0.85);
    c.lineWidth = 2.4;
    c.beginPath(); c.arc(0, 0, b.r - 1.5, 0, TAU); c.stroke();
    c.strokeStyle = rgba([255, 255, 255], 0.2 + pu * 0.2);
    c.lineWidth = 1;
    c.beginPath(); c.arc(0, 0, b.r * 0.82, 0, TAU); c.stroke();

    const rot = t * 1.1 + b.seed;
    c.strokeStyle = rgba([210, 245, 255], 0.55 + b.hit * 0.4);
    c.lineWidth = 2.2;
    c.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const a = rot + i * TAU / 3;
      c.beginPath(); c.arc(0, 0, b.r * 0.55, a, a + 0.5); c.stroke();
    }
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

/* ---------- void ---------------------------------------------------------
   Somewhere the orb must not end up. Drawn under everything so it reads as a
   hole in the floor of the chamber rather than an object sitting on it. */
/* ---------- void ---------------------------------------------------------
   A hole the orb must not enter. The danger has to be legible against an
   already dark background, so the pit is framed on every side, hatched with
   warning stripes and lit at the lip — a near-black rectangle on a near-black
   chamber floor is an invisible wall, which is exactly what this must not be. */
function drawVoid(c, v) {
  const w = v.w, h = v.h;
  const pu = 0.5 + 0.5 * Math.sin(G.t * 2.4 + v.seed);
  c.save();
  c.translate(v.x, v.y); c.rotate(v.a);

  // the pit itself
  c.fillStyle = grad(v.gfx, 'pit', () => {
    const g = c.createLinearGradient(0, -h / 2, 0, h / 2);
    g.addColorStop(0, 'rgba(22,2,10,0.99)');
    g.addColorStop(0.5, 'rgba(6,0,4,1)');
    g.addColorStop(1, 'rgba(2,0,2,1)');
    return g;
  });
  c.fillRect(-w / 2, -h / 2, w, h);

  // warning hatch, clipped to the pit — reads as 'do not enter' at a glance
  c.save();
  c.beginPath(); c.rect(-w / 2, -h / 2, w, h); c.clip();
  c.strokeStyle = rgba(DANGER, 0.22);
  c.lineWidth = 9;
  c.beginPath();
  for (let i = -h; i < w + h; i += 30) { c.moveTo(-w / 2 + i, -h / 2); c.lineTo(-w / 2 + i - h, h / 2); }
  c.stroke();
  c.restore();

  c.globalCompositeOperation = 'lighter';

  // lip glow along the top edge
  c.globalAlpha = 0.65 + pu * 0.35;
  c.fillStyle = grad(v.gfx, 'rim', () => {
    const g = c.createLinearGradient(0, -h / 2, 0, -h / 2 + 30);
    g.addColorStop(0, rgba(DANGER, 0.95));
    g.addColorStop(1, rgba(DANGER, 0));
    return g;
  });
  c.fillRect(-w / 2, -h / 2, w, 30);
  c.globalAlpha = 1;

  // full frame so every approach angle shows an edge
  c.strokeStyle = rgba(DANGER, 0.9);
  c.lineWidth = 2.4;
  c.strokeRect(-w / 2, -h / 2, w, h);

  // bright lip cap
  c.strokeStyle = rgba([255, 190, 210], 0.85 + pu * 0.15);
  c.lineWidth = 2.6;
  c.beginPath(); c.moveTo(-w / 2, -h / 2); c.lineTo(w / 2, -h / 2); c.stroke();

  // corner ticks
  c.lineWidth = 2.2;
  c.strokeStyle = rgba(DANGER, 0.9);
  const t = 12;
  c.beginPath();
  c.moveTo(-w / 2, -h / 2 + t); c.lineTo(-w / 2, -h / 2); c.lineTo(-w / 2 + t, -h / 2);
  c.moveTo(w / 2 - t, -h / 2); c.lineTo(w / 2, -h / 2); c.lineTo(w / 2, -h / 2 + t);
  c.stroke();

  // sparse falling motes to sell the depth
  for (let i = 0; i < 4; i++) {
    const u = ((G.t * 0.22 + i * 0.25 + v.seed) % 1);
    c.fillStyle = rgba(DANGER, 0.6 * (1 - u));
    c.beginPath();
    c.arc(-w / 2 + ((i * 97 + v.seed * 31) % w), -h / 2 + u * h, 1.8, 0, TAU);
    c.fill();
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

function drawLiveWall(c, e) {
  if (e.spikes) {
    c.save();
    c.translate(e.x, e.y); c.rotate(e.a);
    c.beginPath();
    c.moveTo(e.outline[0].x, e.outline[0].y);
    for (let i = 1; i < e.outline.length; i++) c.lineTo(e.outline[i].x, e.outline[i].y);
    c.closePath();
    c.fillStyle = '#8e163e'; c.fill();
    c.strokeStyle = 'rgba(255,45,110,.22)'; c.lineWidth = 7; c.stroke();
    c.strokeStyle = '#ff719c'; c.lineWidth = 1.6; c.stroke();
    c.restore();
    return;
  }
  const w = e.w, h = e.h;
  const r = Math.min(9, Math.min(w, h) / 2);
  const long = w >= h;
  const pu = 0.5 + 0.5 * Math.sin(G.t * 7 + e.seed);
  c.save();
  c.translate(e.x, e.y); c.rotate(e.a);

  roundRect(c, -w / 2, -h / 2, w, h, r);
  c.fillStyle = grad(e.gfx, 'body', () => {
    const g = long ? c.createLinearGradient(0, -h / 2, 0, h / 2)
                   : c.createLinearGradient(-w / 2, 0, w / 2, 0);
    g.addColorStop(0, 'rgba(96,12,44,0.97)');
    g.addColorStop(0.5, 'rgba(158,20,68,0.97)');
    g.addColorStop(1, 'rgba(96,12,44,0.97)');
    return g;
  });
  c.fill();
  c.strokeStyle = rgba([255, 150, 185], 0.95);
  c.lineWidth = 2.2;
  c.stroke();

  c.globalCompositeOperation = 'lighter';
  // outward glow so it is obvious before you are touching it
  c.globalAlpha = 0.5 + pu * 0.2;
  c.strokeStyle = rgba(DANGER, 0.5);
  c.lineWidth = 9;
  roundRect(c, -w / 2, -h / 2, w, h, r);
  c.stroke();
  // hot core
  c.globalAlpha = 0.75 + pu * 0.25;
  c.fillStyle = grad(e.gfx, 'core', () => {
    const g = long ? c.createLinearGradient(0, -h / 2, 0, h / 2)
                   : c.createLinearGradient(-w / 2, 0, w / 2, 0);
    g.addColorStop(0, rgba(DANGER, 0));
    g.addColorStop(0.5, rgba([255, 175, 205], 0.98));
    g.addColorStop(1, rgba(DANGER, 0));
    return g;
  });
  if (long) c.fillRect(-w / 2 + 2, -h / 2, w - 4, h);
  else c.fillRect(-w / 2, -h / 2 + 2, w, h - 4);

  // arcing edge — six segments of jitter, redrawn each frame but trivial
  c.strokeStyle = rgba([255, 200, 220], 0.5 + pu * 0.35);
  c.lineWidth = 1.1;
  c.beginPath();
  const span = long ? w : h;
  const segs = 6;
  for (let i = 0; i <= segs; i++) {
    const p = -span / 2 + (span / segs) * i;
    const j = Math.sin(G.t * 26 + i * 2.7 + e.seed) * (long ? h : w) * 0.3;
    if (long) { if (i === 0) c.moveTo(p, j); else c.lineTo(p, j); }
    else { if (i === 0) c.moveTo(j, p); else c.lineTo(j, p); }
  }
  c.stroke();
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

function drawHazard(c, h) {
  const k = h.k;
  const w = h.w, ht = h.h;
  const tuned = h.safe ? energy(h.safe) : null;
  const HZ = tuned ? tuned.rgb : DANGER;
  const HZ_HI = tuned ? tuned.hi : [255, 220, 235];
  const live = !tuned || h.safe !== orb.color;   // is it dangerous right now?
  c.save();
  c.translate(h.x, h.y); c.rotate(h.a);
  const long = w >= ht;
  const L = long ? w : ht;

  // emitter caps
  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = 0.6 + k * 0.4;
  c.fillStyle = grad(h.gfx, 'cap', () => {
    const cg = c.createRadialGradient(0, 0, 0, 0, 0, 13);
    cg.addColorStop(0, rgba(HZ_HI, 0.75));
    cg.addColorStop(0.4, rgba(HZ, 0.8));
    cg.addColorStop(1, rgba(HZ, 0));
    return cg;
  });
  for (const s of [-1, 1]) {
    const ex = long ? s * w / 2 : 0;
    const ey = long ? 0 : s * ht / 2;
    c.save();
    c.translate(ex, ey);
    c.beginPath(); c.arc(0, 0, 13, 0, TAU); c.fill();
    c.restore();
  }
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = '#1a0a1e';
  for (const s of [-1, 1]) {
    const ex = long ? s * w / 2 : 0;
    const ey = long ? 0 : s * ht / 2;
    c.beginPath(); c.arc(ex, ey, 6.5, 0, TAU); c.fill();
    c.strokeStyle = rgba(HZ, 0.85); c.lineWidth = 1.6; c.stroke();
  }

  // idle rail — the danger line stays readable even while the beam is down
  c.save();
  c.setLineDash([5, 7]);
  c.lineDashOffset = -G.t * 26;
  c.strokeStyle = rgba(HZ, 0.2 + k * 0.5);
  c.lineWidth = 1.3;
  c.beginPath();
  if (long) { c.moveTo(-w / 2 + 7, 0); c.lineTo(w / 2 - 7, 0); }
  else { c.moveTo(0, -ht / 2 + 7); c.lineTo(0, ht / 2 - 7); }
  c.stroke();
  c.restore();

  if (k <= 0.01) { c.restore(); return; }
  if (!live) c.globalAlpha = 0.35;   // harmless to this signature: stand down

  // A colour-tuned field still has to read as lethal while it is lethal: it
  // wears danger ticks that vanish the moment the orb carries its colour.
  if (tuned && live) {
    c.globalCompositeOperation = 'lighter';
    c.strokeStyle = rgba(DANGER, 0.55 + 0.3 * Math.sin(G.t * 6 + h.seed));
    c.lineWidth = 2;
    c.beginPath();
    const sp = long ? w : ht;
    for (let i = -sp / 2 + 8; i < sp / 2 - 4; i += 16) {
      if (long) { c.moveTo(i, -ht / 2); c.lineTo(i + 6, -ht / 2 - 5); c.moveTo(i, ht / 2); c.lineTo(i + 6, ht / 2 + 5); }
      else { c.moveTo(-w / 2, i); c.lineTo(-w / 2 - 5, i + 6); c.moveTo(w / 2, i); c.lineTo(w / 2 + 5, i + 6); }
    }
    c.stroke();
  }

  c.globalCompositeOperation = 'lighter';
  const th = (long ? ht : w) * (0.35 + k * 0.65);
  const bw = long ? w : th, bh = long ? th : ht;

  // bloom — cached at full width, then squeezed across the beam by transform
  const thMax = (long ? ht : w);
  c.save();
  if (long) c.scale(1, th / thMax); else c.scale(th / thMax, 1);
  c.globalAlpha = k;
  c.fillStyle = grad(h.gfx, 'bloom', () => {
    const bg = long
      ? c.createLinearGradient(0, -thMax * 2.2, 0, thMax * 2.2)
      : c.createLinearGradient(-thMax * 2.2, 0, thMax * 2.2, 0);
    bg.addColorStop(0, rgba(HZ, 0));
    bg.addColorStop(0.5, rgba(HZ, 0.34));
    bg.addColorStop(1, rgba(HZ, 0));
    return bg;
  });
  if (long) c.fillRect(-w / 2, -thMax * 2.2, w, thMax * 4.4);
  else c.fillRect(-thMax * 2.2, -ht / 2, thMax * 4.4, ht);
  c.globalAlpha = 1;
  c.restore();

  // beam body
  c.fillStyle = rgba(HZ, 0.5 * k);
  c.fillRect(-bw / 2, -bh / 2, bw, bh);
  // hot core
  const core = Math.max(1.2, (long ? bh : bw) * 0.32);
  c.fillStyle = rgba(HZ_HI, 0.85 * k);
  if (long) c.fillRect(-w / 2, -core / 2, w, core);
  else c.fillRect(-core / 2, -ht / 2, core, ht);

  // crackle
  if (k > 0.6) {
    c.strokeStyle = rgba(HZ_HI, 0.5);
    c.lineWidth = 1;
    c.beginPath();
    const seg = 7;
    for (let i = 0; i <= seg; i++) {
      const p = -L / 2 + (L / seg) * i;
      const j = (Math.sin(G.t * 40 + i * 2.3 + h.seed) + Math.sin(G.t * 23 + i)) * 1.5;
      if (long) { if (i === 0) c.moveTo(p, j); else c.lineTo(p, j); }
      else { if (i === 0) c.moveTo(j, p); else c.lineTo(j, p); }
    }
    c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

/* ---------- coloured wall ----------------------------------------------
   Reads as the same glass as a neutral wall, but lit from within by its own
   energy so "which colour is this surface" is answerable at a glance. */
function drawPaintWall(c, e) {
  const col = energy(e.color);
  const w = e.w, h = e.h;
  const r = Math.min(9, Math.min(w, h) / 2);
  const long = w >= h;
  c.save();
  c.translate(e.x, e.y); c.rotate(e.a);

  // body
  roundRect(c, -w / 2, -h / 2, w, h, r);
  c.fillStyle = grad(e.gfx, 'body', () => {
    const g = long ? c.createLinearGradient(0, -h / 2, 0, h / 2)
                   : c.createLinearGradient(-w / 2, 0, w / 2, 0);
    g.addColorStop(0, rgba(col.rgb, 0.34));
    g.addColorStop(0.5, rgba(col.rgb, 0.16));
    g.addColorStop(1, rgba(col.rgb, 0.30));
    return g;
  });
  c.fill();
  c.strokeStyle = rgba(col.rgb, 0.85);
  c.lineWidth = 1.6;
  c.stroke();

  // energy core running along the surface
  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = 0.65 + e.flash * 0.35;
  c.fillStyle = grad(e.gfx, 'core', () => {
    const g = long ? c.createLinearGradient(0, -h / 2, 0, h / 2)
                   : c.createLinearGradient(-w / 2, 0, w / 2, 0);
    g.addColorStop(0, rgba(col.rgb, 0));
    g.addColorStop(0.5, rgba(col.hi, 0.75));
    g.addColorStop(1, rgba(col.rgb, 0));
    return g;
  });
  if (long) c.fillRect(-w / 2 + 2, -h / 2, w - 4, h);
  else c.fillRect(-w / 2, -h / 2 + 2, w, h - 4);

  // travelling pulse so the surface feels charged, not painted
  const per = long ? w : h;
  const u = ((G.t * 0.24 + e.seed) % 1) * (per + 60) - 30;
  c.globalAlpha = 0.5;
  c.fillStyle = rgba(col.hi, 0.9);
  if (long) c.fillRect(-w / 2 + u, -h / 2 + 1, 26, 2);
  else c.fillRect(-w / 2 + 1, -h / 2 + u, 2, 26);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

/* ---------- ice ---------------------------------------------------------
   Translucent glass, frosted rim, cracks after the first solid hit. */
function drawIce(c, e) {
  const w = e.w, h = e.h;
  const shake = e.shake > 0 ? e.shake * 2.4 : 0;
  c.save();
  c.translate(e.x + (shake ? rand(-shake, shake) : 0), e.y + (shake ? rand(-shake, shake) : 0));
  c.rotate(e.a);

  roundRect(c, -w / 2, -h / 2, w, h, 6);
  c.fillStyle = grad(e.gfx, 'body', () => {
    const g = c.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
    g.addColorStop(0, 'rgba(150,232,255,0.30)');
    g.addColorStop(0.45, 'rgba(90,190,240,0.16)');
    g.addColorStop(1, 'rgba(180,244,255,0.26)');
    return g;
  });
  c.fill();

  // frosted rim
  c.strokeStyle = 'rgba(200,244,255,0.75)';
  c.lineWidth = 1.6;
  c.stroke();
  c.strokeStyle = 'rgba(120,210,255,0.35)';
  c.lineWidth = 4;
  c.stroke();

  // inner glow + facet highlights
  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = 0.55 + (e.crack ? 0.2 : 0);
  c.fillStyle = grad(e.gfx, 'glow', () => {
    const g = c.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) * 0.6);
    g.addColorStop(0, 'rgba(180,240,255,0.34)');
    g.addColorStop(1, 'rgba(120,210,255,0)');
    return g;
  });
  c.fillRect(-w / 2, -h / 2, w, h);
  c.globalAlpha = 1;

  c.strokeStyle = 'rgba(235,252,255,0.5)';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(-w / 2 + 6, h / 2 - 8); c.lineTo(-w / 2 + w * 0.36, -h / 2 + 5);
  c.moveTo(-w / 2 + w * 0.62, h / 2 - 5); c.lineTo(w / 2 - 6, -h / 2 + 9);
  c.stroke();

  // damage state: a fracture the player can read from across the room
  if (e.hp <= 1) {
    c.strokeStyle = 'rgba(245,253,255,0.9)';
    c.lineWidth = 1.5;
    c.beginPath();
    const hw = w / 2, hh = h / 2;
    c.moveTo(-hw * 0.7, -hh); c.lineTo(-hw * 0.2, -hh * 0.1);
    c.lineTo(-hw * 0.45, hh * 0.35); c.lineTo(-hw * 0.05, hh);
    c.moveTo(-hw * 0.2, -hh * 0.1); c.lineTo(hw * 0.35, -hh * 0.45);
    c.moveTo(-hw * 0.2, -hh * 0.1); c.lineTo(hw * 0.55, hh * 0.2);
    c.lineTo(hw * 0.3, hh);
    c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

/* ---------- colour crystal ---------------------------------------------- */
function drawCrystal(c, e) {
  const col = energy(e.color);
  const pu = 0.5 + 0.5 * Math.sin(e.pulse * 2.4 + e.seed);
  const r = e.r;
  c.save();
  c.translate(e.x, e.y);
  c.rotate(Math.sin(e.pulse * 0.4 + e.seed) * 0.08);

  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = 0.55 + pu * 0.25 + e.reject * 0.3;
  c.fillStyle = grad(e.gfx, 'halo', () => {
    const g = c.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 1.7);
    g.addColorStop(0, rgba(col.rgb, 0.42));
    g.addColorStop(1, rgba(col.rgb, 0));
    return g;
  });
  c.beginPath(); c.arc(0, 0, r * 1.7, 0, TAU); c.fill();
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';

  // faceted body
  const facet = (rr) => {
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + i * TAU / 6;
      const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
  };
  facet(r);
  c.fillStyle = grad(e.gfx, 'body', () => {
    const g = c.createLinearGradient(-r, -r, r, r);
    g.addColorStop(0, rgba(col.rgb, 0.5));
    g.addColorStop(0.5, 'rgba(10,14,34,0.85)');
    g.addColorStop(1, rgba(col.rgb, 0.42));
    return g;
  });
  c.fill();
  c.strokeStyle = rgba(col.rgb, 0.95);
  c.lineWidth = 2.2;
  c.stroke();

  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = 0.6 + pu * 0.4;
  facet(r * 0.52);
  c.fillStyle = rgba(col.hi, 0.5);
  c.fill();
  c.globalAlpha = 1;

  // internal facet lines
  c.strokeStyle = rgba(col.hi, 0.4);
  c.lineWidth = 1;
  c.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + i * TAU / 6;
    c.moveTo(0, 0); c.lineTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9);
  }
  c.stroke();

  if (e.reject > 0) {
    c.strokeStyle = rgba([255, 255, 255], e.reject * 0.8);
    c.lineWidth = 2.5;
    facet(r * (1 + (1 - e.reject) * 0.4));
    c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

/* ---------- colour gate -------------------------------------------------
   Solid bars with an energy membrane between them. It reads as *closed*;
   when the orb already carries its colour the membrane thins and opens. */
function drawGate(c, g) {
  const col = energy(g.color);
  const open = g.color === orb.color;
  const w = g.w, h = g.h;
  const long = w >= h;
  const th = long ? h : w;
  c.save();
  c.translate(g.x, g.y); c.rotate(g.a);

  // anchors
  c.fillStyle = 'rgba(14,18,42,0.95)';
  for (const s of [-1, 1]) {
    const ex = long ? s * w / 2 : 0;
    const ey = long ? 0 : s * h / 2;
    c.save(); c.translate(ex, ey);
    roundRect(c, -7, -th * 0.75, 14, th * 1.5, 4);
    c.fill();
    c.strokeStyle = rgba(col.rgb, 0.9); c.lineWidth = 1.6; c.stroke();
    c.restore();
  }

  c.globalCompositeOperation = 'lighter';
  if (open) {
    // dissolved: two thin rails and a faint shimmer
    c.globalAlpha = 0.5;
    c.fillStyle = rgba(col.hi, 0.6);
    if (long) { c.fillRect(-w / 2, -h / 2, w, 1.6); c.fillRect(-w / 2, h / 2 - 1.6, w, 1.6); }
    else { c.fillRect(-w / 2, -h / 2, 1.6, h); c.fillRect(w / 2 - 1.6, -h / 2, 1.6, h); }
    c.globalAlpha = 1;
  } else {
    c.globalAlpha = Math.min(1, 0.72 + g.reject * 0.28);
    c.fillStyle = grad(g.gfx, 'mem', () => {
      const mg = long ? c.createLinearGradient(0, -h / 2, 0, h / 2)
                      : c.createLinearGradient(-w / 2, 0, w / 2, 0);
      mg.addColorStop(0, rgba(col.rgb, 0.18));
      mg.addColorStop(0.5, rgba(col.rgb, 0.55));
      mg.addColorStop(1, rgba(col.rgb, 0.18));
      return mg;
    });
    c.fillRect(-w / 2, -h / 2, w, h);

    // lattice — the visual cue for "locked"
    c.strokeStyle = rgba(col.hi, 0.55);
    c.lineWidth = 1.4;
    c.beginPath();
    const span = long ? w : h;
    for (let i = -span / 2; i < span / 2; i += 14) {
      if (long) { c.moveTo(i, -h / 2); c.lineTo(i + 9, h / 2); }
      else { c.moveTo(-w / 2, i); c.lineTo(w / 2, i + 9); }
    }
    c.stroke();
    c.globalAlpha = 1;
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

const PORTAL_ANY = { rgb: [120, 200, 255], hi: [232, 249, 255] };

function drawPortal(c, p) {
  const col = p.color ? energy(p.color) : PORTAL_ANY;
  const t = G.t;
  const open = p.open;
  const scale = 1 + open * 0.55 + p.reject * 0.08;
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
  c.save();
  c.translate(p.x, p.y);
  c.scale(scale, scale);

  c.globalCompositeOperation = 'lighter';
  // outer bloom — radius trimmed from 2.6r to 1.95r (44% less blended area)
  // and the ramp is cached; brightness rides on globalAlpha instead
  const BR = p.r * 1.95;
  c.globalAlpha = Math.min(1, 0.78 + pulse * 0.22 + open * 0.8);
  c.fillStyle = grad(p.gfx, 'bloom', () => {
    const g = c.createRadialGradient(0, 0, p.r * 0.3, 0, 0, BR);
    g.addColorStop(0, rgba(col.rgb, 0.42));
    g.addColorStop(0.42, rgba(col.rgb, 0.15));
    g.addColorStop(1, rgba(col.rgb, 0));
    return g;
  });
  c.beginPath(); c.arc(0, 0, BR, 0, TAU); c.fill();
  c.globalAlpha = 1;

  // event horizon — dark well first, so the energy reads on top of it
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = grad(p.gfx, 'eye', () => {
    const g = c.createRadialGradient(0, 0, 0, 0, 0, p.r * 0.82);
    g.addColorStop(0, 'rgba(4,5,18,0.85)');
    g.addColorStop(0.55, 'rgba(5,7,24,0.78)');
    g.addColorStop(1, 'rgba(6,8,26,0)');
    return g;
  });
  c.beginPath(); c.arc(0, 0, p.r * 0.82, 0, TAU); c.fill();
  c.globalCompositeOperation = 'lighter';

  // swirl core
  c.globalAlpha = Math.min(1, 0.84 + pulse * 0.16 + open * 0.16);
  c.fillStyle = grad(p.gfx, 'core', () => {
    const g = c.createRadialGradient(0, 0, 0, 0, 0, p.r * 0.95);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.12, rgba(col.hi, 0.8));
    g.addColorStop(0.3, rgba(col.rgb, 0.34));
    g.addColorStop(0.58, rgba(col.rgb, 0.5));
    g.addColorStop(0.84, rgba(col.rgb, 0.2));
    g.addColorStop(1, rgba(col.rgb, 0));
    return g;
  });
  c.beginPath(); c.arc(0, 0, p.r * 0.95, 0, TAU); c.fill();
  c.globalAlpha = 1;

  // spiral intake
  c.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const a0 = -t * 1.6 + i * TAU / 3;
    c.strokeStyle = rgba(col.hi, 0.3);
    c.lineWidth = 1.6;
    c.beginPath();
    for (let s = 0; s <= 10; s++) {
      const u = s / 10;
      const rr = p.r * (0.2 + u * 0.55);
      const aa = a0 + u * 1.5;
      const x = Math.cos(aa) * rr, y = Math.sin(aa) * rr;
      if (s === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }
  // inner rim
  c.strokeStyle = rgba(col.hi, 0.6 + pulse * 0.2);
  c.lineWidth = 1.4;
  c.beginPath(); c.arc(0, 0, p.r * 0.34, 0, TAU); c.stroke();

  // rotating hexagon frame
  for (let ring = 0; ring < 2; ring++) {
    const rr = p.r * (ring ? 0.78 : 1.06);
    const rot = t * (ring ? -0.5 : 0.34) + ring;
    c.strokeStyle = rgba(ring ? col.hi : col.rgb, ring ? 0.35 : 0.8);
    c.lineWidth = ring ? 1.2 : 2;
    c.beginPath();
    for (let i = 0; i <= 6; i++) {
      const a = rot + i * TAU / 6;
      const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }

  // arc ticks
  c.strokeStyle = rgba(col.hi, 0.55);
  c.lineWidth = 2.6; c.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const a = -t * 0.9 + i * TAU / 4;
    c.beginPath(); c.arc(0, 0, p.r * 1.28, a, a + 0.34); c.stroke();
  }

  // orbiting motes
  for (let i = 0; i < 6; i++) {
    const a = t * (0.6 + i * 0.08) + i * TAU / 6;
    const rr = p.r * (0.6 + 0.3 * Math.sin(t * 1.3 + i));
    c.fillStyle = rgba(col.hi, 0.75);
    c.beginPath(); c.arc(Math.cos(a) * rr, Math.sin(a) * rr, 1.7, 0, TAU); c.fill();
  }

  if (p.reject > 0) {
    c.strokeStyle = rgba(DANGER, p.reject * 0.85);
    c.lineWidth = 3;
    c.beginPath(); c.arc(0, 0, p.r * 1.15, 0, TAU); c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

/* The orb's colour is blended in 8 steps while it transitions, so its gradient
   set is built at most a handful of times per colour change instead of five
   gradients every single frame. */
const MIX_STEPS = 8;
const orbGfx = { _n: 0 };

function orbColors() {
  const a = energy(orb.prevColor), b = energy(orb.color);
  const m = orb.colorMix >= 1 ? 1 : Math.round(orb.colorMix * MIX_STEPS) / MIX_STEPS;
  if (m >= 1) return b;
  return {
    rgb: [lerp(a.rgb[0], b.rgb[0], m) | 0, lerp(a.rgb[1], b.rgb[1], m) | 0, lerp(a.rgb[2], b.rgb[2], m) | 0],
    hi: [lerp(a.hi[0], b.hi[0], m) | 0, lerp(a.hi[1], b.hi[1], m) | 0, lerp(a.hi[2], b.hi[2], m) | 0],
  };
}

function orbKey() {
  if (orb.colorMix >= 1) return orb.color;
  return orb.prevColor + '>' + orb.color + ':' + Math.round(orb.colorMix * MIX_STEPS);
}

function orbLayers(c) {
  const key = orbKey();
  let L = orbGfx[key];
  if (L) return L;
  if (orbGfx._n > 40) { for (const k in orbGfx) if (k !== '_n') delete orbGfx[k]; orbGfx._n = 0; }
  const col = orbColors();
  const r = CFG.orbR;
  const bloom = c.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 2.5);
  bloom.addColorStop(0, rgba(col.rgb, 0.62));
  bloom.addColorStop(0.35, rgba(col.rgb, 0.18));
  bloom.addColorStop(1, rgba(col.rgb, 0));
  const shell = c.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
  shell.addColorStop(0, rgba(col.hi, 0.95));
  shell.addColorStop(0.35, rgba(col.rgb, 0.8));
  shell.addColorStop(0.78, rgba(col.rgb, 0.42));
  shell.addColorStop(1, rgba(col.rgb, 0.16));
  const core = c.createRadialGradient(-r * 0.1, -r * 0.12, 0, 0, 0, r * 0.62);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.35, rgba(col.hi, 0.9));
  core.addColorStop(1, rgba(col.rgb, 0));
  const inner = c.createRadialGradient(0, 0, 0, 0, 0, r * 0.75);
  inner.addColorStop(0, rgba(col.hi, 0.5));
  inner.addColorStop(1, rgba(col.hi, 0));
  L = orbGfx[key] = { bloom, shell, core, inner, col };
  orbGfx._n++;
  return L;
}

/* Fixed-size ring buffer, no allocation, and it collapses to nothing as soon
   as the character settles — inside the rest band the trail is not drawn at
   all, so a resting character costs zero. Its weight tracks the speed bands,
   which is what makes a dash read as a dash at a glance. */
function drawTrail(c, col) {
  const speed = PS.speed;
  if (speed < MOVE.speedRest) return;
  const n = Math.min(Vis.trailN, Q.level < 1 ? (TRAIL_N >> 1) : TRAIL_N);
  if (n < 3) return;
  const k = clamp((speed - MOVE.speedRest) / (MOVE.speedDash - MOVE.speedRest), 0, 1);
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
  g.addColorStop(0, rgba(col.rgb, 0));
  g.addColorStop(0.65, rgba(col.rgb, 0.16 * k));
  g.addColorStop(1, rgba(col.hi, 0.5 * (0.3 + k * 0.7)));
  c.strokeStyle = g;
  c.lineWidth = orb.r * (0.7 + k * 0.7);
  c.stroke();
  c.globalCompositeOperation = 'source-over';
}

function drawOrb(c) {
  const fading = !orb.alive && (orb.failKind === 'void' || orb.failKind === 'power');
  if ((!orb.alive && !fading) || Vis.scale <= 0.01) return;
  const col = orbColors();
  const sp = PS.speed;
  const r = orb.r * Vis.scale;

  drawTrail(c, col);

  // Aiming leans the character back into the pull; travelling stretches it
  // along its own direction. Both are the same transform, so a launch reads as
  // one continuous motion: wind up, snap out, stretch into the leap.
  let ox = 0, oy = 0, stretch = Vis.stretch, sang = Vis.stretchAng;
  if (G.aiming && G.power > 0) {
    const a = Math.atan2(G.pullY, G.pullX);
    ox = Math.cos(a) * G.power * 11;
    oy = Math.sin(a) * G.power * 11;
    stretch = G.power * 0.26;
    sang = a;
  }
  const sq = Vis.squash, sqA = Vis.squashAng;

  const idle = Math.sin(Vis.pulse * 2.1) * (sp < MOVE.speedRest ? 1 : 0);
  const bob = idle * 1.6;
  const x = orb.x + ox, y = orb.y + oy + bob;

  const L = orbLayers(c);
  // scale pulses: colour change, plus the small ones that mark regaining
  // control and touching down. Deliberately tiny — they are meant to be felt
  // rather than noticed.
  const pop = 1 + Vis.pop * 0.22 + Vis.readyPop * 0.07 + Vis.landPop * 0.05;

  c.save();
  c.translate(x, y);
  if (pop !== 1) c.scale(pop, pop);

  // outer bloom: one cached ramp, sized by transform and lit by alpha so the
  // glow still reacts to speed/charge without rebuilding anything
  c.globalCompositeOperation = 'lighter';
  const bloomS = (r / orb.r) * (1 + Vis.flash * 0.26 + G.power * 0.2 +
                                clamp(sp / MOVE.speedDash, 0, 1) * 0.2);
  c.save();
  c.scale(bloomS, bloomS);
  c.globalAlpha = Math.min(1, 0.74 + Vis.flash * 0.26 + G.power * 0.22 + Vis.readyPop * 0.14);
  c.fillStyle = L.bloom;
  c.beginPath(); c.arc(0, 0, orb.r * 2.5, 0, TAU); c.fill();
  c.globalAlpha = 1;
  c.restore();
  c.globalCompositeOperation = 'source-over';

  c.save();
  // whichever deformation is currently dominant sets the axis, so a slam reads
  // as compression against the wall rather than as a stretch along travel
  const ang = sq > stretch ? sqA : sang;
  c.rotate(ang);
  const sx = 1 + stretch + sq * 0.42;
  const sy = 1 - stretch * 0.5 - sq * 0.34;
  c.scale(sx, sy);
  c.rotate(-ang);

  // body is drawn in unit-radius space and scaled once, so every cached
  // gradient below is reused verbatim whatever the orb's current size
  const rs = r / orb.r;
  c.scale(rs, rs);

  // glass shell
  c.fillStyle = L.shell;
  c.beginPath(); c.arc(0, 0, orb.r, 0, TAU); c.fill();

  // inner energy — two slow blobs clipped to the shell
  c.save();
  c.beginPath(); c.arc(0, 0, orb.r * 0.94, 0, TAU); c.clip();
  c.globalCompositeOperation = 'lighter';
  c.fillStyle = L.inner;
  for (let i = 0; i < 2; i++) {
    const a = Vis.pulse * (0.9 + i * 0.7) + i * 2.1;
    const bx = Math.cos(a) * orb.r * 0.34, by = Math.sin(a * 1.3) * orb.r * 0.34;
    c.save();
    c.translate(bx, by);
    c.beginPath(); c.arc(0, 0, orb.r * 0.75, 0, TAU); c.fill();
    c.restore();
  }
  c.restore();

  // bright core — the white flash on a colour change rides on alpha
  const corePulse = 1 + Math.sin(Vis.pulse * 3.4) * 0.07 + Vis.flash * 0.35 + G.power * 0.2;
  c.globalCompositeOperation = 'lighter';
  c.save();
  c.scale(corePulse, corePulse);
  c.globalAlpha = Math.min(1, 0.8 + Vis.flash * 0.2);
  c.fillStyle = L.core;
  c.beginPath(); c.arc(0, 0, orb.r * 0.62, 0, TAU); c.fill();
  c.globalAlpha = 1;
  c.restore();
  c.globalCompositeOperation = 'source-over';

  // rim light
  c.strokeStyle = rgba(col.hi, 0.75);
  c.lineWidth = 1.2;
  c.beginPath(); c.arc(0, 0, orb.r - 0.8, 0, TAU); c.stroke();
  // specular
  c.fillStyle = 'rgba(255,255,255,0.55)';
  c.beginPath(); c.ellipse(-orb.r * 0.34, -orb.r * 0.4, orb.r * 0.2, orb.r * 0.13, -0.6, 0, TAU); c.fill();
  c.restore();

  // orbiting sparkles
  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    const a = Vis.pulse * (1.1 + i * 0.35) + i * 2.2;
    const rr = r * (1.35 + 0.18 * Math.sin(Vis.pulse * 2 + i));
    c.fillStyle = rgba(col.hi, 0.55 + 0.3 * Math.sin(Vis.pulse * 3 + i));
    c.beginPath(); c.arc(Math.cos(a) * rr, Math.sin(a) * rr, 1.5, 0, TAU); c.fill();
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

let lastPvx = NaN, lastPvy = NaN, lastPvf = -99;

function drawAim(c) {
  if (BASH.target) return;
  if (!G.aiming || G.power <= 0.02) return;
  const col = orbColors();
  const a = Math.atan2(-G.pullY, -G.pullX);   // launch direction
  const p = G.power;

  // Predicted path — the character is frozen while aiming, so this only has to
  // be re-simulated when the drag actually changes (plus a slow refresh so
  // moving obstacles stay honest).
  //
  // The guide shows the opening of the leap and its first rebound, never the
  // whole route: the length is scaled by power so a gentle placement shot is
  // previewed nearly to its resting point while a committed dash shows only
  // where it is going and where it will come off the first wall.
  const maxB = G.levelIndex === 0 ? 1 : 2;
  const sp = launchSpeed(p);
  const vx = Math.cos(a) * sp, vy = Math.sin(a) * sp;
  const dynamicGuide = world.movers.length || world.hazards.some(h => h.pulse);
  if (vx !== lastPvx || vy !== lastPvy ||
      (dynamicGuide && frameCount - lastPvf > 3)) {
    lastPvx = vx; lastPvy = vy; lastPvf = frameCount;
    predict(orb.x, orb.y, vx, vy, maxB, lerp(190, 330, p));
  }
  const pv = preview;

  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < pv.n; i++) {
    const u = i / Math.max(1, pv.n - 1);
    const q = pv.pts[i];
    const fade = 1 - u * u * 0.9;
    const rr = lerp(4.2, 1.3, u);
    c.fillStyle = rgba(i < 2 ? col.hi : col.rgb, 0.16 + fade * 0.6);
    c.beginPath(); c.arc(q.x, q.y, rr, 0, TAU); c.fill();
  }

  // First rebound: a short tick along the surface normal at the contact point.
  // It is only drawn when the guide actually reaches past the bounce, so the
  // mark never promises more certainty than the prediction has.
  if (pv.bounce >= 0 && pv.bounce < pv.n - 1 && !pv.hazard) {
    const nx = pv.bnx, ny = pv.bny;
    c.strokeStyle = rgba(col.hi, 0.42);
    c.lineWidth = 1.8;
    c.beginPath();
    c.moveTo(pv.bx - ny * 7, pv.by + nx * 7);
    c.lineTo(pv.bx + ny * 7, pv.by - nx * 7);
    c.stroke();
    c.fillStyle = rgba(col.hi, 0.5);
    c.beginPath(); c.arc(pv.bx, pv.by, 2.4, 0, TAU); c.fill();
  }

  if (pv.n > 0 && pv.hazard) {
    // the predicted line ends in a hazard — warn, but do not block the shot
    const q = pv.pts[pv.n - 1];
    const bl = 0.55 + 0.45 * Math.sin(G.t * 12);
    c.strokeStyle = rgba(DANGER, 0.55 + bl * 0.4);
    c.lineWidth = 2;
    c.beginPath(); c.arc(q.x, q.y, 9, 0, TAU); c.stroke();
    c.beginPath();
    c.moveTo(q.x - 4, q.y - 4); c.lineTo(q.x + 4, q.y + 4);
    c.moveTo(q.x + 4, q.y - 4); c.lineTo(q.x - 4, q.y + 4);
    c.stroke();
  } else if (pv.n > 2 && pv.blocked) {
    // prediction stops at a bumper: mark the contact instead of guessing
    const q = pv.pts[pv.n - 1];
    c.strokeStyle = rgba(col.hi, 0.45);
    c.lineWidth = 1.6;
    c.beginPath(); c.arc(q.x, q.y, 7, 0, TAU); c.stroke();
  }

  // elastic band from pull point to orb
  const px = orb.x + G.pullX, py = orb.y + G.pullY;
  const g = c.createLinearGradient(px, py, orb.x, orb.y);
  g.addColorStop(0, rgba(col.rgb, 0.0));
  g.addColorStop(1, rgba(col.hi, 0.55));
  c.strokeStyle = g;
  c.lineWidth = lerp(1.5, 4.5, p);
  c.lineCap = 'round';
  c.beginPath(); c.moveTo(px, py); c.lineTo(orb.x, orb.y); c.stroke();

  // tension ring + power arc
  const R = orb.r + 16 + p * 9;
  c.strokeStyle = rgba(col.rgb, 0.22);
  c.lineWidth = 2.5;
  c.beginPath(); c.arc(orb.x, orb.y, R, 0, TAU); c.stroke();
  c.strokeStyle = rgba(col.hi, 0.95);
  c.lineWidth = 3.2;
  c.beginPath();
  c.arc(orb.x, orb.y, R, -Math.PI / 2, -Math.PI / 2 + TAU * p);
  c.stroke();

  // direction chevrons
  c.save();
  c.translate(orb.x, orb.y); c.rotate(a);
  c.strokeStyle = rgba(col.hi, 0.8);
  c.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    const d = R + 8 + i * 7;
    const s = 4 + i * 0.6;
    const al = 0.9 - i * 0.26;
    c.strokeStyle = rgba(col.hi, al * (0.4 + p * 0.6));
    c.beginPath();
    c.moveTo(d - 3, -s); c.lineTo(d + 2, 0); c.lineTo(d - 3, s);
    c.stroke();
  }
  c.restore();

  // pull handle
  c.fillStyle = rgba(col.hi, 0.5);
  c.beginPath(); c.arc(px, py, 4 + p * 3, 0, TAU); c.fill();
  c.globalCompositeOperation = 'source-over';
}

function drawDeny(c) {
  if (G.deny <= 0.01 || !orb.alive) return;
  const u = 1 - G.deny;
  c.globalCompositeOperation = 'lighter';
  c.strokeStyle = rgba([210, 225, 255], G.deny * 0.5);
  c.lineWidth = 2;
  c.beginPath(); c.arc(orb.x, orb.y, orb.r + 40 - u * 26, 0, TAU); c.stroke();
  c.globalCompositeOperation = 'source-over';
}

/* The transition into the aimable state is the single most important thing the
   player has to read, so it gets two layers and no words: a one-shot ring that
   snaps outward the instant control returns, and — only once the character has
   been sitting there a while — the slow breathing ring that says "waiting for
   you". Both are thin, both are the character's own colour, and neither of
   them covers any geometry. */
function drawReadyHint(c) {
  if (G.phase !== 'play' || !orb.alive || G.aiming) return;
  const col = orbColors();
  c.globalCompositeOperation = 'lighter';

  if (Vis.readyPop > 0.01) {
    const u = 1 - Vis.readyPop;             // 0 at the moment of readiness
    c.strokeStyle = rgba(col.hi, Vis.readyPop * 0.55);
    c.lineWidth = 2.4 - u * 1.2;
    c.beginPath(); c.arc(orb.x, orb.y, orb.r + 4 + easeOut(u) * 26, 0, TAU); c.stroke();
  }
  if (PS.ready && PS.readyT >= 1.1) {
    const t = (G.t * 0.9) % 1;
    const a = (1 - t) * 0.5 * clamp((PS.readyT - 1.1) / 0.6, 0, 1);
    c.strokeStyle = rgba(col.hi, a);
    c.lineWidth = 2;
    c.beginPath(); c.arc(orb.x, orb.y, orb.r + 8 + t * 34, 0, TAU); c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
}

function drawParticles(c) {
  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < PMAX; i++) {
    const p = parts[i];
    if (!p.on) continue;
    const a = clamp(p.life / p.max, 0, 1);
    if (p.shape === 1) {
      const sp = Math.hypot(p.vx, p.vy);
      const l = Math.min(p.len, sp * 3.2);
      c.strokeStyle = rgba(p.col, a * 0.85);
      c.lineWidth = p.size * a;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(p.x, p.y);
      c.lineTo(p.x - p.vx / (sp || 1) * l, p.y - p.vy / (sp || 1) * l);
      c.stroke();
    } else {
      c.fillStyle = rgba(p.col, a * 0.9);
      c.beginPath(); c.arc(p.x, p.y, p.size * (0.35 + a * 0.65), 0, TAU); c.fill();
    }
  }
  for (let i = 0; i < RMAX; i++) {
    const r = rings[i];
    if (!r.on) continue;
    const u = 1 - r.life / r.max;
    const rad = lerp(r.r0, r.r1, easeOut(u));
    const a = (1 - u) * (1 - u);
    c.strokeStyle = rgba(r.col, a * 0.8);
    c.lineWidth = r.w * (1 - u * 0.7);
    c.beginPath(); c.arc(r.x, r.y, rad, 0, TAU); c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
}

function drawDust(c) {
  c.globalCompositeOperation = 'lighter';
  const step = Q.level < 1 ? 2 : 1;
  for (let i = 0; i < DUST.length; i += step) {
    const d = DUST[i];
    const a = (0.1 + 0.16 * d.z) * (0.6 + 0.4 * Math.sin(d.t));
    c.fillStyle = rgba([190, 215, 255], a);
    c.beginPath(); c.arc(d.x, d.y, d.s * d.z, 0, TAU); c.fill();
  }
  c.globalCompositeOperation = 'source-over';
}

/* One small drifting light instead of two screen-sized ones.
   Additive fills cost their whole area every frame: the old pair covered
   ~517k units^2 — about 83% of everything blended in a frame — for an effect
   the baked background lights already provide. This keeps the movement at a
   fraction of the fill cost, and drops out entirely on reduced quality. */
const ambientGfx = {};
const AMBIENT_R = 150;
function drawAmbient(c) {
  if (Q.level < 1) return;
  const acc = world.accent;
  const g = grad(ambientGfx, 'k' + acc.join(), () => {
    const gg = c.createRadialGradient(0, 0, 0, 0, 0, AMBIENT_R);
    gg.addColorStop(0, rgba(acc, 0.16));
    gg.addColorStop(0.55, rgba(acc, 0.05));
    gg.addColorStop(1, rgba(acc, 0));
    return gg;
  });
  const t = G.t * 0.07;
  const x = VW * (0.5 + 0.3 * Math.sin(t));
  const y = VH * (0.45 + 0.26 * Math.cos(t * 0.8));
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.translate(x, y);
  c.fillStyle = g;
  c.beginPath(); c.arc(0, 0, AMBIENT_R, 0, TAU); c.fill();
  c.restore();
}

function drawTransition(c) {
  if (G.transDir === 0) return;
  let u = clamp(G.transT / G.transDur, 0, 1);
  const k = G.transDir === 1 ? easeInOut(u) : 1 - easeInOut(u);
  if (k <= 0) return;
  const h = VH / 2 * k;
  const acc = world.accent;
  c.fillStyle = '#05060f';
  c.fillRect(0, 0, VW, h);
  c.fillRect(0, VH - h, VW, h);
  c.globalCompositeOperation = 'lighter';
  const g1 = c.createLinearGradient(0, h - 40, 0, h);
  g1.addColorStop(0, rgba(acc, 0));
  g1.addColorStop(1, rgba(acc, 0.55));
  c.fillStyle = g1; c.fillRect(0, h - 40, VW, 40);
  const g2 = c.createLinearGradient(0, VH - h + 40, 0, VH - h);
  g2.addColorStop(0, rgba(acc, 0));
  g2.addColorStop(1, rgba(acc, 0.55));
  c.fillStyle = g2; c.fillRect(0, VH - h, VW, 40);
  c.fillStyle = rgba([220, 240, 255], 0.85);
  c.fillRect(0, h - 1.5, VW, 1.5);
  c.fillRect(0, VH - h, VW, 1.5);
  c.globalCompositeOperation = 'source-over';
}

function render() {
  const c = ctx;
  c.setTransform(RS, 0, 0, RS, 0, 0);
  // the baked layer is opaque and covers the canvas, so a separate clear is
  // one full-screen write per frame we simply do not need — except while the
  // camera is offset, when the edges would otherwise smear
  const ox = cam.sx + cam.kx, oy = cam.sy + cam.ky;
  const moved = ox !== 0 || oy !== 0 || cam.zoom !== 1;
  if (moved) c.clearRect(0, 0, VW, VH);

  c.save();
  // camera: shake plus the small directional impulse a launch or a slam leaves
  const z = cam.zoom;
  c.translate(VW / 2 + ox, VH / 2 + oy);
  c.scale(z, z);
  c.translate(-VW / 2, -VH / 2);

  c.drawImage(bakeCv, 0, 0, VW, VH);
  drawAmbient(c);
  drawDust(c);

  for (let i = 0; i < world.voids.length; i++) drawVoid(c, world.voids[i]);
  for (let i = 0; i < world.paints.length; i++) drawPaintWall(c, world.paints[i]);
  for (let i = 0; i < world.livewalls.length; i++) drawLiveWall(c, world.livewalls[i]);
  for (let i = 0; i < world.ice.length; i++) drawIce(c, world.ice[i]);
  for (let i = 0; i < world.crystals.length; i++) drawCrystal(c, world.crystals[i]);
  for (let i = 0; i < world.gates.length; i++) drawGate(c, world.gates[i]);
  for (let i = 0; i < world.hazards.length; i++) drawHazard(c, world.hazards[i]);
  for (let i = 0; i < world.bumpers.length; i++) drawBumper(c, world.bumpers[i]);
  for (let i = 0; i < world.movers.length; i++) {
    const m = world.movers[i];
    if (m.kind === 'wall') { if (m.color) drawPaintWall(c, m); else drawWall(c, m, true); }
  }
  drawPortal(c, world.portal);

  drawReadyHint(c);
  drawDeny(c);
  drawAim(c);
  // The character is the one thing here that is meant to be replaceable: the
  // pose is published either way, and a rig, once attached, draws it instead.
  const pose = Player.syncPose();
  if (Player.rig) Player.rig.sync(pose, c); else drawOrb(c);
  drawBash(c);
  drawParticles(c);

  c.restore();

  // flash
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

/* ============================================================
   9. INPUT
   ============================================================ */

/* The canvas rect is cached by fit(); reading it on every pointermove forces a
   layout flush mid-drag, which is exactly when the game must stay smooth. */
const gp = { x: 0, y: 0 };
function toGame(e) {
  gp.x = (e.clientX - canvasRect.left) * (VW / canvasRect.width);
  gp.y = (e.clientY - canvasRect.top) * (VH / canvasRect.height);
  return gp;
}

let pointerId = null;

/* An early touch, kept alive until the character is actually aimable. */
const buffered = { active: false, t: 0, id: null, x: 0, y: 0 };
function clearBuffer() { buffered.active = false; buffered.id = null; }

function updateDrag(px, py) {
  if (BASH.target) {
    const dx = px - G.anchorX, dy = py - G.anchorY;
    if (Math.hypot(dx, dy) > 8) BASH.angle = Math.atan2(dy, dx);
    Sfx.tensionUpdate(.8);
    return;
  }
  let dx = G.anchorX - px, dy = G.anchorY - py;
  const d = Math.hypot(dx, dy);
  const cl = Math.min(d, CFG.maxDrag);
  if (d > 0.001) { dx = dx / d * cl; dy = dy / d * cl; }
  G.pullX = -dx; G.pullY = -dy;          // where the finger pulled to (relative to the character)
  G.power = d < CFG.minDrag ? 0 : clamp((cl - CFG.minDrag) / (CFG.maxDrag - CFG.minDrag), 0, 1);
  Sfx.tensionUpdate(G.power);
}

/* Begin an aim. `ax`/`ay` is the anchor the drag is measured from: the
   character itself for a touch that landed near it — so an off-centre tap
   cannot spawn instant power — or the touch point for one that landed further
   away, which is what lets the player drag comfortably from anywhere on the
   screen instead of having to find a 30-pixel target. */
function beginAim(ax, ay, px, py, id) {
  G.anchorX = ax; G.anchorY = ay;
  G.aiming = true;
  lastPvx = NaN;
  pointerId = id;
  if (id !== null && id !== undefined && dom.canvas.setPointerCapture) {
    try { dom.canvas.setPointerCapture(id); } catch (err) {}
  }
  Sfx.tensionStart();
  updateDrag(px, py);
  setHint('');
}

function onDown(e) {
  if (G.aiming || (e.button !== undefined && e.button !== 0)) return;
  // a second finger never steals a touch that is already waiting its turn
  if (buffered.active && e.pointerId !== buffered.id) return;
  Sfx.unlock();
  clearBuffer();
  if (G.phase === 'done') return;
  if (e.target === dom.restart || dom.restart.contains(e.target)) return;
  if (G.phase !== 'play' || G.transDir !== 0 || !orb.alive) return;
  const target = bashTarget();
  if (!target && !canGrab()) {
    // No launches remain, or the level is transitioning.
    if (G.phase === 'play' && orb.alive) G.deny = 1;
    return;
  }
  canvasRect = dom.canvas.getBoundingClientRect();  // one read per drag, not per move
  const p = toGame(e);
  const reach = Math.hypot(p.x - orb.x, p.y - orb.y);
  // read the body directly: a touch can land between two fixed steps, and the
  // answer input gives must be the same one the simulation would give
  const sp = Math.hypot(orb.vx, orb.vy);

  if (!isStable(sp)) {
    // Moving too fast to take hold of. A Bash target within reach redirects the
    // flight; otherwise the touch is either buffered (the character is nearly
    // settled and the player was simply early) or refused.
    if (target && reach <= CFG.airGrabRadius) {
      BASH.target = target; BASH.held = 0;
      BASH.angle = Math.atan2(orb.vy, orb.vx);
      beginAim(p.x, p.y, p.x, p.y, e.pointerId);
      e.preventDefault();
      return;
    }
    if (canGrab() && sp < MOVE.catchSpeed) {
      buffered.active = true; buffered.t = 0; buffered.id = e.pointerId;
      buffered.x = p.x; buffered.y = p.y;
      e.preventDefault();
      return;
    }
    if (reach <= CFG.airGrabRadius) showToast('NEED A GOLD SPARK NEARBY', true);
    G.deny = 1;
    return;
  }

  // Stable: a normal aim. A Bash target is still honoured, because chaining off
  // a spark from a standstill is a legitimate move.
  BASH.target = target; BASH.held = 0;
  if (target) BASH.angle = -Math.PI / 2;
  const near = reach < CFG.grabRadius;
  const centred = !target && near;
  beginAim(centred ? orb.x : p.x, centred ? orb.y : p.y, p.x, p.y, e.pointerId);
  e.preventDefault();
}

/* Spend a buffered touch the moment control comes back. The drag restarts from
   the character, so the shot the player gets is the one they would have got had
   they touched a moment later — never a stale vector from where it used to be. */
function updateAimBuffer() {
  if (!buffered.active) return;
  buffered.t += STEP;
  if (!canGrab() || !orb.alive || G.phase !== 'play') { clearBuffer(); return; }
  if (PS.ready) {
    const id = buffered.id;
    clearBuffer();
    beginAim(orb.x, orb.y, orb.x, orb.y, id);
    return;
  }
  if (buffered.t >= MOVE.aimBuffer) { clearBuffer(); G.deny = 1; }
}

function onMove(e) {
  if (buffered.active && e.pointerId === buffered.id) {
    // keep the buffered touch alive and following the finger
    buffered.x = toGame(e).x; buffered.y = gp.y;
    e.preventDefault();
    return;
  }
  if (!G.aiming || (pointerId !== null && e.pointerId !== pointerId)) return;
  const p = toGame(e);
  updateDrag(p.x, p.y);
  e.preventDefault();
}

function onUp(e) {
  if (buffered.active && e.pointerId === buffered.id) {
    clearBuffer();                      // lifted before control came back
    e.preventDefault();
    return;
  }
  if (!G.aiming || (pointerId !== null && e.pointerId !== pointerId)) return;
  if (BASH.target) { releaseBash(); e.preventDefault(); return; }
  G.aiming = false;
  pointerId = null;
  Sfx.tensionStop();
  const p = G.power;
  if (p > 0.02 && canGrab()) {
    launch(Math.atan2(-G.pullY, -G.pullX), p);
  }
  G.power = 0; G.pullX = 0; G.pullY = 0;
  e.preventDefault();
}

dom.canvas.addEventListener('pointerdown', onDown, { passive: false });
window.addEventListener('pointermove', onMove, { passive: false });
window.addEventListener('pointerup', onUp, { passive: false });
function cancelAim() {
  BASH.target = null; BASH.held = 0;
  G.aiming = false;
  pointerId = null;
  clearBuffer();
  G.power = 0; G.pullX = 0; G.pullY = 0;
  lastPvx = NaN;
  Sfx.tensionStop();
}
window.addEventListener('pointercancel', cancelAim);
dom.canvas.addEventListener('lostpointercapture', cancelAim);
window.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
window.addEventListener('touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });

dom.restart.addEventListener('click', (e) => { e.stopPropagation(); Sfx.unlock(); restartLevel(); });

function applyMute(v) {
  muted = v;
  Sfx.setMuted(v);
  dom.sound.classList.toggle('muted', v);
  dom.sound.setAttribute('aria-pressed', String(!v));
  try { localStorage.setItem('flux.muted', v ? '1' : '0'); } catch (err) {}
}
dom.sound.addEventListener('click', (e) => {
  e.stopPropagation();
  Sfx.unlock();
  applyMute(!muted);
  if (!muted) Sfx.ui();
});
dom.endRestart.addEventListener('click', () => { Sfx.unlock(); Sfx.ui(); restartRun(); });

let muted = false;

/* Keyboard shortcuts are a desktop convenience only — every one of them has a
   visible control. The FPS readout is a developer tool: it needs ?dev=1 (or
   localStorage flux.dev) and is never shown to a normal player. */
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
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(fit).observe(dom.canvas);
}

/* ============================================================
   10. MAIN LOOP
   ============================================================ */

const DT_MAX = 1 / 15;        // never simulate more than 4 steps for one frame

let last = 0, acc = 0, frameCount = 0, doneFrames = 0;
let fpsOn = false, fpsFrames = 0, fpsSince = 0;
let frameId = 0;
function frame(now) {
  frameId = requestAnimationFrame(frame);
  if (document.hidden) return;
  // The end card has CSS animations; it needs no background simulation once
  // the final curtain has cleared. Restart keeps the same RAF chain.
  if (G.phase === 'done' && G.transDir === 0 && doneFrames >= 3) {
    last = now; acc = 0;
    return;
  }
  if (!last) last = now;
  const rawDt = (now - last) / 1000;
  let dt = rawDt;
  last = now;
  const workStart = performance.now();

  // A stall (tab switch, GC, a slow frame) must never turn into a burst of
  // physics: clamp, then let the accumulator run at most four fixed steps.
  if (dt > DT_MAX) dt = DT_MAX;
  acc += dt;
  let guard = 0;
  while (acc >= STEP && guard < 4) { simStep(); acc -= STEP; guard++; }
  if (acc > STEP) acc = 0;

  // adaptive quality — decoration only, physics is untouched
  if (rawDt > 0 && rawDt < 0.25) Q.avg += (rawDt * 1000 - Q.avg) * 0.08;
  // Physics updates at 60 Hz. Higher-refresh displays need no duplicate
  // canvas repaint of exactly the same state.
  if (!guard) return;
  frameCount++;
  render();
  if (G.phase === 'done' && G.transDir === 0) doneFrames++;
  Q.work += (performance.now() - workStart - Q.work) * 0.08;
  if (Q.level === 1) {
    if (Q.avg > 21 || Q.work > 14) {
      if (++Q.bad > 40) { Q.level = 0; Q.particleScale = 0.55; Q.bad = 0; fit(); }
    }
    else Q.bad = 0;
  } else {
    // A healthy 60 Hz screen is ~16.7 ms: the former <15 ms threshold could
    // never restore quality there. Require sustained headroom before retrying.
    if (Q.avg < 18 && Q.work < 7) {
      if (++Q.good > 480) { Q.level = 1; Q.particleScale = 1; Q.good = 0; fit(); }
    }
    else Q.good = 0;
  }

  // optional readout — one DOM write every half second, never per frame
  if (fpsOn) {
    fpsFrames++;
    if (now - fpsSince >= 500) {
      const f = Math.round(fpsFrames * 1000 / (now - fpsSince));
      dom.fps.textContent = f + ' FPS · ' + Q.avg.toFixed(1) + ' ms · Q' + Q.level;
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

/* ---- small debug surface (handy for tuning / automated checks) ---- */
window.FLUX = {
  G, orb, world, LEVELS, CFG, Q,
  // movement surface: the tuning table is live, so values can be adjusted from
  // the console and felt immediately without a reload
  MOVE, PS, Vis, Player,
  state: () => PS.state,
  aimable: () => PS.ready,
  go: (i) => startLevel(clamp(i | 0, 0, LEVELS.length - 1)),
  shoot: (ang, power) => { if (canGrab()) launch(ang, clamp(power, 0, 1)); },
  tick: (n) => { for (let i = 0; i < n; i++) simStep(); },
  // bench(n)       — JS cost of render() only
  // bench(n, true) — also stalls on a pixel readback so the timing includes
  //                  GPU fill-rate. Off by default: repeated readbacks can make
  //                  the browser drop this canvas to software rendering.
  // dev: force a specific backing-store scale to compare fill-rate costs
  forceScale: (mult) => {
    const r = dom.canvas.getBoundingClientRect();
    dom.canvas.width = Math.round(r.width * mult);
    dom.canvas.height = Math.round(r.height * mult);
    RS = dom.canvas.width / VW;
    bakeStatic();
    return { backing: [dom.canvas.width, dom.canvas.height], mp: +(dom.canvas.width * dom.canvas.height / 1e6).toFixed(2) };
  },
  bench: (n, sync) => {
    n = n || 120;
    render(); // warm
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      render();
      if (sync === true) ctx.getImageData(0, 0, 1, 1);
    }
    const ms = (performance.now() - t0) / n;
    return { frameMs: +ms.toFixed(3), budgetPct: +(ms / 16.67 * 100).toFixed(1) };
  },
  mute: (v) => { muted = !!v; Sfx.setMuted(muted); },
  ready: () => canGrab(),
};

})();
