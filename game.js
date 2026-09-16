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
  minLaunch: 3.4,      // speed units / step
  maxLaunch: 17.4,
  maxSpeed: 27,
  damping: 0.9886,     // velocity retained per step
  brakeSpeed: 3.6,     // extra braking below this speed
  stopSpeed: 0.42,
  readySpeed: 2.0,     // orb is grabbable below this
  restitution: 0.735,
  tangent: 0.965,
  grabRadius: 132,
};

const FIELD = { x0: 15, y0: 93, x1: 525, y1: 941 };

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
const easeInOut = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const DEG = Math.PI / 180;

const ENERGY = {
  violet: { rgb: [166, 108, 255], hi: [238, 224, 255] },
  cyan:   { rgb: [ 46, 226, 255], hi: [216, 250, 255] },
  orange: { rgb: [255, 150,  60], hi: [255, 232, 198] },
  lime:   { rgb: [178, 255,  88], hi: [238, 255, 210] },
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

/* ============================================================
   2. AUDIO — small synth kit, unlocked on first interaction
   ============================================================ */

const Sfx = (() => {
  let ctx = null, master = null, noiseBuf = null, on = true, ready = false;
  let tension = null;

  function build() {
    if (ctx || !on) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { on = false; return null; }
    try { ctx = new AC(); } catch (e) { on = false; return null; }
    master = ctx.createGain();
    master.gain.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 24; comp.ratio.value = 9;
    comp.attack.value = 0.004; comp.release.value = 0.2;
    master.connect(comp); comp.connect(ctx.destination);

    const n = Math.floor(ctx.sampleRate * 0.9);
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

  function tone(o) {
    if (!ready || !on) return;
    const t = ctx.currentTime + (o.delay || 0);
    const dur = o.dur || 0.25;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(24, o.f1), t + dur);
    const g = ctx.createGain();
    const peak = Math.max(0.0005, o.peak || 0.14);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.attack || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = osc;
    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = o.filter.type || 'lowpass';
      f.frequency.setValueAtTime(o.filter.f, t);
      if (o.filter.f1) f.frequency.exponentialRampToValueAtTime(Math.max(40, o.filter.f1), t + dur);
      f.Q.value = o.filter.q || 1;
      node.connect(f); node = f;
    }
    node.connect(g); g.connect(master);
    osc.start(t); osc.stop(t + dur + 0.06);
  }

  function noise(o) {
    if (!ready || !on) return;
    const t = ctx.currentTime + (o.delay || 0);
    const dur = o.dur || 0.2;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = o.rate || 1;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.f0 || 900, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(60, o.f1), t + dur);
    f.Q.value = o.q || 1.1;
    const g = ctx.createGain();
    const peak = Math.max(0.0005, o.peak || 0.08);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.attack || 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t); src.stop(t + dur + 0.05);
  }

  /* --- continuous drag tension --- */
  function tensionStart() {
    if (!ready || !on || tension) return;
    const osc = ctx.createOscillator(); osc.type = 'sine';
    const osc2 = ctx.createOscillator(); osc2.type = 'triangle';
    const g = ctx.createGain(); g.gain.value = 0.0001;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 6;
    osc.frequency.value = 120; osc2.frequency.value = 180;
    osc.connect(f); osc2.connect(f); f.connect(g); g.connect(master);
    osc.start(); osc2.start();
    tension = { osc, osc2, g, f };
  }
  function tensionUpdate(p) {
    if (!tension) return;
    const t = ctx.currentTime;
    tension.osc.frequency.setTargetAtTime(90 + p * 250, t, 0.04);
    tension.osc2.frequency.setTargetAtTime(136 + p * 380, t, 0.04);
    tension.f.frequency.setTargetAtTime(500 + p * 2200, t, 0.05);
    tension.g.gain.setTargetAtTime(0.008 + p * 0.05, t, 0.05);
  }
  function tensionStop() {
    if (!tension) return;
    const t = ctx.currentTime;
    const { osc, osc2, g } = tension;
    g.gain.setTargetAtTime(0.0001, t, 0.03);
    osc.stop(t + 0.2); osc2.stop(t + 0.2);
    tension = null;
  }

  return {
    unlock, tensionStart, tensionUpdate, tensionStop,
    setMuted(v) { on = !v; if (master) master.gain.value = v ? 0 : 0.7; },
    launch(p) {
      tone({ type: 'sawtooth', f0: 210 + p * 260, f1: 70, dur: 0.36, peak: 0.13,
             filter: { type: 'lowpass', f: 2400 + p * 2600, f1: 380, q: 4 } });
      tone({ type: 'sine', f0: 620 + p * 420, f1: 180, dur: 0.22, peak: 0.07 });
      noise({ dur: 0.2, peak: 0.055 + p * 0.05, f0: 1800 + p * 2200, f1: 260, q: 0.9 });
    },
    bounce(v) {
      const s = clamp(v / 14, 0.12, 1);
      tone({ type: 'sine', f0: 280 + s * 260, f1: 140 + s * 90, dur: 0.085, peak: 0.03 + s * 0.07 });
      noise({ dur: 0.06, peak: 0.02 + s * 0.05, f0: 1500 + s * 2600, f1: 700, q: 1.6 });
    },
    bumper() {
      tone({ type: 'triangle', f0: 420, f1: 980, dur: 0.16, peak: 0.12 });
      tone({ type: 'triangle', f0: 640, f1: 1460, dur: 0.2, peak: 0.08, delay: 0.035 });
      noise({ dur: 0.26, peak: 0.07, f0: 600, f1: 3200, q: 0.8 });
    },
    gate() {
      tone({ type: 'sine', f0: 880, dur: 0.34, peak: 0.09 });
      tone({ type: 'sine', f0: 1320, dur: 0.42, peak: 0.06, delay: 0.04 });
      tone({ type: 'sine', f0: 1760, dur: 0.5, peak: 0.035, delay: 0.08 });
      noise({ dur: 0.3, peak: 0.05, f0: 400, f1: 5200, q: 0.7 });
    },
    reject() {
      tone({ type: 'square', f0: 320, f1: 190, dur: 0.14, peak: 0.05,
             filter: { type: 'lowpass', f: 1400, f1: 500, q: 2 } });
      noise({ dur: 0.12, peak: 0.03, f0: 900, f1: 300, q: 2 });
    },
    portal() {
      const seq = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      seq.forEach((f, i) => {
        tone({ type: 'triangle', f0: f, dur: 0.7 - i * 0.05, peak: 0.085, delay: i * 0.065 });
        tone({ type: 'sine', f0: f * 2, dur: 0.4, peak: 0.03, delay: i * 0.065 });
      });
      noise({ dur: 0.7, peak: 0.05, f0: 300, f1: 6000, q: 0.6 });
    },
    fail() {
      tone({ type: 'sawtooth', f0: 260, f1: 48, dur: 0.5, peak: 0.12,
             filter: { type: 'lowpass', f: 1600, f1: 160, q: 3 } });
      noise({ dur: 0.36, peak: 0.1, f0: 2600, f1: 160, q: 0.7 });
    },
    ui() {
      tone({ type: 'sine', f0: 1180, f1: 820, dur: 0.07, peak: 0.05 });
    },
    sweep() {
      noise({ dur: 0.5, peak: 0.05, f0: 260, f1: 3400, q: 0.7 });
      tone({ type: 'sine', f0: 140, f1: 420, dur: 0.45, peak: 0.05 });
    },
    complete() {
      [523.25, 783.99, 1046.5, 1567.98].forEach((f, i) =>
        tone({ type: 'triangle', f0: f, dur: 1.2, peak: 0.08, delay: i * 0.1 }));
    },
  };
})();

