/* ============================================================
   A movement-first spirit traversal game.  (The name it ships
   under is GAME.title, in section 1 — see the note there.)
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

/* ---- identity ------------------------------------------------------------
   The name of the game lives HERE and nowhere else. The page title, the title
   mark, the end screen, the accessible label and the page metadata are all
   written from it at boot, so renaming the game is a one-line change that
   cannot leave a stale name behind in a corner of the markup.

   `storageKey` is deliberately NOT derived from the title: saved progress must
   survive a rename, so the key the player's browser already holds has to stay
   what it is. Change it only to intentionally discard everyone's progress. */
const GAME = {
  title:      'LUMA',
  lang:       'tr',
  storageKey: 'flux',
};

/* ---- player-facing text --------------------------------------------------
   Every word the player reads, in one table. Level names and tutorial tips
   live with their levels, because they are level content; everything that
   belongs to the shell is here.

   The tone is short and plain. A first-time player should be able to read a
   hint in one glance and get back to the game — the mechanics are taught by
   the level, and the sentence is only there to name what they are seeing. */
const TEXT = {
  /* shell */
  tagline:      'Işığın yolunu bul.',
  controls:     'Basılı tut · geriye çek · bırak · R yeniden başlatır',
  description:  GAME.title + ' — küçük bir ruhu neon harabelerde yönlendir: ' +
                'geriye çek ve bırak, duvarlara tutun, ışık kürelerini kullan.',
  canvasLabel:  'oyun alanı',

  /* HUD */
  hudLevel:     'BÖLÜM',
  sound:        'Sesi aç veya kapat',
  restart:      'Bölümü yeniden başlat',

  /* status */
  resume:       'KALDIĞIN BÖLÜMDEN DEVAM',

  /* completion */
  endSub:       'YOLCULUK TAMAMLANDI',
  endTime:      'süre',
  endLevels:    'bölüm',
  replay:       'BAŞTAN OYNA',
};

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
     These five numbers are one design, not five knobs.

     Horizontal reach goes as the square of the launch speed, so the speed
     range is chosen from the REACH range we want, not the other way round: a
     dead-minimum pull should still carry you `reachMin` of a full leap, and
     everything between should feel like a usable dial. With reachMin at 0.4
     the three pulls the player can actually feel come out at roughly 40% /
     70% / 100% of full reach.

     `dragFull` is in virtual screen units — 250 of the 540-wide virtual box,
     so a full stretch is a comfortable thumb-length swipe on any phone, and
     short pulls have enough travel to be controllable rather than snapping
     straight to maximum. */
  burstMax:     16.8,   // full-commitment leap
  reachMin:     0.34,   // a dead-minimum pull reaches this fraction of a full one
  burstTime:    0.075,  // gravity-free snap right after release
  dragFull:     250,    // stretch, in virtual screen units, for full power
  dragDead:     14,     // under this a release is a cancel, and nothing is spent

  /* --- ordinary surfaces: catch, do not bounce --------------------------- */
  floorDot:     0.55,   // contact normal more vertical than this is a floor
  landHard:     9.0,    // impact speed that reads as a heavy landing
  slideKeep:    0.62,   // slide kept when arriving fast
  groundDrag:   0.84,   // per step once settled on a floor
  groundStop:   0.30,   // below this the spirit is parked
  ceilingKeep:  0.55,   // glancing a ceiling costs some slide, nothing more
  wallSlide:    0.92,   // brushing a wall keeps nearly all the motion ALONG it:
                        // at 0.5 a graze on the way up a face cost half the
                        // leap, which is most of why hopping onto the ledge
                        // above a wall felt impossible
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

  /* --- ledge assist: the same idea, for going UP over a corner ---------- */
  ledgeBand:    70,     // how near the top edge the inward drift applies
  ledgeReach:   40,     // how far outside the surface it still applies
  ledgePull:    0.85,   // inward acceleration per step while clearing a corner
  ledgeMax:     7.0,    // the most inward speed it may ever add
  ledgeTime:    1.20,   // how long a launch stays armed for the corner

  /* --- wall cling ----------------------------------------------------------
     A wall is a safe place to stop and think, not a reaction test. Contact
     kills all speed, the grip holds with no slide at all for well over a
     second, and only then does it start to creep. */
  clingTime:    2.40,   // total hold before the wall lets go
  clingGrip:    1.50,   // seconds of full grip before the slide starts
  clingSlide:   2.0,    // downward slide speed once grip runs out
  clingKick:    0.30,   // outward push for a FLAT launch along a face
  clingKickMin: 1.20,   // ...and the bare separation a steeper one gets
  clingFree:    0.55,   // aim more upward than this is taken literally, even
                        // if it points into the wall: that is the player going
                        // over the top of what they are holding
  wallRegrab:   0.16,   // seconds a wall cannot re-catch you after you leave it
  wallRegrabDist: 40,   // ...or until you are this far from its face

  /* --- forgiveness -------------------------------------------------------- */
  coyote:       0.13,   // aim still works just after leaving a surface
  /* An early press is not a mistake, it is intent. A finger held down while
     the spirit is still in the air is answered the moment anything can answer
     it — the ground, a wall, or a node — so wanting to go again never costs a
     second press. It is generous because it only ever converts a press the
     player is still holding; a tap that is released is simply dropped. */
  buffer:       0.90,
  /* A guard against a stuck pointer, NOT a rule the player should ever meet.
     It used to be 2.6s, which is less time than it takes to look at a level
     and decide where to go: press, think, then drag, and the stretch had
     already been cancelled underneath you. Dragging did nothing, releasing did
     nothing, and there was no way to tell why — the game simply felt dead.
     Holding still is the player being deliberate, and the world is frozen
     while they do it, so there is nothing to protect against except an input
     the browser never told us about. */
  aimHold:      20.0,

  /* --- energy nodes -------------------------------------------------------- */
  nodeReach:    130,    // generous catch radius — this is a mobile target
  nodePull:     0.30,   // per frame the node draws the spirit toward itself
  nodeBurst:    17.4,   // release speed at full power
  nodeReachMin: 0.52,   // a node always throws, so its floor is higher
  nodeCool:     2.40,   // seconds before a spent node can be used again

  /* --- spirit springs ------------------------------------------------------
     A spring is the one object that hands out energy for free, so the rules
     that stop it handing out an INFINITE amount live here too.

     One physical contact must produce exactly one launch. The spring is locked
     to the body it just threw and stays dark until that body is clearly out of
     its activation region — `springExit` is what "clearly" means, and it is the
     main rule. `springCool` is only a second line of defence for the case where
     a body is flung out and back within a couple of frames, and `springClear`
     is the separation the launch itself leaves, so the very next substep cannot
     find the same overlap again. */
  springSpeed:  19.5,   // launch speed along the spring's face
  springKeep:   0.18,   // sideways motion kept through the throw
  springClear:  8,      // clearance left past the face on launch, in units
  springExit:   34,     // how far outside the trigger re-arms the spring
  springCool:   0.30,   // secondary guard: minimum seconds between two throws
  /* The failsafe, for geometry we did not foresee. Throws by the SAME spring
     that the player never got a say in are counted, and one too many cuts that
     spring out until control comes back — not for a number of seconds, which
     could never be right, because how long the spirit is in the air is decided
     by the throw itself. The count is cleared the moment the player can act
     again, so someone deliberately bouncing off a spring never trips it. */
  springLoopMax: 2,     // uninterrupted throws by one spring before the cutout

  /* --- camera ---------------------------------------------------------------
     The view leads rather than follows. While aiming it slides toward where
     the leap is pointed and eases out, so the destination is on screen before
     the player commits — the single biggest fairness problem in the game was
     asking for leaps toward places that could not be seen. */
  camLead:      360,    // how far a full-power stretch leads the view
  camLeadMin:   110,    // ...and how far the smallest one does
  camFollow:    7.5,    // view offset per unit of travel speed
  camEase:      0.10,   // travelling and settling
  camEaseAim:   0.13,   // while a stretch is held
  camEaseRest:  0.07,   // standing still: the slowest, so nothing twitches
  camSettle:    0.55,   // seconds of eased return after arriving
  camTravelSpeed: 2.0,  // above this the view treats the spirit as travelling
  zoomAim:      0.80,   // furthest the view pulls back for a full stretch
  zoomFast:     0.93,   // view scale at top travel speed
  zoomEase:     0.06,   // ONE smoothing rate for the zoom, applied in one place
  camHold:      0.66,   // the spirit never sits further out than this much of
                        // the half-view: it stays in frame, toward the rear

  /* --- limits & failure ----------------------------------------------------- */
  speedMax:     34,     // hard clamp, for stability only
  hurtTime:     0.30,   // seconds of the dissolve before respawn
  respawnTime:  0.22,   // seconds of the reform before control returns
};

/* ---- the feel of the stretch --------------------------------------------
   Two curves, doing two different jobs.

   `powerCurve` turns how far the elastic is stretched into how much power the
   player has asked for. It is a smoothstep, which is what gives the pull its
   resistance: the first part of the stretch moves power slowly, so small
   corrections are easy to place, the middle is where most of the range lives,
   and the last part flattens off so the maximum feels like a limit you lean
   into rather than an edge you fall over.

   `burstSpeed` turns that power into a launch speed. Reach goes as the square
   of speed, so taking the square root here is what makes the dial read as
   linear in distance — power 0.5 genuinely lands about halfway between the
   shortest and longest leap, instead of nearly at the far end. */
const smoothstep = (t) => t * t * (3 - 2 * t);
const powerCurve = smoothstep;
const burstSpeed = (p) =>
  MOVE.burstMax * Math.sqrt(MOVE.reachMin + (1 - MOVE.reachMin) * clamp(p, 0, 1));