/* ============================================================
   3. PARTICLES & SHOCKWAVES  (fixed pools, zero allocation)
   ============================================================ */

const PMAX = 340;
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

const RMAX = 20;
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
for (let i = 0; i < 44; i++) {
  DUST.push({ x: rand(0, VW), y: rand(0, VH), z: rand(0.25, 1),
              vx: rand(-0.09, 0.09), vy: rand(-0.16, -0.03), s: rand(0.6, 2.0), t: rand(0, TAU) });
}
function updateDust() {
  for (const d of DUST) {
    d.x += d.vx * d.z; d.y += d.vy * d.z; d.t += 0.02 * d.z;
    if (d.y < -8) { d.y = VH + 8; d.x = rand(0, VW); }
    if (d.x < -8) d.x = VW + 8; else if (d.x > VW + 8) d.x = -8;
  }
}

/* ============================================================
   4. LEVEL DATA  (pure data — entities are generic & reusable)
   ============================================================
   wall   : {x,y,w,h,a?}            solid, optional rotation (deg)
   bumper : {x,y,r,power}           radial launcher
   hazard : {x,y,w,h,a?,pulse?}     destroys the orb while active
   gate   : {x,y,w,h,a?,color}      rewrites the orb's energy colour
   portal : {x,y,r?,color?}         exit; color null = accepts any
   motion : {type:'osc',dx,dy,period,phase} | {type:'spin',speed}
            may be attached to any wall / bumper / hazard
   ============================================================ */

const LEVELS = [
  {
    name: 'INFLUX',
    tip: 'Drag  ·  Aim  ·  Release',
    bg: ['#191c44', '#07091b'], accent: [140, 130, 255],
    start: { x: 120, y: 850 }, color: 'violet',
    portal: { x: 430, y: 205 },
    walls: [
      { x: 320, y: 902, w: 340, h: 20, a: -13 },
      { x: 140, y: 520, w: 210, h: 22 },
      { x: 58,  y: 660, w: 20,  h: 200 },
      { x: 230, y: 330, w: 200, h: 18 },
      { x: 474, y: 690, w: 20,  h: 180, a: 18 },
      { x: 470, y: 380, w: 90,  h: 18, a: -34 },
    ],
  },
  {
    name: 'REBOUND',
    tip: 'Walls are on your side — bank the shot',
    bg: ['#15204a', '#06091c'], accent: [90, 170, 255],
    start: { x: 110, y: 862 }, color: 'violet',
    portal: { x: 110, y: 235 },
    walls: [
      { x: 186, y: 606, w: 344, h: 22 },          // lower divider — gap on the right
      { x: 455, y: 470, w: 170, h: 18, a: -45 },  // deflector: kicks the climb up-left
      { x: 400, y: 330, w: 250, h: 20 },          // upper shelf — gap on the left
      { x: 250, y: 215, w: 120, h: 18 },          // roof of the exit pocket
      { x: 350, y: 782, w: 240, h: 18, a: -20 },
      { x: 60,  y: 470, w: 20,  h: 120 },
    ],
  },
  {
    name: 'KINETIC',
    tip: 'Bumpers turn contact into velocity',
    bg: ['#1f1748', '#08091f'], accent: [170, 120, 255],
    start: { x: 270, y: 868 }, color: 'violet',
    portal: { x: 430, y: 205 },
    walls: [
      { x: 107, y: 470, w: 186, h: 22 },
      { x: 433, y: 470, w: 186, h: 22 },
      { x: 200, y: 300, w: 170, h: 18 },
      { x: 72,  y: 700, w: 20,  h: 180 },
      { x: 468, y: 700, w: 20,  h: 180 },
      { x: 270, y: 180, w: 150, h: 18 },
    ],
    bumpers: [{ x: 270, y: 645, r: 38, power: 15 }],
  },
  {
    name: 'VOLT',
    tip: 'The beams pulse — time your run',
    bg: ['#2a1238', '#0c0718'], accent: [255, 90, 150],
    start: { x: 108, y: 872 }, color: 'violet',
    portal: { x: 270, y: 192 },
    walls: [
      { x: 130, y: 700, w: 232, h: 22 },
      { x: 410, y: 462, w: 232, h: 22 },
      { x: 92,  y: 300, w: 20,  h: 200 },
      { x: 448, y: 300, w: 20,  h: 200 },
      { x: 270, y: 596, w: 120, h: 16, a: 30 },
      { x: 392, y: 836, w: 190, h: 16, a: -24 },
    ],
    hazards: [
      { x: 386, y: 700, w: 280, h: 14, pulse: { period: 2.6, duty: 0.34, phase: 0 } },
      { x: 154, y: 462, w: 280, h: 14, pulse: { period: 3.3, duty: 0.34, phase: 0.45 } },
    ],
  },
  {
    name: 'SPECTRA',
    tip: 'Gates rewrite your energy signature',
    bg: ['#102544', '#050f20'], accent: [60, 210, 255],
    start: { x: 112, y: 858 }, color: 'violet',
    portal: { x: 430, y: 215, color: 'cyan' },
    walls: [
      { x: 120, y: 660, w: 212, h: 22 },
      { x: 420, y: 660, w: 212, h: 22 },
      { x: 300, y: 420, w: 250, h: 20 },
      { x: 66,  y: 280, w: 20,  h: 180 },
      { x: 250, y: 800, w: 200, h: 18, a: 16 },
      { x: 430, y: 300, w: 120, h: 18 },
    ],
    gates: [{ x: 270, y: 660, w: 88, h: 18, color: 'cyan' }],
  },
  {
    name: 'PRISM',
    tip: 'Only the final gate decides your colour',
    bg: ['#241540', '#0a0819'], accent: [190, 120, 255],
    start: { x: 270, y: 872 }, color: 'violet',
    portal: { x: 270, y: 196, color: 'cyan' },
    walls: [
      { x: 80,  y: 660, w: 132, h: 22 },
      { x: 270, y: 660, w: 120, h: 22 },
      { x: 460, y: 660, w: 132, h: 22 },
      { x: 80,  y: 400, w: 132, h: 22 },
      { x: 270, y: 400, w: 120, h: 22 },
      { x: 460, y: 400, w: 132, h: 22 },
      { x: 150, y: 530, w: 110, h: 16, a: -22 },
      { x: 390, y: 530, w: 110, h: 16, a: 22 },
    ],
    gates: [
      { x: 178, y: 660, w: 64, h: 18, color: 'cyan' },
      { x: 362, y: 660, w: 64, h: 18, color: 'orange' },
      { x: 178, y: 400, w: 64, h: 18, color: 'orange' },
      { x: 362, y: 400, w: 64, h: 18, color: 'cyan' },
    ],
  },
  {
    name: 'KINEMA',
    tip: 'Moving parts — wait for the window',
    bg: ['#132b44', '#05101f'], accent: [80, 200, 255],
    start: { x: 100, y: 872 }, color: 'violet',
    portal: { x: 442, y: 200 },
    walls: [
      { x: 82,  y: 540, w: 136, h: 22 },
      { x: 458, y: 540, w: 136, h: 22 },
      { x: 270, y: 430, w: 300, h: 18, motion: { type: 'spin', speed: 0.8 } },
      { x: 270, y: 842, w: 170, h: 18, motion: { type: 'osc', dx: 118, dy: 0, period: 4.4, phase: 0.25 } },
      { x: 270, y: 196, w: 150, h: 18 },
      { x: 60,  y: 300, w: 20,  h: 150 },
    ],
    bumpers: [
      { x: 270, y: 700, r: 36, power: 15, motion: { type: 'osc', dx: 150, dy: 0, period: 3.4, phase: 0 } },
    ],
  },
  {
    name: 'SINGULARITY',
    tip: 'Everything you have learned, at once',
    bg: ['#2b1034', '#090616'], accent: [255, 110, 190],
    start: { x: 82, y: 878 }, color: 'violet',
    portal: { x: 455, y: 196, color: 'cyan' },
    walls: [
      { x: 150, y: 660, w: 272, h: 22 },
      { x: 470, y: 660, w: 112, h: 22 },
      { x: 270, y: 430, w: 300, h: 22 },
      { x: 430, y: 320, w: 150, h: 16, motion: { type: 'spin', speed: 0.75 } },
      { x: 330, y: 268, w: 180, h: 18, a: 18 },
      { x: 52,  y: 320, w: 20,  h: 120 },
      { x: 205, y: 786, w: 190, h: 18, a: -26 },
    ],
    bumpers: [{ x: 320, y: 830, r: 34, power: 14.5 }],
    hazards: [
      { x: 150, y: 560, w: 268, h: 14, pulse: { period: 2.9, duty: 0.4, phase: 0.15 } },
      { x: 92,  y: 250, w: 14,  h: 150 },
    ],
    gates: [{ x: 350, y: 660, w: 128, h: 18, color: 'cyan' }],
  },
];