/* The one place a power becomes a speed, for the ground, a wall or a node. */
const launchSpeed = (p, fromNode) => fromNode
  ? MOVE.nodeBurst * Math.sqrt(MOVE.nodeReachMin + (1 - MOVE.nodeReachMin) * clamp(p, 0, 1))
  : burstSpeed(p);

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
  let ambience = null, windGain = null;
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

    ambience = ctx.createGain(); ambience.gain.value=.012; ambience.connect(bus);
    for (const hz of [130.81,196.0]) { const o=ctx.createOscillator(); o.frequency.value=hz; o.connect(ambience); o.start(); }
    const breeze=ctx.createBufferSource(); breeze.buffer=noiseBuf; breeze.loop=true;
    const filter=ctx.createBiquadFilter(); filter.type='lowpass'; filter.frequency.value=550;
    windGain=ctx.createGain(); windGain.gain.value=0;
    breeze.connect(filter); filter.connect(windGain); windGain.connect(bus); breeze.start();
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
    environment(near) { if(windGain) windGain.gain.setTargetAtTime(near?.018:0,ctx.currentTime,.3); },
    suspend(hidden) { if(ctx) { if(hidden) ctx.suspend(); else if(on) ctx.resume(); } },
    crack() { air_noise({dur:.22,peak:.065,f0:1800,f1:650,q:2,cap:2800}); tone({f0:740*rand(.98,1.02),f1:370,dur:.16,peak:.022}); },
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
      const m = MIX.land * (0.4 + s * 0.6) * rand(.94,1.06);
      tone({ type: 'sine', f0: (132 - s * 28) * rand(.97,1.03), f1: 82, dur: 0.14, glide: 0.1,
             peak: 0.5 * m, attack: 0.005, lp: 760 });
      air_noise({ dur: 0.07, peak: 0.24 * m, f0: 520 + s * 500, f1: 260, q: 1.3, cap: 2600 });
    },

    /* taking hold of a wall: a short breath, almost a gasp */
    cling() {
      const v = MIX.cling * rand(.94,1.06);
      air_noise({ dur: 0.14, peak: 0.22 * v, f0: 1700, f1: 700, q: 1.1, cap: 4200, send: 0.2 });
      tone({ type: 'sine', f0: 320 * rand(.97,1.03), f1: 250, dur: 0.14, glide: 0.1, peak: 0.2 * v, attack: 0.008, lp: 1800 });
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

   `name` and `tip` are the only player-facing strings here, and they are
   level content rather than shell text, so they live with the level. A tip is
   shown once, on arrival, and only names the ONE thing the level is about —
   the level itself is what teaches it.

   Any entity may carry `motion` to oscillate or sweep.
   ============================================================ */

/* ---- authoring helpers ---------------------------------------------------
   A designer thinks about a surface as "these edges, this top". The
   simulation wants a centre and a size. These two lines are the whole
   translation, and they exist so that every number written below is a number
   that can be reasoned about directly against the measurements above.

   `at` returns the route waypoint for standing on a surface: the resting
   centre of the spirit, which is one radius above the top. */
const ledge = (l, r, top, h, extra) =>
  Object.assign({ x: (l + r) / 2, y: top + h / 2, w: r - l, h }, extra || {});
const tower = (l, r, top, bottom, extra) =>
  Object.assign({ x: (l + r) / 2, y: (top + bottom) / 2, w: r - l, h: bottom - top }, extra || {});
const topOf = (s) => s.y - s.h / 2;
const at = (s, x) => [x === undefined ? s.x : x, topOf(s) - MOVE.radius, 'ground'];
/* A hold on one face of a tower: `side` is -1 for its left face, +1 for its
   right, and the spirit sits one radius clear of it. */
const grip = (s, side, y) => [s.x + side * (s.w / 2 + MOVE.radius), y, 'cling'];
const via = (n) => [n.x, n.y, 'node'];
const onto = (sp) => [sp.x, sp.y, 'spring'];
/* The gate floats a little above the surface it crowns, close enough that
   arriving on that surface is arriving. The goal is a place, not a last
   fiddly input. */
const gateOn = (s, x) => ({ x: x === undefined ? s.x : x, y: topOf(s) - 55 });
/* A checkpoint sits just above its platform, so the respawn drops the spirit
   the last few units onto solid ground rather than into anything. */
const checkOn = (s, x) => ({ x: x === undefined ? s.x : x, y: topOf(s) - 42 });

/* ---------------------------------------------------------------------------
   THE CAMPAIGN

   Fifteen levels, one new idea at a time, built against measured numbers
   rather than guessed ones. `node tests/measure-reach.cjs` and
   `node tests/measure-camera.cjs` print the two tables the geometry below is
   sized from; `node tests/validate-levels.cjs` checks every level against
   them. The short version:

     a full-power leap carries 917 units flat, or rises 405 straight up
     at +160 of rise there are 733 units of horizontal left
     an energy node throws slightly harder: 961 flat, 427 up
     a wall hold launches exactly as hard as the ground does
     a spring at 12 degrees rises 526 and carries 365 across on the way down;
       at 20 degrees, 486 and 573; at 28 degrees, 438 and 732

   ...and the number that actually decides the geometry:

     WHILE AIMING, THE PLAYER CAN SEE ABOUT 560 UNITS AHEAD AND 990 ABOVE.

   The view is 540 x 960 and portrait. So a horizontal leap can be physically
   possible and still be a blind jump, and the honest limit on a mandatory
   sideways hop is around 500 units, not 917. That single fact is why this
   campaign climbs, folds and zig-zags instead of running to the right: height
   is cheap to frame and distance is not. Long leaps are left for optional
   shortcuts, where not seeing the far side is the player's choice.

   Difficulty is raised by what a hop asks for — timing, sequencing, choosing
   a route, reading a pattern — and only rarely by making one longer.
--------------------------------------------------------------------------- */

const LEVELS = [];

/* === 1. First contact ======================================================
   Teach one thing: pull back further, go further. Three broad ledges climbing
   to the right, a floor across the whole world so nothing can go wrong, and
   no mechanic at all. The middle hop is the long one, so the level says
   "short, longer, short" rather than "easy, easy, easy".
   Target: 1/10. */
LEVELS.push((() => {
  const floor = ledge(0, 1660, 950, 150);
  const p1 = ledge(-20, 380, 815, 120);
  const p2 = ledge(500, 780, 690, 90);      // gap 120, rise 125
  const p3 = ledge(950, 1240, 570, 90);     // gap 170, rise 120
  const p4 = ledge(1390, 1670, 455, 90);    // gap 150, rise 115
  return {
    name: 'İlk Işık',
    tip: 'Basılı tut, geriye çek ve bırak.',
    w: 1660, h: 1060,
    bg: ['#141a44', '#06091c'], accent: [120, 170, 255],
    spawn: { x: 120, y: 770 },
    gate: gateOn(p4, 1540),
    solids: [floor, p1, p2, p3, p4],
    route: [at(p1, 120), at(p2, 580), at(p3, 1030), at(p4, 1470), [0, 0, 'gate']],
  };
})());

/* === 2. Height =============================================================
   Wall cling. It appears twice: once on a stub in the middle of the world
   where falling off costs nothing, and then on the tower that is the level.
   The tower's crown is the goal, and it is in frame from the ledge below it
   before the player commits to the climb.
   Target: 1.5/10. */
LEVELS.push((() => {
  const floor = ledge(0, 1500, 1330, 150);
  const p1 = ledge(-20, 320, 1180, 130);
  const stub = tower(440, 610, 930, 1330);   // practice face, crown at 930
  const p2 = ledge(760, 1080, 900, 90);      // a flat rest between the two holds
  const keep = tower(1170, 1410, 480, 1330); // the tower: crown at 480
  return {
    name: 'Tutun',
    tip: 'Duvara değ ve tutun. Sonra yukarı bırak.',
    w: 1500, h: 1440,
    bg: ['#102542', '#040a18'], accent: [90, 190, 255],
    spawn: { x: 110, y: 1135 },
    gate: gateOn(keep),
    solids: [floor, p1, stub, p2, keep],
    route: [
      at(p1, 110),
      grip(stub, -1, 1030),
      at(stub, 540),
      at(p2, 850),
      grip(keep, -1, 700),
      at(keep),
      [0, 0, 'gate'],
    ],
  };
})());

/* === 3. Echo ===============================================================
   Energy nodes. A node only catches you if you press for it, so the first one
   can simply sit on a leap that already works: nothing happens unless the
   player reaches for it, and reaching for it is the lesson. The second is the
   level — the last ledge is 417 units up, past anything a standing leap can
   do, and the node is the only way onto it.
   Target: 2/10. */
LEVELS.push((() => {
  const floor = ledge(0, 1660, 1010, 140);
  const p1 = ledge(-20, 350, 870, 120);
  const p2 = ledge(620, 1010, 760, 90);      // 410 to its near edge, rise 110
  const p3 = ledge(1320, 1700, 400, 90);     // out of reach from the ledge below
  const spare = { x: 480, y: 690 };          // free to ignore; free to discover
  const lift = { x: 1060, y: 640 };
  return {
    name: 'Yankı',
    tip: 'Havada küreye bas. Seni tutar, yeniden nişan al.',
    w: 1740, h: 1120,
    bg: ['#231640', '#08061c'], accent: [170, 130, 255],
    spawn: { x: 250, y: 825 },
    gate: gateOn(p3, 1540),
    solids: [floor, p1, p2, p3],
    nodes: [spare, lift],
    route: [at(p1, 250), at(p2, 900), via(lift), at(p3, 1540), [0, 0, 'gate']],
  };
})());

/* === 4. Leap ===============================================================
   Springs. The first one is arrived at along a 90-unit hop with nothing near
   it, and it throws the player onto a 450-wide shelf — it is not possible to
   misread. The second is aimed the other way, folding the level back over
   itself: the shelf it leaves is 467 units below its landing, so the throw is
   the only way up, and the world stays compact instead of running off to the
   right.
   Target: 2.5/10. */
LEVELS.push((() => {
  const floor = ledge(0, 1500, 1440, 150);
  const p1 = ledge(-20, 330, 1300, 120);
  const pad = ledge(420, 830, 1200, 110);            // arrive here, calmly
  const s1 = { x: 690, y: 1176, w: 172, h: 44, a: 16 };
  const shelf = ledge(1050, 1500, 880, 120);         // 450 units of safety
  const s2 = { x: 1400, y: 856, w: 170, h: 44, a: -14 };
  const p4 = ledge(800, 1180, 400, 110);     // clear of the throw's rising arc
  const p5 = ledge(300, 700, 290, 100);
  return {
    name: 'Sıçrama',
    tip: 'Yeşil yüzey, baktığı yöne fırlatır.',
    w: 1500, h: 1560,
    bg: ['#0d2c34', '#040f18'], accent: [90, 220, 190],
    spawn: { x: 110, y: 1255 },
    gate: gateOn(p5, 450),
    solids: [floor, p1, pad, shelf, p4, p5],
    springs: [s1, s2],
    route: [
      at(p1, 110), at(pad, 520), onto(s1), at(shelf, 1160),
      onto(s2), at(p4, 1040), at(p5, 450), [0, 0, 'gate'],
    ],
  };
})());

/* === 5. The crimson road ===================================================
   Danger, and the first choice. The spike bed is 135 units below a hop the
   player has already made a dozen times, so it is seen long before it
   matters. Then the level forks: a stepping stone over the pit for two short
   safe hops, or one 520-unit crossing straight over it. The long way is not a
   punishment and the short way is not a trap — it is simply the first time
   the player decides anything.
   Target: 3/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 960, 1070, 130);          // only the near half
  const p1 = ledge(-20, 400, 830, 130);
  const p2 = ledge(560, 950, 790, 100);
  const stone = ledge(1030, 1220, 800, 70);          // the cautious way across
  const p4 = ledge(1300, 1760, 700, 110);
  return {
    name: 'Kızıl Yol',
    tip: 'Kırmızıya dokunma. İki yol da geçer.',
    w: 1780, h: 1180,
    bg: ['#2a1330', '#0a0418'], accent: [220, 120, 220],
    spawn: { x: 240, y: 785 },
    gate: gateOn(p4, 1660),
    solids: [floor, p1, p2, stone, p4],
    spikes: [{ x: 1125, y: 965, w: 330, h: 70 }],
    route: [at(p1, 240), at(p2, 860), at(stone, 1120), at(p4, 1400), [0, 0, 'gate']],
    fastRoute: [at(p1, 240), at(p2, 860), at(p4, 1400), [0, 0, 'gate']],
  };
})());

/* === 6. Pulse ==============================================================
   Beams, and the first level shaped as a shaft rather than a walk. Every
   crossing is made from a wide ledge the player can stand on for as long as
   they like — the world is frozen while a stretch is held, so counting the
   beam costs nothing. Lit for 1.3 seconds, dark for 3.5.

   The first hop passes UNDER the first beam and the last hop sails OVER the
   second: the level opens by showing the danger without asking anything, and
   closes by letting the player use what they have learned to ignore it.
   Target: 3.5/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1060, 2120, 120);
  const p1 = ledge(-20, 400, 2040, 120);
  const watch = ledge(640, 1040, 1810, 110);   // stand here and count
  const p3 = ledge(-20, 460, 1580, 100);
  const p4 = ledge(600, 1040, 1350, 100);
  const p5 = ledge(-20, 460, 1120, 110);
  return {
    name: 'Nabız',
    tip: 'Işık sönünce geç. Beklemek serbest.',
    w: 1060, h: 2240,
    bg: ['#161a3a', '#050919'], accent: [140, 175, 245],
    spawn: { x: 220, y: 1995 },
    gate: gateOn(p5, 220),
    solids: [floor, p1, watch, p3, p4, p5],
    beams: [
      { x: 520, y: 1640, w: 28, h: 280, pulse: { period: 4.8, phase: 0, duty: 0.28 } },
      { x: 520, y: 1400, w: 28, h: 280, pulse: { period: 4.8, phase: 0.45, duty: 0.28 } },
    ],
    route: [
      at(p1, 220), at(watch, 860), at(p3, 200), at(p4, 820), at(p5, 200), [0, 0, 'gate'],
    ],
  };
})());

/* === 7. Sway ===============================================================
   Moving ground. The first one crosses a gap with a floor under it, takes ten
   seconds to complete a lap, and is 260 units wide — it can be watched for as
   long as the player likes from the ledge before it, and missing it costs a
   short climb rather than a life. The second moves vertically, which is the
   same idea read on the other axis.
   Target: 4/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1820, 1140, 120);
  const p1 = ledge(-20, 420, 880, 130);
  const watch = ledge(520, 850, 820, 110);
  const m1 = ledge(1000, 1260, 755, 70, { motion: { type: 'osc', dx: 130, dy: 0, period: 10 } });
  const p3 = ledge(1420, 1800, 780, 110);
  const m2 = ledge(1160, 1400, 455, 70, { motion: { type: 'osc', dx: 0, dy: 90, period: 9 } });  // clear over the ledge below
  const p4 = ledge(820, 1140, 180, 110);     // 600 above the ledge before it: ride or nothing
  return {
    name: 'Salınım',
    tip: 'Zemin geliyor. Acele etme, izle.',
    w: 1820, h: 1260,
    bg: ['#10203c', '#040a18'], accent: [110, 200, 235],
    spawn: { x: 110, y: 835 },
    gate: gateOn(p4, 980),
    solids: [floor, p1, watch, m1, p3, m2, p4],
    route: [
      at(p1, 110), at(watch, 780), at(m1), at(p3, 1600), at(m2), at(p4, 980), [0, 0, 'gate'],
    ],
  };
})());

/* === 8. Fragile ============================================================
   Crumbling ground. The first one is a landing with a floor beneath it and
   2.2 seconds of cracking, so the lesson costs nothing: stand on it, watch it
   fail, understand what the cracks mean.

   The pair above is the level. Between the middle ledge and the top there are
   440 units of climb and nothing else to stand on, so the two crumbling steps
   are the way up rather than a detour — and neither can be skipped, because
   from the first the top is still 387 up and a standing leap tops out at 405
   with almost no reach left over. The floor still runs underneath everything,
   so getting it wrong costs the climb, never the level.
   Target: 4.5/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1440, 1080, 120);
  const p1 = ledge(-20, 400, 900, 130);
  const c1 = ledge(520, 820, 840, 80, { crumble: 2.2 });    // safe: a floor below it
  const p2 = ledge(960, 1300, 800, 110);
  const c2 = ledge(700, 920, 620, 70, { crumble: 1.8 });
  const c3 = ledge(500, 720, 470, 70, { crumble: 1.8 });
  const p3 = ledge(40, 380, 300, 110);     // a diagonal hop, not a climb up its face
  return {
    name: 'Kırılgan',
    tip: 'Çatlarsa kalma. Ama telaş da etme.',
    w: 1440, h: 1200,
    bg: ['#2b1b2e', '#0b0616'], accent: [215, 160, 200],
    spawn: { x: 110, y: 855 },
    gate: gateOn(p3, 200),
    solids: [floor, p1, c1, p2, c2, c3, p3],
    route: [
      at(p1, 110), at(c1, 670), at(p2, 1100), at(c2, 810), at(c3, 610), at(p3, 200), [0, 0, 'gate'],
    ],
  };
})());

/* === 9. Flow ===============================================================
   The first real combination, and deliberately not a precision test: hold a
   wall, go over its crown, step across, and be thrown. Nothing here is
   dangerous. The point is that the four things the player knows now join up
   into one continuous movement, and it should be the level where they first
   feel good at this.
   Target: 5/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1300, 1830, 130);
  const p1 = ledge(-20, 420, 1760, 130);
  const keep = tower(560, 740, 1320, 1830);
  const p2 = ledge(820, 1260, 1280, 100);    // room to land BESIDE the spring
  const s1 = { x: 1150, y: 1256, w: 170, h: 44, a: -14 };
  const p3 = ledge(500, 940, 820, 110);      // right edge kept clear of the rising arc
  const p4 = ledge(80, 400, 640, 100);
  return {
    name: 'Akış',
    tip: 'Tutun, tırman, fırla. Hepsi tek bir hareket.',
    w: 1300, h: 1900,
    bg: ['#0e2b3a', '#040f1a'], accent: [95, 210, 220],
    spawn: { x: 120, y: 1715 },
    gate: gateOn(p4, 240),
    solids: [floor, p1, keep, p2, p3, p4],
    springs: [s1],
    route: [
      at(p1, 120), grip(keep, -1, 1580), at(keep), at(p2, 880),
      onto(s1), at(p3, 760), at(p4, 240), [0, 0, 'gate'],
    ],
  };
})());

/* === 10. The lasso =========================================================
   A node over moving ground. Held at the node the world is frozen, so the
   player can watch the platform's whole path and pick the moment to let go —
   which is the point: this should feel clever rather than quick. Past the
   first section the floor stops, so the checkpoint on the far ledge is what
   makes the second half cost seconds instead of the whole level.
   Target: 5.5/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 960, 1290, 120);          // near half only
  const p1 = ledge(-20, 400, 1080, 130);
  const watch = ledge(520, 900, 1000, 110);
  const hold = { x: 1060, y: 820 };
  const m1 = ledge(1080, 1320, 865, 70, { motion: { type: 'osc', dx: 0, dy: 150, period: 8 } });
  const p3 = ledge(1420, 1800, 780, 110);
  const m2 = ledge(1000, 1220, 565, 70, { motion: { type: 'osc', dx: 140, dy: 0, period: 7 } });
  const p4 = ledge(420, 800, 290, 110);      // out of the node's reach: the lift is the way
  return {
    name: 'Kement',
    tip: 'Küredeyken dünya durur. Zamanını seç.',
    w: 1820, h: 1400,
    bg: ['#22183f', '#07051a'], accent: [190, 150, 250],
    spawn: { x: 110, y: 1035 },
    gate: gateOn(p4, 610),
    solids: [floor, p1, watch, m1, p3, m2, p4],
    nodes: [hold],
    motes: [checkOn(p3, 1500)],
    route: [
      at(p1, 110), at(watch, 800), via(hold), at(m1), at(p3, 1600), at(m2), at(p4, 610),
      [0, 0, 'gate'],
    ],
  };
})());

/* === 11. Current ===========================================================
   Wind, three times, in the order the player needs it.

     FEEL IT   a weak sideways current over a 440-wide ledge, so the arc can
               be watched bending with nothing riding on it.
     FIGHT IT  the same kind of current, pushing the wrong way, on a hop that
               has to be aimed about 120 units into it.
     RIDE IT   a rising current that roughly doubles the arc. The shelf it
               leads to is 460 up, which no standing leap can reach, so the
               current is not a shortcut — it is the way.

   A current is weaker than gravity, always: it bends a leap, it never takes
   the leap away. And the floor runs the whole width here, because this level
   is about learning to read the air, not about being punished for it.
   Target: 6/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1500, 1450, 120);
  const p1 = ledge(-20, 400, 1280, 130);
  const p2 = ledge(620, 1060, 1180, 110);            // 440 wide: the drift cannot miss
  const p3 = ledge(120, 560, 980, 110);
  const p4 = ledge(860, 1400, 520, 130);             // the shelf above the current
  return {
    name: 'Akıntı',
    tip: 'Akıntı seni taşır. Ona göre nişan al.',
    w: 1500, h: 1560,
    bg: ['#0c2b33', '#030f16'], accent: [80, 215, 210],
    spawn: { x: 230, y: 1235 },
    gate: gateOn(p4, 1200),
    solids: [floor, p1, p2, p3, p4],
    winds: [
      { x: 700, y: 1180, w: 420, h: 300, dx: 1, dy: 0, strength: 0.05 },   // feel it
      { x: 640, y: 960, w: 420, h: 280, dx: 1, dy: 0, strength: 0.07 },    // fight it
      { x: 700, y: 700, w: 520, h: 520, dx: 0, dy: -1, strength: 0.26 },   // ride it
    ],
    route: [
      at(p1, 230), at(p2, 860), at(p3, 300), at(p3, 480),
      // the ride: carried, so its reach is checked by flying it, not by an
      // envelope measured in still air
      [at(p4, 1100)[0], at(p4, 1100)[1], 'ground', 'wind'],
      [0, 0, 'gate'],
    ],
  };
})());

/* === 12. The cycle =========================================================
   Spring and beam, alternating, so the level reads as a bar of music:

     rest -> be thrown -> land -> stand still and count -> cross -> rest

   ...twice. Every beam is met from a ledge with nothing happening on it, and
   every spring throw has clear air the whole way, so the two mechanics never
   ask for anything at the same moment. That is what makes this a rhythm and
   not a reaction test.

   The checkpoint sits on the ledge in the middle, so the half already solved
   stays solved.
   Target: 6.5/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1000, 1830, 130);         // the near side only
  const p1 = ledge(-20, 400, 1740, 130);
  const p2 = ledge(560, 960, 1660, 110);
  const s1 = { x: 820, y: 1636, w: 170, h: 44, a: 12 };
  const p3 = ledge(1060, 1500, 1330, 100);
  const p4 = ledge(280, 780, 1090, 110);             // land left of the beam, rest
  const s2 = { x: 380, y: 1066, w: 170, h: 44, a: 16 };
  const p5 = ledge(700, 1140, 760, 100);
  const p6 = ledge(1260, 1700, 560, 110);
  return {
    name: 'Döngü',
    tip: 'Bekle, fırla, in, say, geç.',
    w: 1740, h: 1900,
    bg: ['#1c1436', '#060418'], accent: [160, 150, 245],
    spawn: { x: 230, y: 1695 },
    gate: gateOn(p6, 1560),
    solids: [floor, p1, p2, p3, p4, p5, p6],
    springs: [s1, s2],
    beams: [
      { x: 820, y: 1180, w: 28, h: 240, pulse: { period: 4.2, phase: 0, duty: 0.30 } },
      { x: 1200, y: 640, w: 28, h: 220, pulse: { period: 4.0, phase: 0.35, duty: 0.32 } },
    ],
    motes: [checkOn(p4, 620)],
    route: [
      at(p1, 230), at(p2, 620), onto(s1), at(p3, 1185), at(p4, 600),
      onto(s2), at(p5, 850), at(p6, 1400), [0, 0, 'gate'],
    ],
  };
})());

/* === 13. The parting =======================================================
   One chasm, one hub, two honest ways over it.

   The patient way goes DOWN first: drop onto a crumbling step, leave before
   it goes, ride the lift back up, step off. Three hops, nothing the player
   has not already done, and the only pressure is the 1.6 seconds of cracking.

   The bold way is two: a 400-unit leap out over the void into a node, then
   one throw from it onto the far shelf. It asks for a real commitment over
   open air — and it is the only place in the level where being wrong costs
   the whole crossing.

   Both are reasonable. Mastery is paid in hops saved, which is the only
   currency this game has.
   Target: 7/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1000, 1390, 120);         // the near side only
  const p1 = ledge(-20, 400, 1200, 130);
  const hub = ledge(540, 980, 1120, 120);            // the fork, and the checkpoint
  const step = ledge(1060, 1260, 1240, 70, { crumble: 1.6 });
  const lift = ledge(1320, 1560, 1140, 70, { motion: { type: 'osc', dx: 0, dy: 120, period: 8 } });
  const bold = { x: 1300, y: 900 };                  // the whole of the short way
  const far = ledge(1640, 2040, 820, 110);           // clear of the lift's travel
  const p6 = ledge(1240, 1620, 560, 110);
  return {
    name: 'Ayrım',
    tip: 'İki yol var. İkisi de doğru.',
    w: 2080, h: 1520,
    bg: ['#2a1526', '#0b0514'], accent: [230, 140, 180],
    spawn: { x: 230, y: 1155 },
    gate: gateOn(p6, 1420),
    solids: [floor, p1, hub, step, lift, far, p6],
    nodes: [bold],
    motes: [checkOn(hub, 760)],
    route: [
      at(p1, 230), at(hub, 860), at(step, 1160), at(lift), at(far, 1760),
      at(p6, 1400), [0, 0, 'gate'],
    ],
    fastRoute: [
      at(p1, 230), at(hub, 860), via(bold), at(far, 1760), at(p6, 1400), [0, 0, 'gate'],
    ],
  };
})());

/* === 14. The ascent ========================================================
   The first long level, and a wave rather than a ramp:

     wall    -> REST -> moving ground -> CHECKPOINT
     current and node (the hard section) -> REST
     spring over a hazard -> CHECKPOINT -> a short wall, and out

   Every named REST is a wide ledge with nothing on it, and the two
   checkpoints are placed so the worst a mistake costs is one section.

   The spike bed is the floor of the upper chamber: it is under everything
   that happens there and in the way of nothing, so it reads as a reason to
   be careful rather than as a trap.
   Target: 7.5/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 1250, 2930, 130);
  const p1 = ledge(-20, 380, 2800, 120);
  const keep = tower(550, 730, 2340, 2860);
  const rest1 = ledge(840, 1240, 2230, 110);
  const m1 = ledge(585, 815, 2065, 70, { motion: { type: 'osc', dx: 150, dy: 0, period: 8 } });
  const camp1 = ledge(120, 620, 1900, 100);
  const hold = { x: 820, y: 1650 };
  const rest2 = ledge(180, 640, 1500, 110);          // 460 wide, and only 160 up
  const s1 = { x: 520, y: 1476, w: 170, h: 44, a: 12 };
  const camp2 = ledge(760, 1200, 1080, 110);
  const last = tower(360, 560, 640, 1060);
  const p6 = ledge(640, 1040, 460, 110);
  return {
    name: 'Tırmanış',
    tip: 'Uzun bir tırmanış. Aralarda dinlen.',
    w: 1250, h: 3000,
    bg: ['#141d3e', '#05081a'], accent: [130, 180, 250],
    spawn: { x: 110, y: 2755 },
    gate: gateOn(p6, 840),
    solids: [floor, p1, keep, rest1, m1, camp1, rest2, camp2, last, p6],
    springs: [s1],
    nodes: [hold],
    winds: [{ x: 640, y: 1700, w: 360, h: 320, dx: 1, dy: 0, strength: 0.055 }],
    spikes: [{ x: 1060, y: 1500, w: 280, h: 60 }],   // the chamber floor, never an arc
    motes: [checkOn(camp1, 300), checkOn(camp2, 1060)],   // clear of the current
    route: [
      at(p1, 110), grip(keep, -1, 2600), at(keep), at(rest1, 1000),
      at(m1), at(camp1, 360), via(hold), at(rest2, 320),
      onto(s1), at(camp2, 900), grip(last, 1, 900), at(last), at(p6, 840), [0, 0, 'gate'],
    ],
  };
})());

/* === 15. The last light ===================================================
   Everything, once, in an order that never asks for two unfamiliar things at
   the same time. It is the only level allowed to be genuinely hard, and the
   hardness is in the length of the chain rather than the precision of any one
   link: nothing here needs an exact angle, and nothing kills without showing
   itself first. Three checkpoints keep a mistake inside its own section.

   The node halfway up sits in a low corridor with a roof over it. That roof
   is doing real work: an energy node throws nearly a thousand units, far
   enough to skip most of a level, and the ceiling is what turns that throw
   back into the one move the chamber is asking for — out along the corridor,
   onto the crumbling step, and up.

   The closing chain — wall, node, spring, landing — is the one place the game
   asks for four things without a proper rest between them.
   Target: 9/10. */
LEVELS.push((() => {
  const floor = ledge(-20, 700, 3260, 120);          // the start, and nothing else
  const p1 = ledge(-20, 400, 3140, 120);
  const p2 = ledge(660, 940, 3020, 90);
  const w1 = tower(1020, 1400, 2740, 3100);          // crown wide enough to stand beside the spring
  const s1 = { x: 1290, y: 2716, w: 170, h: 44, a: -16 };
  const camp1 = ledge(560, 980, 2440, 100);
  const m1 = ledge(310, 530, 2285, 70, { motion: { type: 'osc', dx: 0, dy: 130, period: 7 } });
  const turn = { x: 300, y: 1880 };                  // only the lift reaches it
  const roof = ledge(120, 740, 1700, 80);            // the ceiling that shapes the throw
  const c1 = ledge(760, 1000, 1870, 70, { crumble: 1.5 });
  const camp2 = ledge(1340, 1640, 1760, 100);
  const p5 = ledge(900, 1260, 1560, 100);
  const p6 = ledge(300, 680, 1400, 100);
  const w3 = tower(555, 725, 960, 1160);    // faces out of reach of the ledge below
  const m2 = ledge(960, 1160, 1035, 70, { motion: { type: 'osc', dx: 160, dy: 0, period: 6.5 } });
  const camp3 = ledge(1180, 1520, 860, 100);
  const w4 = tower(740, 900, 560, 860);
  const last = { x: 520, y: 560 };
  const p8 = ledge(180, 460, 700, 90);
  const s2 = { x: 320, y: 676, w: 170, h: 44, a: 18 };
  const p9 = ledge(700, 1060, 300, 100);
  return {
    name: 'Son Işık',
    tip: 'Bildiğin her şey. Sırayla.',
    w: 1740, h: 3400,
    bg: ['#1a1030', '#050310'], accent: [235, 200, 255],
    spawn: { x: 240, y: 3095 },
    gate: gateOn(p9, 880),
    solids: [floor, p1, p2, w1, camp1, m1, roof, c1, camp2, p5, p6, w3, m2, camp3, w4, p8, p9],
    springs: [s1, s2],
    nodes: [turn, last],
    winds: [{ x: 1060, y: 1540, w: 360, h: 340, dx: -1, dy: 0, strength: 0.06 }],
    beams: [{ x: 800, y: 1450, w: 28, h: 260, pulse: { period: 3.8, phase: 0, duty: 0.32 } }],
    motes: [checkOn(camp1, 860), checkOn(camp2, 1500), checkOn(camp3, 1360)],
    route: [
      at(p1, 240), at(p2, 800), grip(w1, -1, 2800), at(w1, 1100),
      onto(s1), at(camp1, 860), at(m1), via(turn), at(c1, 880), at(camp2, 1500),
      at(p5, 1080), at(p6, 400), grip(w3, -1, 1100), at(w3),
      at(m2), at(camp3, 1260), grip(w4, 1, 800), at(w4),
      via(last), onto(s2), at(p9, 840), [0, 0, 'gate'],
    ],
  };
})());

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
  winds: [],
  gate: null,
  w: VW, h: VH,
  bg: ['#141a44', '#06091c'],
  accent: [120, 170, 255],
};