const BORDER = [
  { x: 270, y: 80,  w: 580, h: 26 },
  { x: 270, y: 954, w: 580, h: 26 },
  { x: 2,   y: 517, w: 26,  h: 920 },
  { x: 538, y: 517, w: 26,  h: 920 },
];

/* ============================================================
   5. WORLD BUILDING
   ============================================================ */

const world = {
  solids: [],    // every collidable rect (static + moving)
  statics: [],   // bakeable subset
  movers: [],    // entities with motion (drawn live)
  bumpers: [],
  hazards: [],
  gates: [],
  portal: null,
  bg: ['#191c44', '#07091b'],
  accent: [140, 130, 255],
};

function prepEntity(e, kind) {
  e.kind = kind;
  e.a = (e.a || 0) * DEG;
  e.bx = e.x; e.by = e.y; e.ba = e.a;
  e.px = e.x; e.py = e.y;
  e.vx = 0; e.vy = 0; e.av = 0;
  e.seed = Math.random() * 100;
  if (e.motion && e.motion.type === 'spin') e.motion.speed = e.motion.speed;
  return e;
}

function buildWorld(src) {
  const L = clone(src);
  world.solids.length = 0; world.statics.length = 0; world.movers.length = 0;
  world.bumpers.length = 0; world.hazards.length = 0; world.gates.length = 0;
  world.bg = L.bg; world.accent = L.accent;

  const walls = (L.walls || []).concat(clone(BORDER));
  for (const w of walls) {
    prepEntity(w, 'wall');
    world.solids.push(w);
    if (w.motion) world.movers.push(w); else world.statics.push(w);
  }
  for (const b of (L.bumpers || [])) {
    prepEntity(b, 'bumper'); b.hit = 0;
    world.bumpers.push(b);
    if (b.motion) world.movers.push(b);
  }
  for (const h of (L.hazards || [])) {
    prepEntity(h, 'hazard'); h.k = 1;
    world.hazards.push(h);
    if (h.motion) world.movers.push(h);
  }
  for (const g of (L.gates || [])) {
    prepEntity(g, 'gate'); g.flash = 0;
    world.gates.push(g);
    if (g.motion) world.movers.push(g);
  }
  const p = prepEntity(Object.assign({ r: 34, color: null }, L.portal), 'portal');
  p.open = 0; p.reject = 0;
  world.portal = p;
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
  const ca = Math.cos(-e.a), sa = Math.sin(-e.a);
  const dx = px - e.x, dy = py - e.y;
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
  const cb = Math.cos(e.a), sb = Math.sin(e.a);
  return { nx: nx * cb - ny * sb, ny: nx * sb + ny * cb, pen };
}

function overlapsBox(px, py, r, e) {
  return circleVsBox(px, py, r, e) !== null;
}

const RES = { impact: 0, wall: false, bumper: null, nx: 0, ny: 0, hx: 0, hy: 0 };

function resolveBox(s, e) {
  const hit = circleVsBox(s.x, s.y, s.r, e);
  if (!hit) return;
  s.x += hit.nx * hit.pen;
  s.y += hit.ny * hit.pen;
  let ovx = e.vx || 0, ovy = e.vy || 0;
  if (e.av) {
    const rx = s.x - e.x, ry = s.y - e.y;
    ovx += -e.av * ry; ovy += e.av * rx;
  }
  let rvx = s.vx - ovx, rvy = s.vy - ovy;
  const vn = rvx * hit.nx + rvy * hit.ny;
  if (vn < 0) {
    const nvx = hit.nx * vn, nvy = hit.ny * vn;
    const tvx = rvx - nvx, tvy = rvy - nvy;
    rvx = tvx * CFG.tangent - nvx * CFG.restitution;
    rvy = tvy * CFG.tangent - nvy * CFG.restitution;
    s.vx = rvx + ovx; s.vy = rvy + ovy;
    if (-vn > RES.impact) {
      RES.impact = -vn; RES.nx = hit.nx; RES.ny = hit.ny;
      RES.hx = s.x - hit.nx * s.r; RES.hy = s.y - hit.ny * s.r;
    }
    RES.wall = true;
  }
}

function resolveBumper(s, b) {
  const dx = s.x - b.x, dy = s.y - b.y;
  const rr = s.r + b.r;
  const d2 = dx * dx + dy * dy;
  if (d2 > rr * rr) return;
  const d = Math.sqrt(d2) || 0.0001;
  const nx = dx / d, ny = dy / d;
  s.x = b.x + nx * rr; s.y = b.y + ny * rr;
  const vn = s.vx * nx + s.vy * ny;
  const out = Math.min(CFG.maxSpeed, b.power + Math.max(0, -vn) * 0.45);
  const tvx = s.vx - nx * vn, tvy = s.vy - ny * vn;
  s.vx = tvx * 0.5 + nx * out;
  s.vy = tvy * 0.5 + ny * out;
  RES.bumper = b; RES.impact = Math.max(RES.impact, out);
  RES.hx = b.x + nx * b.r; RES.hy = b.y + ny * b.r;
  RES.nx = nx; RES.ny = ny;
}

function stepBody(s, useBumpers) {
  RES.impact = 0; RES.wall = false; RES.bumper = null;
  const sp = Math.hypot(s.vx, s.vy);
  const n = Math.min(9, Math.max(1, Math.ceil(sp / (s.r * 0.5))));
  for (let i = 0; i < n; i++) {
    // velocity is re-read every substep: after a bounce the remainder of the
    // step continues along the new direction instead of ploughing on
    s.x += s.vx / n; s.y += s.vy / n;
    for (let k = 0; k < world.solids.length; k++) resolveBox(s, world.solids[k]);
    if (useBumpers) {
      for (let k = 0; k < world.bumpers.length; k++) resolveBumper(s, world.bumpers[k]);
      if (RES.bumper) break;
    }
  }
  return RES;
}

function applyDamping(s) {
  s.vx *= CFG.damping; s.vy *= CFG.damping;
  const sp = Math.hypot(s.vx, s.vy);
  if (sp > CFG.maxSpeed) { const f = CFG.maxSpeed / sp; s.vx *= f; s.vy *= f; }
  else if (sp < CFG.brakeSpeed) {
    const f = lerp(0.9, 1, sp / CFG.brakeSpeed);
    s.vx *= f; s.vy *= f;
    if (sp < CFG.stopSpeed) { s.vx = 0; s.vy = 0; }
  }
}

/* --- trajectory prediction (shares the exact same integrator) --- */
const probe = { x: 0, y: 0, vx: 0, vy: 0, r: CFG.orbR };
const preview = { pts: [], n: 0, blocked: false, hazard: false };
function predict(x, y, vx, vy, maxBounce) {
  probe.x = x; probe.y = y; probe.vx = vx; probe.vy = vy;
  preview.n = 0; preview.blocked = false; preview.hazard = false;
  let bounces = 0, travelled = 0, sinceDot = 1e9;
  // the guide is a fixed *length* of path, not a fixed time: a gentle nudge is
  // previewed almost to its resting point, a full-power shot only gets the
  // opening stretch, so strong shots stay a matter of skill
  const steps = 88, maxDist = 340;
  for (let i = 0; i < steps; i++) {
    const ox = probe.x, oy = probe.y;
    const r = stepBody(probe, true);
    if (r.wall) bounces++;
    applyDamping(probe);
    const moved = Math.hypot(probe.x - ox, probe.y - oy);
    travelled += moved; sinceDot += moved;
    if (sinceDot >= 21) {                 // evenly spaced dots, whatever the speed
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
  totalShots: 0,
  runTime: 0,
  idle: 0,
  aiming: false,
  anchorX: 0, anchorY: 0,
  power: 0,
  pullX: 0, pullY: 0,
  transDir: 0, transT: 0, transDur: 0.42, transNext: null,
  fadeIn: 0,
  deny: 0,                // "not yet" feedback when grabbing a moving orb
};

const orb = {
  x: 0, y: 0, vx: 0, vy: 0, r: CFG.orbR,
  color: 'violet', prevColor: 'violet', colorMix: 1,
  squash: 0, squashAng: 0, pulse: 0, flash: 0,
  alive: true, scale: 1,
  trail: [], trailN: 0,
};
const TRAIL_N = 26;
for (let i = 0; i < TRAIL_N; i++) orb.trail.push({ x: 0, y: 0, v: 0 });

const cam = { shake: 0, sx: 0, sy: 0, zoom: 1, zoomT: 1, flash: 0, flashCol: [255, 255, 255] };

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
};
const ctx = dom.canvas.getContext('2d');

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function showBanner(i) {
  const L = LEVELS[i];
  dom.bannerNum.textContent = pad2(i + 1);
  dom.bannerName.textContent = L.name;
  dom.banner.classList.remove('show');
  void dom.banner.offsetWidth;
  dom.banner.classList.add('show');
}
function showToast(msg) {
  dom.toast.textContent = msg;
  dom.toast.classList.remove('hidden', 'show');
  void dom.toast.offsetWidth;
  dom.toast.classList.add('show');
}
function setHint(text) {
  if (text) { dom.hint.textContent = text; dom.hint.classList.remove('hidden'); }
  else dom.hint.classList.add('hidden');
}

function resetOrb() {
  const s = G.level.start;
  orb.x = s.x; orb.y = s.y; orb.vx = 0; orb.vy = 0;
  orb.color = G.level.color || 'violet';
  orb.prevColor = orb.color; orb.colorMix = 1;
  orb.squash = 0; orb.flash = 0; orb.alive = true; orb.scale = 1;
  for (let i = 0; i < TRAIL_N; i++) { orb.trail[i].x = orb.x; orb.trail[i].y = orb.y; orb.trail[i].v = 0; }
  orb.trailN = 0;
}

function startLevel(i) {
  G.levelIndex = i;
  G.level = buildWorld(LEVELS[i]);
  G.shots = 0;
  G.t = 0;
  G.phase = 'play'; G.phaseT = 0;
  G.aiming = false; G.idle = 0;
  G.fadeIn = 0.5;
  clearFX();
  resetOrb();
  bakeStatic();
  dom.levelNum.textContent = pad2(i + 1);
  dom.levelName.textContent = LEVELS[i].name;
  dom.progress.style.width = ((i + 1) / LEVELS.length * 100) + '%';
  dom.shotCount.textContent = '0';
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
  dom.endCard.classList.add('hidden');
  G.totalShots = 0; G.runTime = 0;
  startLevel(0);
}

function restartLevel(silent) {
  if (G.phase === 'done' || G.transDir !== 0) return;
  if (!silent) Sfx.ui();
  const i = G.levelIndex;
  G.level = buildWorld(LEVELS[i]);
  G.shots = 0;
  G.phase = 'play'; G.phaseT = 0; G.aiming = false;
  G.fadeIn = 0.35;
  clearFX();
  resetOrb();
  bakeStatic();
  dom.shotCount.textContent = '0';
  Sfx.tensionStop();
}

function canGrab() {
  return G.phase === 'play' && G.transDir === 0 && orb.alive &&
         Math.hypot(orb.vx, orb.vy) < CFG.readySpeed;
}

function launch(ang, power) {
  const sp = lerp(CFG.minLaunch, CFG.maxLaunch, power);
  orb.vx = Math.cos(ang) * sp;
  orb.vy = Math.sin(ang) * sp;
  orb.squash = 0.55; orb.squashAng = ang;
  orb.flash = 1;
  G.shots++; G.totalShots++;
  dom.shotCount.textContent = G.shots;
  dom.shots.classList.remove('bump'); void dom.shots.offsetWidth; dom.shots.classList.add('bump');
  const c = energy(orb.color);
  FX.spark(orb.x - Math.cos(ang) * 12, orb.y - Math.sin(ang) * 12, ang + Math.PI, 0.5, 4 + power * 4, 12, c.rgb,
           { life: 0.4, size: 2.6, shape: 1, len: 12, drag: 0.9 });
  FX.spark(orb.x, orb.y, ang, 0.9, 2.2, 6, c.hi, { life: 0.3, size: 2 });
  FX.shock(orb.x, orb.y, orb.r, orb.r + 34 + power * 26, 0.34, c.rgb, 3);
  cam.shake = Math.max(cam.shake, 2 + power * 4);
  cam.flash = Math.max(cam.flash, 0.1 + power * 0.14); cam.flashCol = c.hi;
  Sfx.launch(power);
  setHint('');
}

function killOrb() {
  if (!orb.alive) return;
  orb.alive = false;
  G.phase = 'fail'; G.phaseT = 0;
  const c = energy(orb.color);
  FX.spark(orb.x, orb.y, 0, Math.PI, 7, 26, DANGER, { life: 0.65, size: 3, drag: 0.94, shape: 1, len: 9 });
  FX.spark(orb.x, orb.y, 0, Math.PI, 4, 14, c.rgb, { life: 0.5, size: 2.4, drag: 0.93 });
  FX.shock(orb.x, orb.y, 4, 90, 0.45, DANGER, 4);
  cam.shake = 14; cam.flash = 0.5; cam.flashCol = DANGER;
  Sfx.fail();
  Sfx.tensionStop();
}

function winLevel() {
  G.phase = 'win'; G.phaseT = 0;
  const p = world.portal;
  const c = energy(p.color || orb.color);
  FX.implode(p.x, p.y, 96, 26, c.hi, 0.5);
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
        orb.x = sx; orb.y = sy; killOrb(); return;
      }
    }
    for (let k = 0; k < world.gates.length; k++) {
      const g = world.gates[k];
      if (g.color !== orb.color && overlapsBox(sx, sy, orb.r * 0.7, g)) {
        orb.prevColor = orb.color; orb.color = g.color; orb.colorMix = 0;
        orb.flash = 1; g.flash = 1;
        const c = energy(g.color);
        FX.spark(sx, sy, 0, Math.PI, 4.2, 18, c.rgb, { life: 0.55, size: 2.6, drag: 0.92 });
        FX.spark(sx, sy, 0, Math.PI, 2, 8, c.hi, { life: 0.4, size: 2 });
        FX.shock(sx, sy, 6, 74, 0.45, c.rgb, 3);
        cam.flash = Math.max(cam.flash, 0.22); cam.flashCol = c.hi;
        cam.shake = Math.max(cam.shake, 3);
        Sfx.gate();
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
        FX.spark(sx, sy, Math.atan2(ny, nx), 1.1, 3, 10, energy(p.color).rgb, { life: 0.4, size: 2.2 });
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
  G.t += STEP;
  if (G.phase !== 'done') G.runTime += STEP;
  G.phaseT += STEP;

  updateMotion(G.t);
  for (const h of world.hazards) h.k = hazardLevel(h, G.t);
  for (const b of world.bumpers) if (b.hit > 0) b.hit = Math.max(0, b.hit - STEP * 3.2);
  for (const g of world.gates) if (g.flash > 0) g.flash = Math.max(0, g.flash - STEP * 2.4);
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
  cam.flash *= 0.88;
  if (G.fadeIn > 0) G.fadeIn = Math.max(0, G.fadeIn - STEP);

  if (G.deny > 0) G.deny = Math.max(0, G.deny - STEP * 2.4);
  if (orb.colorMix < 1) orb.colorMix = Math.min(1, orb.colorMix + STEP * 5);
  if (orb.flash > 0) orb.flash = Math.max(0, orb.flash - STEP * 3.4);
  if (orb.squash > 0) orb.squash = Math.max(0, orb.squash - STEP * 3.6);
  orb.pulse += STEP;

  if (G.phase === 'play' && orb.alive) {
    const px = orb.x, py = orb.y;
    if (!G.aiming) {
      const r = stepBody(orb, true);
      applyDamping(orb);
      if (r.bumper) {
        const b = r.bumper; b.hit = 1;
        const c = energy(orb.color);
        FX.shock(b.x, b.y, b.r * 0.7, b.r + 78, 0.5, [120, 210, 255], 4);
        FX.shock(b.x, b.y, b.r * 0.5, b.r + 40, 0.3, c.hi, 2);
        FX.spark(RES.hx, RES.hy, Math.atan2(RES.ny, RES.nx), 1.0, 5, 14, [150, 220, 255],
                 { life: 0.5, size: 2.6, shape: 1, len: 10 });
        orb.squash = 0.7; orb.squashAng = Math.atan2(orb.vy, orb.vx); orb.flash = 0.9;
        cam.shake = Math.max(cam.shake, 8); cam.flash = Math.max(cam.flash, 0.26);
        cam.flashCol = [160, 220, 255];
        Sfx.bumper();
      } else if (r.wall && r.impact > 1.2) {
        const s = clamp(r.impact / 14, 0, 1);
        const c = energy(orb.color);
        FX.spark(RES.hx, RES.hy, Math.atan2(RES.ny, RES.nx), 1.0, 1.4 + s * 4, 4 + (s * 8 | 0), c.rgb,
                 { life: 0.32, size: 1.9, shape: 1, len: 7, drag: 0.9 });
        if (s > 0.28) FX.shock(RES.hx, RES.hy, 2, 16 + s * 40, 0.3, c.rgb, 2);
        orb.squash = Math.min(0.6, 0.18 + s * 0.5);
        orb.squashAng = Math.atan2(RES.ny, RES.nx) + Math.PI / 2;
        if (s > 0.4) { cam.shake = Math.max(cam.shake, s * 6); }
        Sfx.bounce(r.impact);
      }
      checkTriggers(px, py);
    }
    // trail sampling
    if (orb.alive) {
      const sp = Math.hypot(orb.vx, orb.vy);
      const tp = orb.trail[orb.trailN % TRAIL_N];
      tp.x = orb.x; tp.y = orb.y; tp.v = sp;
      orb.trailN++;
      if (canGrab() && !G.aiming) G.idle += STEP; else G.idle = 0;
    }
  } else if (G.phase === 'fail') {
    if (G.phaseT > 0.55) {
      G.phase = 'play'; G.phaseT = 0; G.fadeIn = 0.3;
      resetOrb();
      for (const g of world.gates) g.flash = 0;
    }
  } else if (G.phase === 'win') {
    const p2 = world.portal;
    p2.open = Math.min(1, p2.open + STEP * 3);
    const k = clamp(G.phaseT / 0.42, 0, 1);
    orb.x = lerp(orb.x, p2.x, 0.22);
    orb.y = lerp(orb.y, p2.y, 0.22);
    orb.scale = Math.max(0, 1 - easeIn(k));
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

function fit() {
  const rect = dom.canvas.getBoundingClientRect();
  // capped at 2x: beyond that the fill-rate cost of the additive glows
  // outweighs the sharpness gain on phone-sized screens
  const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
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
  const lights = [
    [VW * 0.16, VH * 0.22, 330, 0.16],
    [VW * 0.88, VH * 0.58, 300, 0.13],
    [VW * 0.45, VH * 0.95, 360, 0.11],
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

  for (const w2 of world.statics) drawWall(c, w2);
}

function drawWall(c, e) {
  const w = e.w, h = e.h;
  c.save();
  c.translate(e.x, e.y); c.rotate(e.a);
  const r = Math.min(9, Math.min(w, h) / 2);

  // outer glow
  c.shadowColor = 'rgba(120,150,255,0.5)';
  c.shadowBlur = 16;
  roundRect(c, -w / 2, -h / 2, w, h, r);
  c.fillStyle = '#0d1230';
  c.fill();
  c.shadowBlur = 0;

  // body
  const g = c.createLinearGradient(0, -h / 2, 0, h / 2);
  g.addColorStop(0, '#222a58');
  g.addColorStop(0.42, '#141a3c');
  g.addColorStop(1, '#0a0e26');
  roundRect(c, -w / 2, -h / 2, w, h, r);
  c.fillStyle = g; c.fill();

  c.strokeStyle = 'rgba(140,175,255,0.30)';
  c.lineWidth = 1.3;
  c.stroke();

  // neon top edge + inner detail
  c.globalCompositeOperation = 'lighter';
  const long = w >= h;
  const eg = long
    ? c.createLinearGradient(-w / 2, 0, w / 2, 0)
    : c.createLinearGradient(0, -h / 2, 0, h / 2);
  eg.addColorStop(0, 'rgba(120,160,255,0)');
  eg.addColorStop(0.5, 'rgba(150,190,255,0.55)');
  eg.addColorStop(1, 'rgba(120,160,255,0)');
  c.fillStyle = eg;
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

function drawBumper(c, b) {
  const squeeze = 1 - b.hit * 0.16;
  const t = G.t;
  c.save();
  c.translate(b.x, b.y);
  c.scale(squeeze, squeeze);
  const col = [120, 210, 255];

  c.globalCompositeOperation = 'lighter';
  const halo = c.createRadialGradient(0, 0, b.r * 0.2, 0, 0, b.r * 2.1);
  halo.addColorStop(0, rgba(col, 0.32 + b.hit * 0.4));
  halo.addColorStop(0.45, rgba(col, 0.12));
  halo.addColorStop(1, rgba(col, 0));
  c.fillStyle = halo;
  c.beginPath(); c.arc(0, 0, b.r * 2.1, 0, TAU); c.fill();
  c.globalCompositeOperation = 'source-over';

  // body
  const bg = c.createRadialGradient(-b.r * 0.25, -b.r * 0.3, b.r * 0.1, 0, 0, b.r);
  bg.addColorStop(0, 'rgba(40,80,140,0.95)');
  bg.addColorStop(0.7, 'rgba(14,26,62,0.95)');
  bg.addColorStop(1, 'rgba(8,14,40,0.98)');
  c.fillStyle = bg;
  c.beginPath(); c.arc(0, 0, b.r, 0, TAU); c.fill();

  // pulsing inner core
  const pu = 0.5 + 0.5 * Math.sin(t * 3 + b.seed);
  c.globalCompositeOperation = 'lighter';
  const cg = c.createRadialGradient(0, 0, 0, 0, 0, b.r * 0.72);
  cg.addColorStop(0, rgba([230, 250, 255], 0.5 + pu * 0.25 + b.hit * 0.3));
  cg.addColorStop(0.5, rgba(col, 0.28 + pu * 0.14));
  cg.addColorStop(1, rgba(col, 0));
  c.fillStyle = cg;
  c.beginPath(); c.arc(0, 0, b.r * 0.72, 0, TAU); c.fill();

  // rings
  c.strokeStyle = rgba(col, 0.85);
  c.lineWidth = 2.4;
  c.beginPath(); c.arc(0, 0, b.r - 1.5, 0, TAU); c.stroke();
  c.strokeStyle = rgba([255, 255, 255], 0.2 + pu * 0.2);
  c.lineWidth = 1;
  c.beginPath(); c.arc(0, 0, b.r * 0.82, 0, TAU); c.stroke();

  // chevrons
  const rot = t * 1.1 + b.seed;
  c.strokeStyle = rgba([210, 245, 255], 0.55 + b.hit * 0.4);
  c.lineWidth = 2.2;
  c.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const a = rot + i * TAU / 3;
    c.beginPath();
    c.arc(0, 0, b.r * 0.55, a, a + 0.5);
    c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

function drawHazard(c, h) {
  const k = h.k;
  const w = h.w, ht = h.h;
  c.save();
  c.translate(h.x, h.y); c.rotate(h.a);
  const long = w >= ht;
  const L = long ? w : ht;

  // emitter caps
  c.globalCompositeOperation = 'lighter';
  for (const s of [-1, 1]) {
    const ex = long ? s * w / 2 : 0;
    const ey = long ? 0 : s * ht / 2;
    const cg = c.createRadialGradient(ex, ey, 0, ex, ey, 13);
    cg.addColorStop(0, rgba([255, 220, 235], 0.7));
    cg.addColorStop(0.4, rgba(DANGER, 0.5 + k * 0.4));
    cg.addColorStop(1, rgba(DANGER, 0));
    c.fillStyle = cg;
    c.beginPath(); c.arc(ex, ey, 13, 0, TAU); c.fill();
  }
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = '#1a0a1e';
  for (const s of [-1, 1]) {
    const ex = long ? s * w / 2 : 0;
    const ey = long ? 0 : s * ht / 2;
    c.beginPath(); c.arc(ex, ey, 6.5, 0, TAU); c.fill();
    c.strokeStyle = rgba(DANGER, 0.85); c.lineWidth = 1.6; c.stroke();
  }

  // idle rail — the danger line stays readable even while the beam is down
  c.save();
  c.setLineDash([5, 7]);
  c.lineDashOffset = -G.t * 26;
  c.strokeStyle = rgba(DANGER, 0.2 + k * 0.5);
  c.lineWidth = 1.3;
  c.beginPath();
  if (long) { c.moveTo(-w / 2 + 7, 0); c.lineTo(w / 2 - 7, 0); }
  else { c.moveTo(0, -ht / 2 + 7); c.lineTo(0, ht / 2 - 7); }
  c.stroke();
  c.restore();

  if (k <= 0.01) { c.restore(); return; }

  c.globalCompositeOperation = 'lighter';
  const th = (long ? ht : w) * (0.35 + k * 0.65);
  const bw = long ? w : th, bh = long ? th : ht;

  // bloom
  const bg = long
    ? c.createLinearGradient(0, -th * 2.2, 0, th * 2.2)
    : c.createLinearGradient(-th * 2.2, 0, th * 2.2, 0);
  bg.addColorStop(0, rgba(DANGER, 0));
  bg.addColorStop(0.5, rgba(DANGER, 0.34 * k));
  bg.addColorStop(1, rgba(DANGER, 0));
  c.fillStyle = bg;
  if (long) c.fillRect(-w / 2, -th * 2.2, w, th * 4.4);
  else c.fillRect(-th * 2.2, -ht / 2, th * 4.4, ht);

  // beam body
  c.fillStyle = rgba([255, 110, 160], 0.5 * k);
  c.fillRect(-bw / 2, -bh / 2, bw, bh);
  // hot core
  const core = Math.max(1.2, (long ? bh : bw) * 0.32);
  c.fillStyle = rgba([255, 240, 245], 0.85 * k);
  if (long) c.fillRect(-w / 2, -core / 2, w, core);
  else c.fillRect(-core / 2, -ht / 2, core, ht);

  // crackle
  if (k > 0.6) {
    c.strokeStyle = rgba([255, 200, 220], 0.5);
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

function drawGate(c, g) {
  const col = energy(g.color);
  const w = g.w, h = g.h;
  const long = w >= h;
  const L = long ? w : h;
  c.save();
  c.translate(g.x, g.y); c.rotate(g.a);

  // frame posts
  c.globalCompositeOperation = 'lighter';
  for (const s of [-1, 1]) {
    const ex = long ? s * w / 2 : 0;
    const ey = long ? 0 : s * h / 2;
    const rg = c.createRadialGradient(ex, ey, 0, ex, ey, 18);
    rg.addColorStop(0, rgba(col.hi, 0.55 + g.flash * 0.4));
    rg.addColorStop(0.35, rgba(col.rgb, 0.4));
    rg.addColorStop(1, rgba(col.rgb, 0));
    c.fillStyle = rg;
    c.beginPath(); c.arc(ex, ey, 18, 0, TAU); c.fill();
  }

  // membrane
  const th = long ? h : w;
  const mg = long
    ? c.createLinearGradient(0, -th / 2, 0, th / 2)
    : c.createLinearGradient(-th / 2, 0, th / 2, 0);
  mg.addColorStop(0, rgba(col.rgb, 0.05));
  mg.addColorStop(0.5, rgba(col.rgb, 0.30 + g.flash * 0.3));
  mg.addColorStop(1, rgba(col.rgb, 0.05));
  c.fillStyle = mg;
  c.fillRect(-w / 2, -h / 2, w, h);

  // travelling shimmer
  c.save();
  c.beginPath(); c.rect(-w / 2, -h / 2, w, h); c.clip();
  c.strokeStyle = rgba(col.hi, 0.3);
  c.lineWidth = 2;
  const off = (G.t * 42 + g.seed * 20) % 26;
  c.beginPath();
  for (let i = -L; i < L; i += 26) {
    if (long) { c.moveTo(-w / 2 + i + off, h / 2); c.lineTo(-w / 2 + i + off + 10, -h / 2); }
    else { c.moveTo(w / 2, -h / 2 + i + off); c.lineTo(-w / 2, -h / 2 + i + off + 10); }
  }
  c.stroke();
  c.restore();

  // bright rails
  c.fillStyle = rgba(col.hi, 0.75);
  if (long) {
    c.fillRect(-w / 2, -h / 2, w, 1.5);
    c.fillRect(-w / 2, h / 2 - 1.5, w, 1.5);
  } else {
    c.fillRect(-w / 2, -h / 2, 1.5, h);
    c.fillRect(w / 2 - 1.5, -h / 2, 1.5, h);
  }

  // drifting motes
  for (let i = 0; i < 4; i++) {
    const u = ((G.t * 0.28 + i * 0.25 + g.seed) % 1);
    const p = -L / 2 + u * L;
    const q = Math.sin(G.t * 2 + i * 2 + g.seed) * (long ? h : w) * 0.22;
    c.fillStyle = rgba(col.hi, 0.6 * Math.sin(u * Math.PI));
    c.beginPath();
    if (long) c.arc(p, q, 1.8, 0, TAU); else c.arc(q, p, 1.8, 0, TAU);
    c.fill();
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
  // outer bloom
  const bg = c.createRadialGradient(0, 0, p.r * 0.3, 0, 0, p.r * 2.6);
  bg.addColorStop(0, rgba(col.rgb, 0.3 + pulse * 0.1 + open * 0.4));
  bg.addColorStop(0.4, rgba(col.rgb, 0.12));
  bg.addColorStop(1, rgba(col.rgb, 0));
  c.fillStyle = bg;
  c.beginPath(); c.arc(0, 0, p.r * 2.6, 0, TAU); c.fill();

  // event horizon — dark well first, so the energy reads on top of it
  c.globalCompositeOperation = 'source-over';
  const eg = c.createRadialGradient(0, 0, 0, 0, 0, p.r * 0.82);
  eg.addColorStop(0, 'rgba(4,5,18,0.85)');
  eg.addColorStop(0.55, 'rgba(5,7,24,0.78)');
  eg.addColorStop(1, 'rgba(6,8,26,0)');
  c.fillStyle = eg;
  c.beginPath(); c.arc(0, 0, p.r * 0.82, 0, TAU); c.fill();
  c.globalCompositeOperation = 'lighter';

  // swirl core
  const cg = c.createRadialGradient(0, 0, 0, 0, 0, p.r * 0.95);
  cg.addColorStop(0, rgba([255, 255, 255], 0.85 + open * 0.15));
  cg.addColorStop(0.12, rgba(col.hi, 0.7 + pulse * 0.12));
  cg.addColorStop(0.3, rgba(col.rgb, 0.3));
  cg.addColorStop(0.58, rgba(col.rgb, 0.42 + pulse * 0.16));
  cg.addColorStop(0.84, rgba(col.rgb, 0.18));
  cg.addColorStop(1, rgba(col.rgb, 0));
  c.fillStyle = cg;
  c.beginPath(); c.arc(0, 0, p.r * 0.95, 0, TAU); c.fill();

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

function orbColors() {
  const a = energy(orb.prevColor), b = energy(orb.color);
  const m = orb.colorMix;
  return {
    rgb: [lerp(a.rgb[0], b.rgb[0], m) | 0, lerp(a.rgb[1], b.rgb[1], m) | 0, lerp(a.rgb[2], b.rgb[2], m) | 0],
    hi: [lerp(a.hi[0], b.hi[0], m) | 0, lerp(a.hi[1], b.hi[1], m) | 0, lerp(a.hi[2], b.hi[2], m) | 0],
  };
}

function drawTrail(c, col) {
  const n = Math.min(orb.trailN, TRAIL_N);
  if (n < 3) return;
  c.globalCompositeOperation = 'lighter';
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (let pass = 0; pass < 2; pass++) {
    c.beginPath();
    let started = false;
    for (let i = 1; i < n; i++) {
      const idx = (orb.trailN - n + i + TRAIL_N * 4) % TRAIL_N;
      const p = orb.trail[idx];
      if (!started) { c.moveTo(p.x, p.y); started = true; }
      else c.lineTo(p.x, p.y);
    }
    const head = orb.trail[(orb.trailN - 1 + TRAIL_N * 4) % TRAIL_N];
    const tail = orb.trail[(orb.trailN - n + TRAIL_N * 4) % TRAIL_N];
    const g = c.createLinearGradient(tail.x, tail.y, head.x, head.y);
    const speed = clamp(Math.hypot(orb.vx, orb.vy) / 12, 0, 1);
    g.addColorStop(0, rgba(col.rgb, 0));
    g.addColorStop(1, rgba(pass ? col.hi : col.rgb, (pass ? 0.4 : 0.26) * (0.25 + speed * 0.75)));
    c.strokeStyle = g;
    c.lineWidth = pass ? orb.r * 0.5 : orb.r * 1.5;
    c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
}

function drawOrb(c) {
  if (!orb.alive || orb.scale <= 0.01) return;
  const col = orbColors();
  const sp = Math.hypot(orb.vx, orb.vy);
  const r = orb.r * orb.scale;

  drawTrail(c, col);

  // aiming visual offset: the orb leans into the stretch
  let ox = 0, oy = 0, stretch = 0, sang = 0;
  if (G.aiming && G.power > 0) {
    const a = Math.atan2(G.pullY, G.pullX);
    ox = Math.cos(a) * G.power * 11;
    oy = Math.sin(a) * G.power * 11;
    stretch = G.power * 0.26;
    sang = a;
  }
  let sq = orb.squash, sqA = orb.squashAng;
  if (sp > 2 && sq <= 0) { sq = Math.min(0.22, sp / 100); sqA = Math.atan2(orb.vy, orb.vx); }

  const idle = Math.sin(orb.pulse * 2.1) * (sp < 1 ? 1 : 0);
  const bob = idle * 1.6;
  const x = orb.x + ox, y = orb.y + oy + bob;

  c.save();
  c.translate(x, y);

  // outer bloom (unrotated)
  c.globalCompositeOperation = 'lighter';
  const bloomR = r * (3.2 + orb.flash * 1.6 + G.power * 0.9);
  const bg = c.createRadialGradient(0, 0, r * 0.4, 0, 0, bloomR);
  bg.addColorStop(0, rgba(col.rgb, 0.46 + orb.flash * 0.3 + G.power * 0.16));
  bg.addColorStop(0.35, rgba(col.rgb, 0.14));
  bg.addColorStop(1, rgba(col.rgb, 0));
  c.fillStyle = bg;
  c.beginPath(); c.arc(0, 0, bloomR, 0, TAU); c.fill();
  c.globalCompositeOperation = 'source-over';

  c.save();
  const ang = stretch > 0 ? sang : sqA;
  c.rotate(ang);
  const sx = 1 + stretch + sq * 0.42;
  const sy = 1 - stretch * 0.5 - sq * 0.34;
  c.scale(sx, sy);
  c.rotate(-ang);

  // glass shell
  const shell = c.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
  shell.addColorStop(0, rgba(col.hi, 0.95));
  shell.addColorStop(0.35, rgba(col.rgb, 0.8));
  shell.addColorStop(0.78, rgba(col.rgb, 0.42));
  shell.addColorStop(1, rgba(col.rgb, 0.16));
  c.fillStyle = shell;
  c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();

  // inner energy — two slow blobs clipped to the shell
  c.save();
  c.beginPath(); c.arc(0, 0, r * 0.94, 0, TAU); c.clip();
  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 2; i++) {
    const a = orb.pulse * (0.9 + i * 0.7) + i * 2.1;
    const bx = Math.cos(a) * r * 0.34, by = Math.sin(a * 1.3) * r * 0.34;
    const bgi = c.createRadialGradient(bx, by, 0, bx, by, r * 0.75);
    bgi.addColorStop(0, rgba(col.hi, 0.5));
    bgi.addColorStop(1, rgba(col.hi, 0));
    c.fillStyle = bgi;
    c.beginPath(); c.arc(bx, by, r * 0.75, 0, TAU); c.fill();
  }
  c.restore();

  // bright core
  const corePulse = 1 + Math.sin(orb.pulse * 3.4) * 0.07 + orb.flash * 0.35 + G.power * 0.2;
  const cg = c.createRadialGradient(-r * 0.1, -r * 0.12, 0, 0, 0, r * 0.62 * corePulse);
  cg.addColorStop(0, 'rgba(255,255,255,1)');
  cg.addColorStop(0.35, rgba(col.hi, 0.9));
  cg.addColorStop(1, rgba(col.rgb, 0));
  c.globalCompositeOperation = 'lighter';
  c.fillStyle = cg;
  c.beginPath(); c.arc(0, 0, r * 0.62 * corePulse, 0, TAU); c.fill();
  c.globalCompositeOperation = 'source-over';

  // rim light
  c.strokeStyle = rgba(col.hi, 0.75);
  c.lineWidth = 1.2;
  c.beginPath(); c.arc(0, 0, r - 0.8, 0, TAU); c.stroke();
  // specular
  c.fillStyle = 'rgba(255,255,255,0.55)';
  c.beginPath(); c.ellipse(-r * 0.34, -r * 0.4, r * 0.2, r * 0.13, -0.6, 0, TAU); c.fill();
  c.restore();

  // orbiting sparkles
  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    const a = orb.pulse * (1.1 + i * 0.35) + i * 2.2;
    const rr = r * (1.35 + 0.18 * Math.sin(orb.pulse * 2 + i));
    c.fillStyle = rgba(col.hi, 0.55 + 0.3 * Math.sin(orb.pulse * 3 + i));
    c.beginPath(); c.arc(Math.cos(a) * rr, Math.sin(a) * rr, 1.5, 0, TAU); c.fill();
  }
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

function drawAim(c) {
  if (!G.aiming || G.power <= 0.02) return;
  const col = orbColors();
  const a = Math.atan2(-G.pullY, -G.pullX);   // launch direction
  const p = G.power;

  // predicted path
  const maxB = G.levelIndex === 0 ? 0 : (G.levelIndex < 3 ? 1 : 2);
  const sp = lerp(CFG.minLaunch, CFG.maxLaunch, p);
  const pv = predict(orb.x, orb.y, Math.cos(a) * sp, Math.sin(a) * sp, maxB);

  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < pv.n; i++) {
    const u = i / Math.max(1, pv.n - 1);
    const q = pv.pts[i];
    const fade = 1 - u * u * 0.85;
    const rr = lerp(4.4, 1.6, u);
    c.fillStyle = rgba(i < 2 ? col.hi : col.rgb, 0.2 + fade * 0.62);
    c.beginPath(); c.arc(q.x, q.y, rr, 0, TAU); c.fill();
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

function drawReadyHint(c) {
  if (G.phase !== 'play' || !orb.alive || G.aiming) return;
  if (G.idle < 1.1) return;
  const col = orbColors();
  const t = (G.t * 0.9) % 1;
  const a = (1 - t) * 0.5 * clamp((G.idle - 1.1) / 0.6, 0, 1);
  c.globalCompositeOperation = 'lighter';
  c.strokeStyle = rgba(col.hi, a);
  c.lineWidth = 2;
  c.beginPath(); c.arc(orb.x, orb.y, orb.r + 8 + t * 34, 0, TAU); c.stroke();
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
  for (const d of DUST) {
    const a = (0.1 + 0.16 * d.z) * (0.6 + 0.4 * Math.sin(d.t));
    c.fillStyle = rgba([190, 215, 255], a);
    c.beginPath(); c.arc(d.x, d.y, d.s * d.z, 0, TAU); c.fill();
  }
  c.globalCompositeOperation = 'source-over';
}

function drawAmbient(c) {
  const acc = world.accent;
  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 2; i++) {
    const t = G.t * (0.06 + i * 0.03) + i * 3;
    const x = VW * (0.5 + 0.34 * Math.sin(t));
    const y = VH * (0.42 + 0.3 * Math.cos(t * 0.8 + i));
    const r = 250 + i * 70;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(acc, 0.07));
    g.addColorStop(1, rgba(acc, 0));
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
  }
  c.globalCompositeOperation = 'source-over';
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
  c.clearRect(0, 0, VW, VH);

  c.save();
  // camera
  const z = cam.zoom;
  c.translate(VW / 2 + cam.sx, VH / 2 + cam.sy);
  c.scale(z, z);
  c.translate(-VW / 2, -VH / 2);

  c.drawImage(bakeCv, 0, 0, VW, VH);
  drawAmbient(c);
  drawDust(c);

  for (const g of world.gates) drawGate(c, g);
  for (const h of world.hazards) drawHazard(c, h);
  for (const b of world.bumpers) drawBumper(c, b);
  for (const m of world.movers) if (m.kind === 'wall') drawWall(c, m);
  drawPortal(c, world.portal);

  drawReadyHint(c);
  drawDeny(c);
  drawAim(c);
  drawOrb(c);
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

function toGame(e) {
  const r = dom.canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (VW / r.width),
    y: (e.clientY - r.top) * (VH / r.height),
  };
}

let pointerId = null;

function updateDrag(px, py) {
  let dx = G.anchorX - px, dy = G.anchorY - py;
  const d = Math.hypot(dx, dy);
  const cl = Math.min(d, CFG.maxDrag);
  if (d > 0.001) { dx = dx / d * cl; dy = dy / d * cl; }
  G.pullX = -dx; G.pullY = -dy;          // where the finger pulled to (relative to orb)
  G.power = d < CFG.minDrag ? 0 : clamp((cl - CFG.minDrag) / (CFG.maxDrag - CFG.minDrag), 0, 1);
  Sfx.tensionUpdate(G.power);
}

function onDown(e) {
  Sfx.unlock();
  if (G.phase === 'done') return;
  if (e.target === dom.restart || dom.restart.contains(e.target)) return;
  if (!canGrab()) {
    // the orb is still in flight — acknowledge the tap instead of eating it
    if (G.phase === 'play' && orb.alive) G.deny = 1;
    return;
  }
  const p = toGame(e);
  const near = Math.hypot(p.x - orb.x, p.y - orb.y) < CFG.grabRadius;
  G.anchorX = near ? orb.x : p.x;
  G.anchorY = near ? orb.y : p.y;
  G.aiming = true;
  pointerId = e.pointerId;
  dom.canvas.setPointerCapture && dom.canvas.setPointerCapture(e.pointerId);
  Sfx.tensionStart();
  updateDrag(p.x, p.y);
  setHint('');
  e.preventDefault();
}

function onMove(e) {
  if (!G.aiming || (pointerId !== null && e.pointerId !== pointerId)) return;
  const p = toGame(e);
  updateDrag(p.x, p.y);
  e.preventDefault();
}

function onUp(e) {
  if (!G.aiming || (pointerId !== null && e.pointerId !== pointerId)) return;
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
window.addEventListener('pointercancel', onUp, { passive: false });
window.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
window.addEventListener('touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });

dom.restart.addEventListener('click', (e) => { e.stopPropagation(); Sfx.unlock(); restartLevel(); });
dom.endRestart.addEventListener('click', () => { Sfx.unlock(); Sfx.ui(); restartRun(); });

let muted = false;
window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') restartLevel();
  if (e.key === 'm' || e.key === 'M') { muted = !muted; Sfx.setMuted(muted); }
});

window.addEventListener('resize', fit);
window.addEventListener('orientationchange', () => setTimeout(fit, 120));
if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);

/* ============================================================
   10. MAIN LOOP
   ============================================================ */

let last = 0, acc = 0, frameCount = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (!last) last = now;
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  acc += dt;
  let guard = 0;
  while (acc >= STEP && guard < 6) { simStep(); acc -= STEP; guard++; }
  if (guard >= 6) acc = 0;
  if ((frameCount++ & 15) === 0) fit();   // cheap guard against missed resizes
  render();
}

startLevel(0);
fit();
requestAnimationFrame(frame);

/* ---- small debug surface (handy for tuning / automated checks) ---- */
window.FLUX = {
  G, orb, world, LEVELS, CFG,
  go: (i) => startLevel(clamp(i | 0, 0, LEVELS.length - 1)),
  shoot: (ang, power) => { if (canGrab()) launch(ang, clamp(power, 0, 1)); },
  tick: (n) => { for (let i = 0; i < n; i++) simStep(); },
  mute: (v) => { muted = !!v; Sfx.setMuted(muted); },
  ready: () => canGrab(),
};

})();