const ENTITY_KINDS = {
  solid:  { list: 'solids',  init: (e) => { e.crumbleT = -1; e.broken = false; } },
  spring: { list: 'springs', init: (e) => { e.fire = 0; e.lock = false; e.off = false; e.cool = 0; } },
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
  world.winds = L.winds || [];
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

/* Is a body inside this box's ACTIVATION region — the box itself, grown by
   `pad` on every side? `overlapsBox` answers "is it touching"; this answers the
   different question "is it still around", which is what re-arming a spring
   depends on. Same maths as circleVsBox, without the normal nobody wants. */
function nearBox(px, py, r, e, pad) {
  const dx = px - e.x, dy = py - e.y;
  const reach = e.br + r + pad;
  if (dx * dx + dy * dy > reach * reach) return false;
  const ca = e.ca, sa = -e.sa;
  const lx = dx * ca - dy * sa;
  const ly = dx * sa + dy * ca;
  const hw = e.w / 2 + pad, hh = e.h / 2 + pad;
  const qx = clamp(lx, -hw, hw), qy = clamp(ly, -hh, hh);
  const ddx = lx - qx, ddy = ly - qy;
  return ddx * ddx + ddy * ddy <= r * r;
}

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

/* What one step of motion ran into.

   `wall` is "a wall was touched" — physics and feedback care about that.
   `wallHold` is "a wall you may take hold of", which is the different question
   the player-state logic asks: the wall you just launched from is briefly not
   one, so leaping up and over a ledge cannot be undone by the same face
   catching you again a frame later. */
const RES = {
  floor: false, wall: false, wallHold: false, ceil: false,
  wallNx: 0, wallE: null,
  impact: 0, hx: 0, hy: 0, nx: 0, ny: 0,
  spring: null, lethal: null,
  reset() {
    this.floorE = null; this.floor = false; this.wall = false; this.wallHold = false; this.ceil = false;
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
  if (e.broken) return;
  const hit = circleVsBox(s.x, s.y, s.r, e);
  if (!hit) return;
  const nx = hit.nx, ny = hit.ny;
  s.x += nx * (hit.pen + MOVE.slop);
  s.y += ny * (hit.pen + MOVE.slop);
  const sv = surfaceVel(e, s.x, s.y);
  if (s === body && PS.state === 'ground' && PS.support === e && e.motion) { sv.x = 0; sv.y = 0; }
  const vn = (s.vx - sv.x) * nx + (s.vy - sv.y) * ny;
  CT.add(nx, ny, hit.pen, sv.x, sv.y, vn < 0);

  // classify the surface from its normal, so the player logic never has to
  // reason about geometry: a normal pointing up is something to stand on,
  // a normal pointing down is something you bonk, anything else is a wall
  if (ny < -MOVE.floorDot) { RES.floor = true; RES.floorE = e; }
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
        const keep = RES.floor ? MOVE.slideKeep : RES.ceil ? MOVE.ceilingKeep : MOVE.wallSlide;
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
   construction: the arrow drawn on it is exactly where you will go.

   ONE CONTACT, ONE LAUNCH. The failure this guards against is the spirit
   landing back onto the spring that just threw it and being thrown again, with
   no input in between — a loop the player cannot get out of, because being
   airborne is the one state that hands them no control.

   So a spring that fires is locked to the body it threw. It will not fire
   again, at all, until that body has left its activation region (`springExit`
   past the collider on every side); `releaseSprings` is the only thing that
   unlocks it. A timer alone could not do this — the player may sit on top of a
   spring indefinitely — so the timer here is only the backstop for a body that
   is flung clear and back inside a couple of frames.

   `live` separates the player from the aim preview: the preview runs this same
   function so the dotted guide knows about springs, and it must read the lock
   but never write one — a spring the guide can see is dark is a spring the
   guide draws you falling past, which is exactly what will happen. */
function fireSpring(s, sp, live) {
  if (sp.lock || sp.off || sp.cool > 0) return;
  if (!overlapsBox(s.x, s.y, s.r, sp)) return;
  const nx = sp.sa, ny = -sp.ca;             // local -y, rotated into the world
  const vn = s.vx * nx + s.vy * ny;
  const tvx = s.vx - nx * vn;
  const tvy = s.vy - ny * vn;
  s.vx = tvx * MOVE.springKeep + nx * MOVE.springSpeed;
  s.vy = tvy * MOVE.springKeep + ny * MOVE.springSpeed;
  // Leave along the launch normal with real clearance, rather than the token
  // nudge this used to do: the body ends up fully outside the face, so no
  // later substep can find the same overlap, and there is no jitter between a
  // collider and a body sitting exactly on its skin.
  const d = (s.x - sp.x) * nx + (s.y - sp.y) * ny;
  const want = sp.h / 2 + s.r + MOVE.springClear;
  if (d < want) { s.x += nx * (want - d); s.y += ny * (want - d); }
  if (live) { sp.lock = true; sp.cool = MOVE.springCool; }
  RES.spring = sp;
}

/* Re-arm every spring the spirit has got clear of. Run once per simulation
   step, BEFORE the spirit moves, so a spring can never be unlocked and fired
   inside the same step by the clearance its own launch just applied.

   This clears the CONTACT lock only. The failsafe cutout is a different thing
   with a different release — see springLoop — and getting away from a spring
   is not the same as having been given back control. */
function releaseSprings(px, py, r) {
  for (let i = 0; i < world.springs.length; i++) {
    const sp = world.springs[i];
    if (sp.lock && !nearBox(px, py, r, sp, MOVE.springExit)) sp.lock = false;
  }
}

/* The failsafe behind the lock.

   Leaving the region re-arms a spring, and that is correct — but a spring
   aimed straight up throws the spirit far outside its region and drops it
   right back in, so the region rule ALONE still allows a loop: out, back, out,
   back, with the player holding a dead controller the whole time. The lock is
   working perfectly in that case and the player is still trapped.

   So the thing actually being counted here is not contacts or seconds, it is
   throws the player never got to answer. One too many and the spring is cut
   out entirely — `off` — and the spirit falls THROUGH it (a spring is a
   trigger, not a surface) onto whatever it is mounted on, and lands.

   The cutout is cleared by CONTROL RETURNING, never by a timer. A timer cannot
   be right here: how long the spirit is in the air is decided by the throw, so
   any fixed lockout is either too short to break a strong spring's loop or
   long enough to be felt on a weak one. And because control returning is what
   clears it, a player deliberately bouncing off the same spring over and over
   never trips it — they are answering every throw. */
const springLoop = {
  sp: null, n: 0,
  /* The player got a say. Nothing before this counts, and every cutout is
     lifted: whatever the spirit was stuck in, it is not stuck in it now. */
  clear() {
    this.sp = null; this.n = 0;
    for (let i = 0; i < world.springs.length; i++) world.springs[i].off = false;
  },
  /* true when this throw is the one that has to be cut off */
  count(sp) {
    if (this.sp === sp) this.n++;
    else { this.sp = sp; this.n = 1; }
    if (this.n < MOVE.springLoopMax) return false;
    this.sp = null; this.n = 0;
    return true;
  },
};

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
      fireSpring(s, world.springs[k], live);
      if (RES.spring) { i = n; break; }
    }
  }
  // A wall this body has just launched from cannot be taken hold of again yet,
  // so that leaping up and over a ledge is not undone by the same face
  // catching you a frame later. It still collides — it is a wall — it just
  // cannot be grabbed. Any other wall can.
  RES.wallHold = RES.wall && !(s.noWallT > 0 && RES.wallE === s.noWall);
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
    if (e.broken || e.a || e.w < 60) continue;              // flat, standable tops only
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

/* ---- ledge assist -------------------------------------------------------
   The companion to the landing assist, for going UP over a corner rather than
   down onto a ledge.

   The situation it exists for: the spirit is holding the side of a block and
   the player pulls to send it up and over the top. That aim has an inward
   component — and the wall eats it, because every frame the contact removes
   whatever velocity points into the surface. The spirit rises hugging the face
   with no sideways speed at all and comes straight back down beside the block.
   Every aim collapses to the same result, so "over the ledge" is not something
   the player can express.

   So the inward half of that launch is REMEMBERED, and handed back once the
   spirit's feet clear the top edge and it can actually move that way. It is
   the player's own input, paid out a moment later — not a correction invented
   for them. It only arms on a launch that was aimed up and inward from a hold,
   it only pays out while rising near a top that is genuinely within reach, and
   it expires. */
function ledgeAssist(s) {
  if (!s.ledgeDir || s.ledgeT <= 0) return;
  if (s.vy > -0.5) return;                      // only on the way up
  const foot = s.y + s.r;
  for (let i = 0; i < world.solids.length; i++) {
    const e = world.solids[i];
    if (e.broken || e.a || e.w < 40) continue;
    const top = e.y - e.h / 2;
    // The feet have to be clear of the top before drifting inward means
    // anything: any earlier and it is just pressing into the face again.
    if (foot > top + 2 || foot < top - MOVE.ledgeBand) continue;
    const gap = s.ledgeDir > 0 ? (e.x - e.w / 2) - s.x : s.x - (e.x + e.w / 2);
    if (gap <= 0 || gap > MOVE.ledgeReach) continue;
    if (s.vx * s.ledgeDir >= MOVE.ledgeMax) return;
    s.vx += s.ledgeDir * MOVE.ledgePull * (1 - gap / MOVE.ledgeReach);
    return;
  }
}

/* Gravity, air drag and the speed ceiling. The burst window suspends gravity
   for a few frames so a release reads as a deliberate throw rather than
   something that begins falling the instant it leaves. */
function integrate(s) {
  // Shared by live flight and trajectory: currents never alter a resting body.
  if (s !== body || PS.state === 'air') for (const w of world.winds) {
    if (Math.abs(s.x-w.x)<w.w/2 && Math.abs(s.y-w.y)<w.h/2) {
      const len = Math.hypot(w.dx,w.dy) || 1;
      s.vx += w.dx/len*w.strength; s.vy += w.dy/len*w.strength;
    }
  }
  if (s.noWallT > 0) s.noWallT = Math.max(0, s.noWallT - STEP);
  if (s.ledgeT > 0) s.ledgeT = Math.max(0, s.ledgeT - STEP);
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
const probe = { x: 0, y: 0, vx: 0, vy: 0, r: MOVE.radius, burst: 0,
  noWall: null, noWallT: 0, ledgeDir: 0, ledgeT: 0 };
const preview = {
  pts: [], n: 0, land: -1, lx: 0, ly: 0,
  landFloor: false,          // did it end on something you can stand on?
  danger: false, spring: false,
};

const MOTION_KEYS = ['x','y','px','py','vx','vy','a','ca','sa','av'];
function predict(x, y, vx, vy, maxDist) {
  // Forecast moving surfaces and beam phases, then restore the live world.
  // Reused records keep aiming free of per-frame snapshot allocations.
  for (const e of world.movers) {
    if (!e.forecast) e.forecast = {};
    for (const k of MOTION_KEYS) e.forecast[k] = e[k];
  }
  for (const e of world.solids) if (e.crumble) e.forecastBroken = e.broken;
  for (const e of world.beams) e.forecastK = e.k;
  probe.x = x; probe.y = y; probe.vx = vx; probe.vy = vy;
  probe.burst = MOVE.burstTime;
  preview.n = 0; preview.land = -1; preview.landFloor = false;
  preview.danger = false; preview.spring = false;
  let travelled = 0, sinceDot = 1e9;
  for (let i = 0; i < 150; i++) {
    const future = G.t + (i + 1) * STEP;
    updateMotion(future);
    for (const e of world.beams) e.k = beamLevel(e, future);
    for (const e of world.solids) if (e.crumble && e.crumbleT >= 0 && e.crumbleT + (i + 1) * STEP >= e.crumble) e.broken = true;
    const ox = probe.x, oy = probe.y;
    integrate(probe);
    landingAssist(probe);          // the guide must include the help the player gets
    ledgeAssist(probe);
    const r = stepBody(probe);
    if (r.lethal) { preview.danger = true; pushDot(probe.x, probe.y); break; }
    if (r.spring) { preview.spring = true; pushDot(probe.x, probe.y); break; }
    if (r.floor || r.wallHold || r.ceil) {
      preview.land = preview.n;
      preview.landFloor = r.floor || r.wallHold;   // both are places control returns
      preview.lx = probe.x; preview.ly = probe.y;
      pushDot(probe.x, probe.y);
      break;
    }
    const moved = Math.hypot(probe.x - ox, probe.y - oy);
    travelled += moved; sinceDot += moved;
    if (sinceDot >= 22) { sinceDot = 0; pushDot(probe.x, probe.y); }
    if (travelled > maxDist) break;
  }
  for (const e of world.movers) for (const k of MOTION_KEYS) e[k] = e.forecast[k];
  for (const e of world.solids) if (e.crumble) e.broken = e.forecastBroken;
  for (const e of world.beams) e.k = e.forecastK;
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

const body = { x: 0, y: 0, vx: 0, vy: 0, r: MOVE.radius, burst: 0,
  noWall: null, noWallT: 0,     // the wall we just left, and for how long
  ledgeDir: 0, ledgeT: 0 };     // inward intent saved from a launch off a hold

/* grounded · airborne · clinging · held by a node · dissolving · reforming */
const PS = {
  state: 'spawn',
  t: 0,
  prev: 'spawn',
  speed: 0,
  facing: -Math.PI / 2,
  coyote: 0,          // grace after stepping off a surface
  clingT: 0,          // how long the current hold has lasted
  clingWall: null,    // which surface is being held
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
  if (G.menu || G.phase !== 'play') return false;
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

/* ---- the stretch ---------------------------------------------------------
   The slingshot's state. Input writes only to this; the guide, the camera, the
   character visuals and the launch all read it and nothing writes back.

   `sx/sy` and `px/py` are VIRTUAL SCREEN units, not world units — that is the
   whole reason the camera can move freely under a held stretch without the aim
   shifting by a hair. See `toScreen` in section 10. */
const Aim = {
  on: false,
  from: '',            // which state the stretch started in
  sx: 0, sy: 0,        // where the finger went down (screen)
  px: 0, py: 0,        // where the finger is now (screen)
  pullLen: 0,          // raw stretch length in screen units
  pull: 0,             // 0..1 of the usable stretch
  power: 0,            // pull, shaped by powerCurve; what the game acts on
  angle: 0,            // launch direction: the mirror of the pull
  held: 0,
  clear() {
    this.on = false; this.power = 0; this.pull = 0; this.pullLen = 0; this.held = 0;
  },
};

/* Leaving a wall.

   The safety kick exists for exactly one reason: a leap aimed flat along a
   face would otherwise scrape straight back into it. It is NOT there to decide
   where the player goes, and it used to: aiming up and over the top of the
   block you were holding produced a velocity with the sideways component
   flipped — pull up-left, travel up-right — which made the most natural move
   in the game, hopping from a wall onto the ledge above it, impossible.

   So the kick now fades out with how upward the aim is. A flat aim still gets
   pushed clear; an aim steeper than `clingFree` is taken completely literally,
   inward or not, because an upward aim is the player going over the top and
   they can see exactly where that leads. The fade is smooth, so there is no
   angle at which the control suddenly changes behaviour. */
function applyClingKick(ang, sp, out) {
  const nx = PS.clingSide;                 // +1 = wall on our left, push right
  const raw = Math.cos(ang) * sp;
  const vy = Math.sin(ang) * sp;
  const up = -Math.sin(ang);               // -1 straight down .. +1 straight up
  const bite = 1 - smoothstep(clamp(up / MOVE.clingFree, 0, 1));
  let vx = raw;
  if (bite > 0) {
    const want = lerp(MOVE.clingKick * sp, MOVE.clingKickMin, clamp(up, 0, 1));
    const outward = raw * nx;
    if (outward < want) vx = lerp(raw, raw + nx * (want - outward), bite);
  }
  out.x = vx; out.y = vy;
  return out;
}
const KICK = { x: 0, y: 0 };

/* Arm the ledge assist, if this launch off a hold was aimed up and over the
   top of the thing being held. Shared by the real launch and by the preview,
   so the dotted guide shows the same arc the player will fly. */
function armLedgeAssist(s, ang, sp) {
  s.ledgeDir = 0; s.ledgeT = 0;
  const up = -Math.sin(ang);
  if (up < MOVE.clingFree) return;                 // not an upward aim
  const inward = -PS.clingSide;                    // away from the face we hold
  if (Math.cos(ang) * inward <= 0) return;         // not aimed over the top
  s.ledgeDir = inward;
  s.ledgeT = MOVE.ledgeTime;
}

/* The one place a wind-up becomes motion. */
function doBurst(ang, power) {
  const fromNode = PS.state === 'node' && PS.node;
  const p = clamp(power, 0, 1);
  const sp = launchSpeed(p, fromNode);
  let vx = Math.cos(ang) * sp, vy = Math.sin(ang) * sp;

  if (PS.state === 'cling') {
    const k = applyClingKick(ang, sp, KICK);
    vx = k.x; vy = k.y;
    // the face we are leaving cannot catch us again for a moment
    body.noWall = PS.clingWall; body.noWallT = MOVE.wallRegrab;
    armLedgeAssist(body, ang, sp);
  }
  PS.support = null;
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
  // Kept for tests and statistics, shown nowhere. `totalBursts` used to be
  // declared and reset but never incremented, so the figure the end screen
  // printed was always zero — it counts for real now that nothing displays it.
  G.bursts++;
  G.totalBursts++;
  setHint('');
}

/* ============================================================
   8. GAME STATE
   ============================================================ */

/* ---- storage -------------------------------------------------------------
   localStorage is not guaranteed to exist and not guaranteed to work: it is
   absent on some embedded webviews, it throws on access under a strict privacy
   setting, and setItem throws when the quota is full. None of that is the
   player's problem, so every call goes through here and a failure is simply a
   session that does not persist. Once a write has failed we stop trying. */
const Store = {
  ok: true,
  get(key) {
    if (!this.ok) return null;
    try { return localStorage.getItem(GAME.storageKey + '.' + key); }
    catch (err) { this.ok = false; return null; }
  },
  set(key, value) {
    if (!this.ok) return false;
    try { localStorage.setItem(GAME.storageKey + '.' + key, value); return true; }
    catch (err) { this.ok = false; return false; }
  },
  del(key) {
    try { localStorage.removeItem(GAME.storageKey + '.' + key); } catch (err) {}
  },
};

/* ---- progress ------------------------------------------------------------
   The only thing worth keeping between sessions is how far the player got.

   Deliberately NOT saved: position, velocity, state, which mote was claimed —
   anything that could restore the game into a situation the player cannot get
   out of. Restarting a level always rebuilds it from the level data, so a save
   can never be the reason a level is unwinnable.

   `unlocked` is the furthest level that may be started, `done` is which ones
   have been finished. Both are clamped to the levels that actually exist, so a
   save written when the game had more levels than it does now still loads. */
const SAVE_V = 1;

const Save = {
  data: { v: SAVE_V, unlocked: 0, done: [] },
  fresh() { return { v: SAVE_V, unlocked: 0, done: [] }; },
  load() {
    this.data = this.fresh();
    const raw = Store.get('progress');
    if (!raw) return this.data;
    try {
      const o = JSON.parse(raw);
      // anything we do not recognise is discarded rather than trusted: a bad
      // save must cost the player their progress at worst, never the game
      if (o && o.v === SAVE_V) {
        this.data.unlocked = clamp(o.unlocked | 0, 0, LEVELS.length - 1);
        if (Array.isArray(o.done)) {
          this.data.done = o.done.filter(
            (i) => Number.isInteger(i) && i >= 0 && i < LEVELS.length);
          // A save that finished the old six-level game now opens chapter seven.
          for (const i of this.data.done) this.data.unlocked = Math.max(this.data.unlocked, Math.min(i + 1, LEVELS.length - 1));
        }
      }
    } catch (err) { /* corrupt or foreign: start clean, and keep playing */ }
    return this.data;
  },
  write() { return Store.set('progress', JSON.stringify(this.data)); },
  /* the furthest level the player may start on — always a real index */
  unlocked() { return clamp(this.data.unlocked, 0, LEVELS.length - 1); },
  completed(i) { return this.data.done.indexOf(i) >= 0; },
  /* Finishing a level unlocks the next one. The mark never moves backwards,
     so replaying an early level cannot cost the player what they have done. */
  complete(i) {
    if (i < 0 || i >= LEVELS.length) return;
    if (!this.completed(i)) this.data.done.push(i);
    const next = clamp(i + 1, 0, LEVELS.length - 1);
    if (next > this.data.unlocked) this.data.unlocked = next;
    this.write();
  },
  reset() { this.data = this.fresh(); Store.del('progress'); },
};

const G = {
  phase: 'play',          // play | win | trans | done
  t: 0,
  phaseT: 0,
  levelIndex: 0,
  level: null,
  bursts: 0,
  totalBursts: 0,       // run total, across levels and retries — internal only
  runTime: 0,
  spawnX: 0, spawnY: 0,   // the last claimed mote, or the level start
  deaths: 0,
  transDir: 0, transT: 0, transDur: 0.42, transNext: null,
  fadeIn: 0,
  deny: 0,
};

const cam = {
  x: 0, y: 0, tx: 0, ty: 0,
  mode: 'rest', settleT: 0,
  shake: 0, sx: 0, sy: 0,
  kx: 0, ky: 0,           // directional impulse from a launch or a slam
  zoom: 1, tzoom: 1, punch: 0,
  flash: 0, flashCol: [255, 255, 255],
};

/* ---- DOM ---- */
const dom = {
  canvas: document.getElementById('game'),
  levelNum: document.getElementById('levelNum'),
  levelName: document.getElementById('levelName'),
  levelTot: document.getElementById('levelTot'),
  progress: document.getElementById('progressFill'),
  restart: document.getElementById('restartBtn'),
  banner: document.getElementById('banner'),
  bannerNum: document.querySelector('.banner-num'),
  bannerName: document.querySelector('.banner-name'),
  hint: document.getElementById('hint'),
  toast: document.getElementById('toast'),
  endCard: document.getElementById('endCard'),
  endRestart: document.getElementById('endRestart'),
  endTime: document.getElementById('endTime'),
  endLevels: document.getElementById('endLevels'),
  fps: document.getElementById('fps'),
  sound: document.getElementById('soundBtn'),
};
const ctx = dom.canvas.getContext('2d');

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/* The whole HUD, in one place.

   There is no leap counter. It used to sit here as an icon and a number, and
   it was pure clutter: nothing in the game is rationed by leaps, so the figure
   never told the player anything they could act on, and on a narrow phone it
   squeezed the level name into an ellipsis. The count is still kept on `G` for
   tests and statistics — it is simply not shown anywhere.

   The total comes from LEVELS.length every time it is written, so adding a
   level is adding a level, with nothing else to remember. */
function updateHud() {
  const i = G.levelIndex;
  dom.levelNum.textContent = pad2(i + 1);
  dom.levelTot.textContent = pad2(LEVELS.length);
  dom.levelName.textContent = LEVELS[i].name;
  dom.progress.style.width = ((i + 1) / LEVELS.length * 100) + '%';
}

/* One pass at boot writes the name and every fixed label onto the page. The
   markup ships with none of them, so there is nowhere for a stale title or an
   untranslated label to hide. */
function applyBranding() {
  const el = (id) => document.getElementById(id);
  const setText = (id, v) => { const n = el(id); if (n) n.textContent = v; };
  const setAttr = (id, k, v) => { const n = el(id); if (n && n.setAttribute) n.setAttribute(k, v); };

  document.title = GAME.title;
  setText('markName', GAME.title);
  setText('menuTitle', GAME.title);
  setText('menuTagline', TEXT.tagline);
  setText('endTitle', GAME.title);
  setAttr('game', 'aria-label', GAME.title + ' ' + TEXT.canvasLabel);

  setText('markSub', TEXT.tagline);
  setText('markKeys', TEXT.controls);
  setText('hudLevelKey', TEXT.hudLevel);
  setText('endSub', TEXT.endSub);
  setText('endTimeLabel', TEXT.endTime);
  setText('endLevelLabel', TEXT.endLevels);
  setText('endRestart', TEXT.replay);
  setAttr('soundBtn', 'aria-label', TEXT.sound);
  setAttr('restartBtn', 'aria-label', TEXT.restart);

  const root = document.documentElement;
  if (root && root.setAttribute) root.setAttribute('lang', GAME.lang);
  const meta = document.querySelector && document.querySelector('meta[name="description"]');
  if (meta && meta.setAttribute) meta.setAttribute('content', TEXT.description);
}
function showBanner(i) {
  const L = LEVELS[i];
  dom.bannerNum.textContent = pad2(i + 1);
  dom.bannerName.textContent = L.name;
  dom.banner.classList.remove('show');
  void dom.banner.offsetWidth;
  dom.banner.classList.add('show');
}
function showToast(msg, opts) {
  const o = opts || {};
  dom.toast.textContent = msg;
  dom.toast.classList.remove('hidden', 'show', 'quick', 'info');
  void dom.toast.offsetWidth;
  dom.toast.classList.add('show');
  if (o.quick) dom.toast.classList.add('quick');
  if (o.info) dom.toast.classList.add('info');
}
function setHint(text) {
  if (text) { dom.hint.textContent = text; dom.hint.classList.remove('hidden'); }
  else dom.hint.classList.add('hidden');
}

/* Put the spirit down at a point, fully reset, and let it reform. */
function placeSpirit(x, y) {
  PS.support = null;
  body.x = x; body.y = y; body.vx = 0; body.vy = 0; body.burst = 0;
  PS.state = 'spawn'; PS.t = 0; PS.prev = 'spawn';
  PS.coyote = 0; PS.clingT = 0; PS.clingSide = 0; PS.node = null;
  PS.speed = 0; PS.facing = -Math.PI / 2; PS.fallT = 0;
  Aim.clear();
  clearBuffer();
  springLoop.clear();
  Vis.reset(x, y);
}

function startLevel(i) {
  G.menu = false;
  document.getElementById('ui').inert = false;
  dom.endCard.inert = false;
  document.getElementById('menuCard').classList.add('hidden');
  dom.endCard.classList.add('hidden');
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
  dom.endTime.textContent = Math.floor(secs / 60) + ':' + pad2(secs % 60);
  dom.endLevels.textContent = LEVELS.length + ' / ' + LEVELS.length;
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
  if (G.menu || G.phase === 'done' || G.transDir !== 0) return;
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
  for (const e of world.solids) { e.crumbleT = -1; e.broken = false; }
  placeSpirit(G.spawnX, G.spawnY);
  G.fadeIn = 0.12;
  FX.implode(G.spawnX, G.spawnY, 54, 9, HUE.spirit.hi, 0.34);
  Sfx.respawn();
  updateCamera(true);
}

function reachGate() {
  G.phase = 'win'; G.phaseT = 0;
  G.goalBurst = false;
  // banked here rather than on the transition, so a level counts the moment it
  // is actually finished and a refresh mid-transition cannot lose it
  Save.complete(G.levelIndex);
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
  if (G.menu) return;
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
    // if this ever fires it is a lost pointer, so say so rather than going
    // quiet: a control that stops responding without a sign is unfixable by
    // the player, who has no idea anything happened
    if (Aim.held >= MOVE.aimHold) { cancelAim(); G.deny = 1; }
    updateCamera(false);
    return;
  }

  G.t += STEP;
  if (G.phase !== 'done') G.runTime += STEP;
  G.phaseT += STEP;

  updateMotion(G.t);
  if (PS.state === 'ground' && PS.support && !PS.support.broken) {
    body.x += PS.support.vx; body.y += PS.support.vy;
    // Translation is applied exactly once. Contact velocity stays relative.
    body.vy = 0;
  }
  for (const e of world.solids) if (e.crumble && e.crumbleT >= 0 && !e.broken) {
    e.crumbleT += STEP;
    if (e.crumbleT >= e.crumble) {
      e.broken = true;
      FX.spark(e.x,e.y,-Math.PI/2,Math.PI,2.5,8,HUE.stone.rgb,{life:.5,size:3,grav:.15});
      Sfx.crack();
      if (PS.support === e) { PS.support = null; PS.set('air'); PS.coyote = MOVE.coyote; }
    }
  }
  Sfx.environment(G.phase === 'play' ? world.winds.some(w => Math.abs(body.x-w.x)<w.w/2+100 && Math.abs(body.y-w.y)<w.h/2+100) : false);
  for (const b of world.beams) b.k = beamLevel(b, G.t);
  for (const n of world.nodes) {
    if (n.cool > 0) n.cool = Math.max(0, n.cool - STEP);
    if (n.glow > 0) n.glow = Math.max(0, n.glow - STEP * 2);
    n.spin += STEP * (n.cool > 0 ? 0.6 : 1.8);
  }
  for (const s of world.springs) {
    if (s.fire > 0) s.fire = Math.max(0, s.fire - STEP * 2.6);
    if (s.cool > 0) s.cool = Math.max(0, s.cool - STEP);
  }
  releaseSprings(body.x, body.y, body.r);
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
    if (!G.goalBurst && G.phaseT > .34) {
      G.goalBurst = true;
      const finale = G.levelIndex === LEVELS.length - 1;
      FX.spark(g.x,g.y,0,Math.PI,finale?6:4,finale?22:12,HUE.gate.hi,{life:.65,size:2.6,drag:.94});
      FX.shock(g.x,g.y,20,finale?210:140,.55,HUE.gate.rgb,3);
    }
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
    ledgeAssist(body);
  }

  const r = stepBody(body, true);

  if (r.lethal) { killSpirit(r.lethal.kind === 'void' ? 'void' : 'hazard'); return; }

  if (r.spring) {
    const s = r.spring;
    // Exactly one launch event per contact: the spring locked itself as it
    // fired, so everything below — the sound, the shockwave, the shake —
    // happens once and cannot be retriggered while the spirit is still on it.
    if (springLoop.count(s)) s.off = true;
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
    PS.support = r.floorE;
    if (PS.support && PS.support.crumble && PS.support.crumbleT < 0) {
      PS.support.crumbleT = 0; Sfx.crack();
    }
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
    body.ledgeDir = 0; body.ledgeT = 0;
    PS.coyote = MOVE.coyote;
    PS.clingT = 0;
    if (PS.support && PS.support.motion) body.vy = 0;
    body.vx *= MOVE.groundDrag;
    if (Math.abs(body.vx) < MOVE.groundStop) body.vx = 0;
  } else if (r.wallHold) {
    // taking hold of a wall for the first time; the hold itself is run above
    if (PS.state !== 'cling') {
      PS.set('cling');
      PS.clingT = 0;
      PS.clingSide = RES.wallNx < 0 ? -1 : 1;
      PS.clingWall = RES.wallE;
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
  if (!wasAimable && canAim()) { Vis.onReady(); springLoop.clear(); }
  updateAimBuffer();
}

/* ---- camera -------------------------------------------------------------
   One system owns the camera, and it has four modes:

     REST    standing or holding, nothing happening. Normal framing.
     AIM     a stretch is being held. Lead toward the LAUNCH direction — the
             finger is behind the spirit, the information is in front of it —
             and ease out so more of the world ahead is visible.
     TRAVEL  airborne. Follow with mild anticipation.
     SETTLE  just arrived. Ease back to normal framing.

   Everything the camera does is decided here and nowhere else. The target and
   the rendered value are kept separate — gameplay writes `cam.tx/ty/tzoom`,
   and exactly one smoothing step moves `cam.x/y/zoom` toward them — so no two
   systems can pull the zoom in different directions on the same frame.

   Crucially, nothing in here feeds back into the aim. The aim is measured in
   screen space (see section 10) and cannot be affected by where the camera is
   or how far it has zoomed, which is what makes the view able to move while a
   held stretch stays perfectly still. */
const CAM_PAD = 95;   // how far past the world edge the view may drift

function cameraMode() {
  if (Aim.on && Aim.pullLen > MOVE.dragDead) return 'aim';
  if (PS.state === 'air' || PS.speed > MOVE.camTravelSpeed) return 'travel';
  return cam.settleT > 0 ? 'settle' : 'rest';
}

function updateCamera(snap) {
  const mode = cameraMode();
  if (mode !== cam.mode) {
    // leaving a moving mode starts the settle, so the return to normal framing
    // is a deliberate ease rather than a jump
    if ((cam.mode === 'aim' || cam.mode === 'travel') && mode !== 'aim' && mode !== 'travel') {
      cam.settleT = MOVE.camSettle;
    }
    cam.mode = mode;
  }
  if (cam.settleT > 0) cam.settleT = Math.max(0, cam.settleT - STEP);

  let tx = body.x, ty = body.y, zoom = 1, ease = MOVE.camEase;

  if (mode === 'aim') {
    // lead along the launch vector: the direction the spirit will actually go,
    // which is the opposite of where the finger is being pulled
    const lead = lerp(MOVE.camLeadMin, MOVE.camLead, Aim.power);
    tx += Math.cos(Aim.angle) * lead;
    ty += Math.sin(Aim.angle) * lead;
    zoom = lerp(1, MOVE.zoomAim, Aim.power);
    ease = MOVE.camEaseAim;
  } else if (mode === 'travel') {
    tx += clamp(body.vx * MOVE.camFollow, -200, 200);
    ty += clamp(body.vy * MOVE.camFollow, -170, 250);
    zoom = lerp(1, MOVE.zoomFast, clamp(PS.speed / MOVE.burstMax, 0, 1));
    ease = MOVE.camEase;
  } else {
    ease = mode === 'settle' ? MOVE.camEase : MOVE.camEaseRest;
  }
  ty -= 30;                        // a little more sky than floor

  // However far the view wants to lead, the spirit has to stay comfortably on
  // screen — it sits in the rear portion of the frame, never off the edge of
  // it. Leading past this point stops showing the player their character,
  // which is worse than not showing them the destination.
  const halfW = VW / (2 * zoom), halfH = VH / (2 * zoom);
  tx = body.x + clamp(tx - body.x, -halfW * MOVE.camHold, halfW * MOVE.camHold);
  ty = body.y + clamp(ty - body.y, -halfH * MOVE.camHold, halfH * MOVE.camHold);

  // Keep the view inside the world, allowing for the fact that zooming out
  // shows more of it. The bounds are padded rather than hard: clamping exactly
  // to the world put the spirit against the very edge of the screen whenever
  // it took hold of a boundary wall, with its aim ring half cut off.
  const hw = halfW - CAM_PAD, hh = halfH - CAM_PAD;
  tx = world.w <= hw * 2 ? world.w / 2 : clamp(tx, hw, world.w - hw);
  ty = world.h <= hh * 2 ? world.h / 2 : clamp(ty, hh, world.h - hh);

  cam.tx = tx; cam.ty = ty; cam.tzoom = zoom;
  if (snap) { cam.x = tx; cam.y = ty; cam.zoom = zoom; return; }
  cam.x += (tx - cam.x) * ease;
  cam.y += (ty - cam.y) * ease;
  // The single smoothing step for zoom. It lives here rather than in the world
  // step because a held stretch skips the rest of the step entirely, and the
  // view still has to finish settling while the player decides.
  cam.zoom += (cam.tzoom + cam.punch - cam.zoom) * MOVE.zoomEase;
}

/* ============================================================
   9. RENDERING
   ============================================================ */

let RS = 1;
let fitPending = false;          // a resize deferred until the drag ends
let canvasRect = { left: 0, top: 0, width: VW, height: VH };

function fit() {
  const rect = canvasRect = dom.canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  // Reassigning the backing store mid-gesture throws away pointer capture and
  // can interrupt a drag the player is in the middle of. Nothing here is
  // urgent, so it waits until their hand is off the screen.
  if (Aim.on) { fitPending = true; return; }
  fitPending = false;
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
  if (e.broken) return;
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
    // Loading the shot: the spirit leans back along the pull and squashes
    // toward it, so the stretch is felt on the character and not only in the
    // band. It leans, it does not move — the body position never drifts.
    const a = Aim.angle + Math.PI;
    ox = Math.cos(a) * Aim.power * 11;
    oy = Math.sin(a) * Aim.power * 11;
    stretch = Aim.power * 0.24;
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
    const wob = Math.sin(Vis.pulse * 2.3 + i * 1.9) * (PS.state === 'node' ? .15 : .08);
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
  const sp = launchSpeed(Aim.power, fromNode);
  if (PS.state === 'cling') return applyClingKick(Aim.angle, sp, out);
  out.x = Math.cos(Aim.angle) * sp;
  out.y = Math.sin(Aim.angle) * sp;
  return out;
}
const AIMV = { x: 0, y: 0 };

function refreshAimPreview() {
  if (!Aim.on || Aim.pullLen <= MOVE.dragDead) { preview.n = 0; return; }
  const v = aimVelocity(AIMV);
  // a preview from a hold gets the same re-grab cooldown the real leap will
  probe.noWall = PS.state === 'cling' ? PS.clingWall : null;
  probe.noWallT = PS.state === 'cling' ? MOVE.wallRegrab : 0;
  probe.ledgeDir = 0; probe.ledgeT = 0;
  if (PS.state === 'cling') armLedgeAssist(probe, Aim.angle, Math.hypot(v.x, v.y));
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

function drawAim(c) {
  if (!Aim.on || Aim.pullLen <= MOVE.dragDead) return;
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

  /* Two pieces of information, on two sides of the spirit, so the reversal is
     never something the player has to do in their head.

     BEHIND: the elastic. A tensioning line trailing back along the pull, with
     a handle on the end. It thickens and brightens as the stretch grows, and
     it is drawn from the stretch vector rather than from the raw pointer, so
     it stays rock steady while the camera moves.

     AHEAD:  the launch. The arc, the landing ring above, and an arrow. */
  const back = a + Math.PI;
  const R = body.r + 14 + p * 8;
  const pullLen = R + 16 + p * 62;
  const bx = body.x + Math.cos(back) * pullLen;
  const by = body.y + Math.sin(back) * pullLen;
  const eg = c.createLinearGradient(body.x, body.y, bx, by);
  eg.addColorStop(0, rgba(col.hi, 0.5 + p * 0.3));
  eg.addColorStop(1, rgba(col.rgb, 0.08));
  c.strokeStyle = eg;
  c.lineWidth = lerp(2.4, 6, p);       // the band thickens as it is stretched
  c.lineCap = 'round';
  c.beginPath(); c.moveTo(body.x, body.y); c.lineTo(bx, by); c.stroke();
  c.fillStyle = rgba(col.hi, 0.35 + p * 0.4);
  c.beginPath(); c.arc(bx, by, 3.5 + p * 3.5, 0, TAU); c.fill();

  // the launch arrow, ahead of the spirit, growing with the stretch
  const fx = body.x + Math.cos(a) * (R + 10 + p * 34);
  const fy = body.y + Math.sin(a) * (R + 10 + p * 34);
  const fg = c.createLinearGradient(body.x, body.y, fx, fy);
  fg.addColorStop(0, rgba(col.rgb, 0.1));
  fg.addColorStop(1, rgba(col.hi, 0.55 + p * 0.35));
  c.strokeStyle = fg;
  c.lineWidth = lerp(2, 4.5, p);
  c.beginPath(); c.moveTo(body.x, body.y); c.lineTo(fx, fy); c.stroke();

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


function drawEnvironment(c) {
  for (const e of world.solids) {
    if (e.broken || !inView(e)) continue;
    if (e.motion) {
      c.strokeStyle='rgba(100,225,255,.3)'; c.lineWidth=2; c.setLineDash([5,9]);
      c.beginPath(); c.moveTo(e.bx-(e.motion.dx||0),e.by-(e.motion.dy||0));
      c.lineTo(e.bx+(e.motion.dx||0),e.by+(e.motion.dy||0)); c.stroke(); c.setLineDash([]);
      c.strokeStyle='#80dff7'; c.strokeRect(e.x-e.w/2+5,e.y-e.h/2+5,e.w-10,5);
    }
    if (e.crumble) {
      const k=e.crumbleT<0?0:clamp(e.crumbleT/e.crumble,0,1);
      c.save(); c.translate(e.x+Math.sin(G.t*65)*k*2,e.y-e.h/2);
      c.strokeStyle=k>.5?'#ffc09a':'#b5a2d6'; c.lineWidth=2;
      for(let j=-1;j<=1;j++) { const x=j*e.w*.28; c.beginPath(); c.moveTo(x,-1); c.lineTo(x-9,9); c.lineTo(x+4,17); c.lineTo(x-8,25+k*25); c.stroke(); }
      if(k) { c.fillStyle='#ffd0a1'; c.fillRect(-e.w/2,-7,e.w*(1-k),3); }
      c.restore();
    }
  }
  for (const w of world.winds) {
    if (Math.abs(w.x-cam.x)>w.w/2+VW/cam.zoom || Math.abs(w.y-cam.y)>w.h/2+VH/cam.zoom) continue;
    c.fillStyle='rgba(75,213,222,.035)'; c.fillRect(w.x-w.w/2,w.y-w.h/2,w.w,w.h);
    c.strokeStyle='rgba(137,235,240,.4)'; c.lineWidth=1.5;
    const len=Math.hypot(w.dx,w.dy)||1, dx=w.dx/len,dy=w.dy/len;
    for(let j=0;j<22;j++) {
      const x=w.x-w.w/2+((j*97+G.t*dx*75)%w.w+w.w)%w.w;
      const y=w.y-w.h/2+((j*137+G.t*dy*75)%w.h+w.h)%w.h;
      c.beginPath(); c.moveTo(x-dx*18,y-dy*18); c.lineTo(x,y);
      c.lineTo(x-dx*6-dy*4,y-dy*6+dx*4); c.moveTo(x,y);
      c.lineTo(x-dx*6+dy*4,y-dy*6-dx*4); c.stroke();
    }
  }
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
  drawEnvironment(c);
  drawGate(c, world.gate);

  drawReady(c);
  drawAim(c);
  const pose = Player.syncPose();
  if (Player.rig) Player.rig.sync(pose, c); else drawSpirit(c);
  drawParticles(c);
  if (DEV && devOverlay) drawDebug(c);

  c.restore();

  if (DEV && devOverlay) drawDebugHud(c);
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
   9b. LEVEL-DESIGN DEBUG VIEW  (?dev=1 only)
   ============================================================
   Everything a level needs tuning against, drawn on top of the level itself:
   collision boxes as the simulation sees them, the paths moving ground
   actually travels, where a spring's trigger region starts and which way it
   throws, how far a node can catch from, the bounds of every current, and the
   route the level declares — the same waypoints the tests fly.

   Nothing here is on for a player. `DEV` is set only by an explicit ?dev=1,
   it persists in its own storage key, and ?dev=0 removes it.

     G   overlay on/off        H   declared route on/off
     arrow keys   previous / next level        R   restart
     ?level=10&dev=1           jump straight to a level

   Drawn in world space, inside the camera transform, except the readout. */
let devOverlay = true, devRoute = true;

function devBox(c, e, col, dash) {
  c.save();
  c.translate(e.x, e.y);
  if (e.a) c.rotate(e.a);
  c.strokeStyle = col; c.lineWidth = 1.5;
  if (dash) c.setLineDash(dash);
  c.strokeRect(-e.w / 2, -e.h / 2, e.w, e.h);
  c.restore();
}

function drawDebug(c) {
  c.save();
  c.setLineDash([]);

  // solids: the boxes the simulation collides against, and their landing edge
  for (const e of world.solids) {
    if (e.broken) continue;
    devBox(c, e, e.crumble ? 'rgba(255,170,120,.75)' : e.motion ? 'rgba(120,235,255,.75)' : 'rgba(120,255,180,.5)');
    if (!e.a) {
      c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(e.x - e.w / 2, e.y - e.h / 2); c.lineTo(e.x + e.w / 2, e.y - e.h / 2); c.stroke();
    }
    // the full travel of moving ground, as a box plus its two end positions
    if (e.motion && e.motion.type === 'osc') {
      const dx = e.motion.dx || 0, dy = e.motion.dy || 0;
      c.strokeStyle = 'rgba(120,235,255,.35)'; c.lineWidth = 1; c.setLineDash([6, 6]);
      c.strokeRect(e.bx - e.w / 2 - Math.abs(dx), e.by - e.h / 2 - Math.abs(dy),
                   e.w + Math.abs(dx) * 2, e.h + Math.abs(dy) * 2);
      c.beginPath(); c.moveTo(e.bx - dx, e.by - dy); c.lineTo(e.bx + dx, e.by + dy); c.stroke();
      c.setLineDash([]);
    }
  }

  // hazards, at the radius they are actually tested against
  for (const e of world.lethal) {
    devBox(c, e, 'rgba(255,66,116,.85)');
    const k = e.k === undefined ? 1 : e.k;
    if (e.pulse) {
      c.fillStyle = k > 0.35 ? 'rgba(255,66,116,.9)' : 'rgba(255,66,116,.3)';
      c.fillRect(e.x - 3, e.y - e.h / 2 - 16, 6, 10);
    }
  }

  // springs: the trigger box, and the direction the throw actually goes
  for (const s of world.springs) {
    devBox(c, s, s.off ? 'rgba(140,140,140,.7)' : 'rgba(120,255,170,.9)');
    c.strokeStyle = 'rgba(120,255,170,.4)'; c.lineWidth = 1; c.setLineDash([4, 4]);
    c.strokeRect(s.x - s.w / 2 - MOVE.springExit, s.y - s.h / 2 - MOVE.springExit,
                 s.w + MOVE.springExit * 2, s.h + MOVE.springExit * 2);
    c.setLineDash([]);
    const nx = s.sa, ny = -s.ca;
    c.strokeStyle = '#7fffbe'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(s.x + nx * 70, s.y + ny * 70); c.stroke();
  }

  // nodes: the catch radius, which is the target the player is really aiming at
  for (const n of world.nodes) {
    c.strokeStyle = n.cool > 0 ? 'rgba(140,140,140,.6)' : 'rgba(255,190,90,.8)';
    c.lineWidth = 1.5;
    c.beginPath(); c.arc(n.x, n.y, MOVE.nodeReach, 0, TAU); c.stroke();
  }

  // checkpoints: the mote, and where a respawn actually puts the spirit
  for (const m of world.motes) {
    c.strokeStyle = m.got ? 'rgba(200,160,255,.5)' : 'rgba(200,160,255,.9)';
    c.lineWidth = 1.5;
    c.beginPath(); c.arc(m.x, m.y, m.r, 0, TAU); c.stroke();
    c.beginPath(); c.arc(m.x, m.y - 26, 5, 0, TAU); c.stroke();
  }

  // currents: bounds and direction
  for (const w of world.winds) {
    c.strokeStyle = 'rgba(110,240,235,.7)'; c.lineWidth = 1.5;
    c.strokeRect(w.x - w.w / 2, w.y - w.h / 2, w.w, w.h);
    const len = Math.hypot(w.dx, w.dy) || 1;
    c.beginPath(); c.moveTo(w.x, w.y);
    c.lineTo(w.x + (w.dx / len) * 60, w.y + (w.dy / len) * 60); c.stroke();
  }

  // the declared route: what the reachability tests actually fly
  const L = LEVELS[G.levelIndex];
  if (devRoute && L && L.route) {
    c.strokeStyle = 'rgba(255,255,255,.45)'; c.lineWidth = 2; c.setLineDash([9, 7]);
    c.beginPath();
    let started = false;
    for (const wp of L.route) {
      if (wp[2] === 'gate') { c.lineTo(world.gate.x, world.gate.y); break; }
      if (started) c.lineTo(wp[0], wp[1]); else { c.moveTo(wp[0], wp[1]); started = true; }
    }
    c.stroke(); c.setLineDash([]);
    for (const wp of L.route) {
      if (wp[2] === 'gate') continue;
      c.fillStyle = wp[2] === 'cling' ? '#9fd8ff' : wp[2] === 'node' ? '#ffbe5a'
        : wp[2] === 'spring' ? '#7fffbe' : '#ffffff';
      c.beginPath(); c.arc(wp[0], wp[1], 6, 0, TAU); c.fill();
    }
  }

  // the spirit's own body and the reach it is aiming with
  c.strokeStyle = 'rgba(255,255,255,.8)'; c.lineWidth = 1.5;
  c.beginPath(); c.arc(body.x, body.y, body.r, 0, TAU); c.stroke();
  c.restore();
}

/* The readout, in screen space: where we are, and what the world is doing. */
function drawDebugHud(c) {
  const L = LEVELS[G.levelIndex];
  const lines = [
    `L${G.levelIndex + 1}/${LEVELS.length} ${L ? L.name : ''}  world ${world.w}x${world.h}`,
    `spirit ${body.x.toFixed(0)},${body.y.toFixed(0)}  v ${body.vx.toFixed(1)},${body.vy.toFixed(1)}  ${PS.state}`,
    `cam ${cam.x.toFixed(0)},${cam.y.toFixed(0)}  zoom ${cam.zoom.toFixed(2)}  t ${G.t.toFixed(1)}s`,
    `spawn ${G.spawnX.toFixed(0)},${G.spawnY.toFixed(0)}  deaths ${G.deaths}  bursts ${G.bursts}`,
    Aim.on ? `aim ${(Aim.angle * 180 / Math.PI).toFixed(0)}deg  power ${Aim.power.toFixed(2)}` : 'G overlay · H route · arrows level · R restart',
  ];
  c.save();
  c.font = '11px ui-monospace, monospace';
  c.textAlign = 'left'; c.textBaseline = 'top';
  c.fillStyle = 'rgba(5,6,15,.62)';
  c.fillRect(8, 92, 330, lines.length * 14 + 10);
  c.fillStyle = '#cfe6ff';
  lines.forEach((t, i) => c.fillText(t, 14, 97 + i * 14));
  c.restore();
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

/* ---- pointer -> virtual screen ------------------------------------------
   Aiming is measured in VIRTUAL SCREEN UNITS — the fixed 540 x 960 box the
   game is composed in — and never in world units.

   This matters more than it looks. Converting the pointer through the camera
   made the aim depend on the zoom, while the zoom depended on the aim: pull
   harder, the view zooms out, the same finger position now maps to a different
   world point, so the power changes, so the zoom changes again. That is the
   breathing/pumping the camera was doing, and no amount of smoothing fixes a
   loop — the loop has to be cut. Screen-space aim cuts it: the camera reads
   the aim and the aim never reads the camera.

   Working in a fixed virtual box also makes the gesture resolution independent:
   the same swipe across a third of the screen is the same leap on any phone. */
const gp = { x: 0, y: 0 };
function toScreen(e) {
  gp.x = (e.clientX - canvasRect.left) * (VW / canvasRect.width);
  gp.y = (e.clientY - canvasRect.top) * (VH / canvasRect.height);
  return gp;
}

let pointerId = null;
const buffered = { on: false, t: 0, id: null, sx: VW / 2, sy: VH / 2 };
function clearBuffer() { buffered.on = false; buffered.id = null; }

/* The slingshot. You pull BACKWARD, away from where you want to go, and the
   spirit launches along the opposite vector — like stretching something
   elastic anchored to it. The pull is entirely screen-space: `Aim.sx/sy` is
   where the finger went down, and everything else is derived from the offset
   from that anchor.

   `Aim.pull` is the raw stretch, 0..1 of the usable drag distance; `Aim.power`
   is what the game uses. They are different on purpose — see powerCurve. */
function updateDrag(px, py) {
  const dx = px - Aim.sx, dy = py - Aim.sy;        // the pull, screen units
  const d = Math.hypot(dx, dy);
  Aim.px = px; Aim.py = py;
  Aim.pullLen = d;
  if (d <= MOVE.dragDead) { Aim.pull = 0; Aim.power = 0; Sfx.tensionUpdate(0); return; }
  Aim.pull = clamp((d - MOVE.dragDead) / (MOVE.dragFull - MOVE.dragDead), 0, 1);
  Aim.power = powerCurve(Aim.pull);
  Aim.angle = Math.atan2(-dy, -dx);                // launch is the mirror of the pull
  Sfx.tensionUpdate(Aim.power);
}

function beginAim(sx, sy, id) {
  Aim.on = true;
  Aim.from = PS.state;
  Aim.sx = sx; Aim.sy = sy;
  Aim.px = sx; Aim.py = sy;
  Aim.held = 0;
  Aim.pull = 0; Aim.power = 0; Aim.pullLen = 0;
  Aim.angle = PS.state === 'cling' ? (PS.clingSide > 0 ? 0 : Math.PI) : -Math.PI / 2;
  lastPvx = NaN;
  pointerId = id;
  if (id !== null && id !== undefined && dom.canvas.setPointerCapture) {
    try { dom.canvas.setPointerCapture(id); } catch (err) {}
  }
  Sfx.tensionStart();
  setHint('');
}

/* Take hold of a node. It draws the spirit in AT THE MOMENT OF THE CATCH, not
   gradually while the player aims: a character that keeps drifting under a held
   aim makes the whole gesture feel slippery, and the catch reads better as a
   snap with a streak behind it anyway. */
function grabNode(n, px, py, id) {
  PS.node = n;
  PS.set('node');
  n.glow = 1;
  FX.spark(body.x, body.y, Math.atan2(n.y - body.y, n.x - body.x), 0.3,
           Math.hypot(n.x - body.x, n.y - body.y) / 9, 5, HUE.node.hi,
           { life: 0.3, size: 2.2, shape: 1, len: 16, drag: 0.82 });
  body.x = n.x; body.y = n.y;
  body.vx = 0; body.vy = 0; body.burst = 0;
  FX.shock(n.x, n.y, n.r * 2.2, n.r * 0.8, 0.3, HUE.node.rgb, 2);
  FX.spark(n.x, n.y, 0, Math.PI, 1.8, 6, HUE.node.hi, { life: 0.4, size: 2, drag: 0.9 });
  cam.punch = 0.035;
  Sfx.nodeCatch();
  beginAim(px, py, id);
}

function onDown(e) {
  if (G.menu) return;
  if (Aim.on || (e.button !== undefined && e.button !== 0)) return;
  if (buffered.on && e.pointerId !== buffered.id) return;
  Sfx.unlock();
  clearBuffer();
  if (G.phase === 'done') return;
  if (e.target === dom.restart || dom.restart.contains(e.target)) return;
  if (G.phase !== 'play') return;
  if (PS.state === 'hurt' || PS.state === 'spawn') return;

  canvasRect = dom.canvas.getBoundingClientRect();
  const p = toScreen(e);

  if (canAim()) {
    // The stretch is measured from wherever the finger went down, so a press
    // always starts at zero power whatever it landed on, and the gesture is
    // identical whether the player touched the spirit or anywhere else.
    beginAim(p.x, p.y, e.pointerId);
    e.preventDefault();
    return;
  }

  const n = nodeInReach();
  if (n) { grabNode(n, p.x, p.y, e.pointerId); e.preventDefault(); return; }

  // Nothing to act on yet. Hold the press briefly: if a wall, the ground or a
  // node arrives within the buffer window, it is spent there instead of lost.
  if (PS.state === 'air') {
    buffered.on = true; buffered.t = 0; buffered.id = e.pointerId;
    buffered.sx = p.x; buffered.sy = p.y;
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
    const id = buffered.id, sx = buffered.sx, sy = buffered.sy;
    clearBuffer();
    beginAim(sx, sy, id);          // the stretch restarts from where the finger is
    return;
  }
  const n = nodeInReach();
  if (n) {
    const id = buffered.id, sx = buffered.sx, sy = buffered.sy;
    clearBuffer(); grabNode(n, sx, sy, id); return;
  }
  if (buffered.t >= MOVE.buffer) { clearBuffer(); G.deny = 1; }
}

function onMove(e) {
  if (buffered.on && e.pointerId === buffered.id) { e.preventDefault(); return; }
  if (!Aim.on || (pointerId !== null && e.pointerId !== pointerId)) return;
  const p = toScreen(e);
  updateDrag(p.x, p.y);
  e.preventDefault();
}

function onUp(e) {
  if (buffered.on && e.pointerId === buffered.id) { clearBuffer(); e.preventDefault(); return; }
  if (!Aim.on || (pointerId !== null && e.pointerId !== pointerId)) return;
  // The dead zone is the ONLY cancel rule. Judging the release on the power
  // value instead meant a pull just past the dead zone produced a power near
  // zero and was silently thrown away — the player had clearly asked for a
  // small hop and got nothing at all.
  const launched = Aim.pullLen > MOVE.dragDead;
  const p = Aim.power, a = Aim.angle;
  const ok = canAim();
  Aim.on = false;
  pointerId = null;
  Sfx.tensionStop();
  if (launched && ok) doBurst(a, p);
  else if (PS.state === 'node') { PS.node.cool = 0.5; PS.node = null; PS.set('air'); }
  Aim.power = 0; Aim.pull = 0; Aim.pullLen = 0;
  endGesture();
  e.preventDefault();
}

function endGesture() {
  if (fitPending) fit();
}

function cancelAim() {
  if (PS.state === 'node' && PS.node) { PS.node.cool = 0.5; PS.node = null; PS.set('air'); }
  Aim.clear();
  pointerId = null;
  clearBuffer();
  lastPvx = NaN;
  Sfx.tensionStop();
  endGesture();
}

dom.canvas.addEventListener('pointerdown', onDown, { passive: false });
window.addEventListener('pointermove', onMove, { passive: false });
window.addEventListener('pointerup', onUp, { passive: false });
window.addEventListener('pointercancel', cancelAim);
/* Deliberately NOT cancelling on `lostpointercapture`. Capture is a
   convenience, and losing it does not mean the player let go — the browser
   drops it whenever the canvas backing store is reassigned, which this game
   does on its own whenever the adaptive quality level changes or the window is
   resized. That turned a slow frame into a silently dead gesture. `pointerup`
   and `pointercancel` are the events that actually mean the gesture ended, and
   they are both handled on `window`, so they arrive with or without capture. */
window.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
window.addEventListener('touchmove', (e) => { if (!G.menu && e.cancelable) e.preventDefault(); }, { passive: false });

dom.restart.addEventListener('click', (e) => { e.stopPropagation(); Sfx.unlock(); restartLevel(); });

let muted = false;
function applyMute(v) {
  muted = v;
  Sfx.setMuted(v);
  dom.sound.classList.toggle('muted', v);
  dom.sound.setAttribute('aria-pressed', String(!v));
  Store.set('muted', v ? '1' : '0');
}
dom.sound.addEventListener('click', (e) => {
  e.stopPropagation(); applyMute(!muted); Sfx.unlock(); if (!muted) Sfx.ui();
});
dom.endRestart.addEventListener('click', () => { Sfx.unlock(); Sfx.ui(); restartRun(); });


function selectLevel(i) {
  if (!Number.isInteger(i) || i<0 || i>Save.unlocked()) return false;
  cancelAim(); G.transDir=0; G.transNext=null; doneFrames=0;
  Sfx.unlock(); Sfx.ui(); startLevel(i); return true;
}
function showMenu(select) {
  cancelAim(); G.menu=true; Sfx.environment(false);
  document.getElementById('ui').inert = true;
  dom.endCard.inert = true;
  const card=document.getElementById('menuCard'); card.classList.remove('hidden');
  document.getElementById('menuStart').textContent=Save.unlocked()>0?'DEVAM ET':'BAŞLA';
  document.getElementById('levelGrid').classList.toggle('hidden',!select);
  document.getElementById('menuBack').classList.toggle('hidden',!select);
  for(let i=0;i<LEVELS.length;i++) {
    const b=document.getElementById('chooseLevel'+i);
    b.disabled=i>Save.unlocked();
    b.textContent='BÖLÜM '+(i+1)+(b.disabled?' · Kilitli':Save.completed(i)?' · ✓':'');
    b.setAttribute('aria-label','Bölüm '+(i+1)+': '+LEVELS[i].name+(b.disabled?' · Kilitli':''));
  }
}
for(let i=0;i<LEVELS.length;i++) {
  const b=document.createElement('button'); b.id='chooseLevel'+i; b.type='button';
  b.addEventListener('click',()=>selectLevel(i)); document.getElementById('levelGrid').appendChild(b);
}
document.getElementById('menuStart').addEventListener('click',()=>selectLevel(Save.unlocked()));
document.getElementById('menuLevels').addEventListener('click',()=>showMenu(true));
document.getElementById('endSelect').addEventListener('click',()=>showMenu(true));
document.getElementById('levelsBtn').addEventListener('click',()=>showMenu(true));
document.getElementById('menuBack').addEventListener('click',()=>{
  G.menu=false;
  document.getElementById('menuCard').classList.add('hidden');
  document.getElementById('ui').inert=false;
  dom.endCard.inert=false;
});

const DEV = (() => {
  if (/[?&]dev=1/.test(location.search)) { Store.set('dev', '1'); return true; }
  if (/[?&]dev=0/.test(location.search)) { Store.del('dev'); return false; }
  return Store.get('dev') === '1';
})();

window.addEventListener('keydown', (e) => {
  if (!G.menu && (e.key === 'r' || e.key === 'R')) restartLevel();
  if (e.key === 'm' || e.key === 'M') { applyMute(!muted); Sfx.unlock(); }
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
  if (DEV && (e.key === 'g' || e.key === 'G')) devOverlay = !devOverlay;
  if (DEV && (e.key === 'h' || e.key === 'H')) devRoute = !devRoute;
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
  Sfx.suspend(document.hidden);
  cancelAnimationFrame(frameId);
  cancelAim();
  last = 0; acc = 0;
  Q.bad = 0; Q.good = 0;
  fpsFrames = 0; fpsSince = performance.now();
  if (!document.hidden) { fit(); frameId = requestAnimationFrame(frame); }
});

if (Store.get('muted') === '1') applyMute(true);
if (DEV) { fpsOn = true; dom.fps.classList.remove('hidden'); }

/* The page carries no name and no labels of its own; this is where it gets
   both, before the first frame is drawn. */
applyBranding();

/* Pick up where the player left off. Progress is only ever an INDEX — the
   level itself is rebuilt from its data, exactly as a restart would build it,
   so resuming and restarting land in the same place. */
Save.load();
/* ?level=N jumps straight to a level, for tuning one without playing to it.
   Developer mode only: without ?dev=1 it is ignored, so a shared link cannot
   unlock anything. */
const devJump = DEV && /[?&]level=(\d+)/.exec(location.search);
const resumeAt = devJump ? clamp(Number(devJump[1]) - 1, 0, LEVELS.length - 1) : Save.unlocked();
startLevel(resumeAt);
showMenu(false);
fit();
frameId = requestAnimationFrame(frame);

/* ---- debug / automation surface ---- */
/* Internal only — never player-facing, so it deliberately does NOT follow
   GAME.title: renaming the game must not break a bookmarked console call or
   the test harness. */
window.FLUX = {
  G, body, PS, Vis, Aim, world, LEVELS, MOVE, Q, Player, cam, Save, Store, TEXT, GAME, selectLevel, showMenu,
  go: (i) => startLevel(clamp(i | 0, 0, LEVELS.length - 1)),
  burst: (ang, power) => { if (canAim()) doBurst(ang, clamp(power, 0, 1)); },
  tick: (n) => { for (let i = 0; i < n; i++) simStep(); },
  state: () => PS.state,
  aimable: () => canAim(),
  mute: (v) => { muted = !!v; Sfx.setMuted(muted); },
  wipe: () => { Save.reset(); startLevel(0); },
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
