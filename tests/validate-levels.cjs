// LEVEL VALIDATOR — the structural gate-keeper.
//
//   node tests/validate-levels.cjs          every level
//   node tests/validate-levels.cjs 7        just level 7
//   node tests/validate-levels.cjs --budget only the reach-budget table
//
// `playtest.cjs` asks whether the intended route can be flown. This asks the
// questions that come before that: is the level built correctly at all, and is
// every mandatory hop inside the difficulty budget its position in the
// campaign allows?
//
// Everything here is measured against the live simulation. The reach envelope
// is rebuilt on each run rather than hard-coded, so retuning MOVE retunes the
// budget too and a level that quietly drifts out of it says so.
const { boot } = require('./harness.cjs');

const f = boot();
const T = f.internals;
const MOVE = f.MOVE;
const VW = 540, VH = 960;

let problems = 0, warnings = 0;
const fail = (where, msg) => { console.log('  FAIL  ' + where + ': ' + msg); problems++; };
const warn = (where, msg) => { console.log('  warn  ' + where + ': ' + msg); warnings++; };

/* ============================================================
   1. THE REACH ENVELOPE, measured
   ============================================================
   For each amount of rise, how far horizontally can the spirit still be
   descending? That is the only honest denominator for "how hard is this hop". */
const PAD = { name: 'probe', tip: '', w: 9000, h: 6000, bg: ['#000', '#000'],
  accent: [1, 1, 1], spawn: { x: 600, y: 2960 }, gate: { x: 8600, y: 100 },
  solids: [{ x: 600, y: 3040, w: 700, h: 200 }], route: [] };
const REAL_LEVELS = f.LEVELS.length;      // before the probe pad is appended
const SLOT = REAL_LEVELS;

function buildEnvelope(nodeLaunch) {
  const src = JSON.parse(JSON.stringify(PAD));
  if (nodeLaunch) src.nodes = [{ x: 600, y: 2600 }];
  f.LEVELS[SLOT] = src;
  const bands = new Map();
  for (const power of [0.3, 0.55, 0.8, 1]) {
    for (let i = 0; i <= 120; i++) {
      const angle = -Math.PI + i * (Math.PI * 2 / 120);
      f.go(SLOT);
      for (let k = 0; k < 40; k++) f.tick(1);
      if (nodeLaunch) {
        const n = f.world.nodes[0];
        T.placeSpirit(n.x, n.y);
        T.grabNode(n, n.x, n.y, null);
        f.Aim.on = false;
      }
      const x0 = f.body.x, y0 = f.body.y;
      if (!T.canAim()) continue;
      f.burst(angle, power);
      for (let s = 0; s < 260; s++) {
        f.tick(1);
        if (f.body.vy > 0) {
          const dx = Math.abs(f.body.x - x0), dy = y0 - f.body.y;
          const band = Math.round(dy / 20) * 20;
          if (!bands.has(band) || bands.get(band) < dx) bands.set(band, dx);
        }
        if (f.PS.state === 'hurt' || f.G.phase !== 'play') break;
        if (s > 4 && (f.PS.state === 'ground' || f.PS.state === 'cling')) break;
      }
    }
  }
  return bands;
}
const ENV = { ground: buildEnvelope(false), node: buildEnvelope(true) };

/* How far could the spirit go, from this kind of launch, with this much rise?
   Interpolated between the measured bands. */
function maxReach(kind, rise) {
  const bands = kind === 'node' ? ENV.node : ENV.ground;
  const lo = Math.floor(rise / 20) * 20, hi = lo + 20;
  const a = bands.get(lo), b = bands.get(hi);
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return b;
  if (b === undefined) return a;
  const t = (rise - lo) / 20;
  return a + (b - a) * t;
}

/* The share of the available reach a hop actually spends.

   Measured to the nearest place the spirit can actually come down, not to the
   middle of the destination: a leap onto a 400-wide shelf is over as soon as
   the near edge is cleared, and judging it by the distance to its centre would
   make widening a platform look like a harder jump. `LAND_IN` is how far past
   that edge counts as honestly landed rather than scraping the corner. */
const LAND_IN = 40;
function targetPoint(from, to) {
  if (to[2] !== 'ground') return { x: to[0], y: to[1] };
  const s = surfaceUnder(to[0], to[1]);
  if (!s) return { x: to[0], y: to[1] };
  const near = from[0] < s.x ? s.x - s.w / 2 + LAND_IN : s.x + s.w / 2 - LAND_IN;
  // never claim a nearer landing than the waypoint the designer wrote
  const x = from[0] < s.x ? Math.min(near, to[0]) : Math.max(near, to[0]);
  return { x, y: (s.y - s.h / 2) - MOVE.radius };
}
/* The flat top the spirit would be standing on at this point. */
function surfaceUnder(x, y) {
  let best = null, gap = 90;
  for (const s of f.world.solids) {
    if (s.a) continue;
    if (x < s.x - s.w / 2 - 40 || x > s.x + s.w / 2 + 40) continue;
    const d = Math.abs((s.y - s.h / 2) - (y + MOVE.radius));
    if (d < gap) { gap = d; best = s; }
  }
  return best;
}
function demand(from, to, kind) {
  const p = targetPoint(from, to);
  const dx = Math.abs(p.x - from[0]);
  const rise = from[1] - p.y;
  const max = maxReach(kind, rise);
  if (max <= 0) return { ratio: Infinity, dx, rise };
  return { ratio: dx / max, dx, rise, max };
}

/* The budget the brief sets, as a fraction of available reach. */
function budgetFor(level) {
  if (level <= 5) return 0.65;
  if (level <= 10) return 0.75;
  if (level <= 14) return 0.82;
  return 0.92;
}

if (process.argv.includes('--budget')) {
  console.log('rise   ground   node');
  for (let r = 400; r >= -200; r -= 20)
    console.log(String(r).padStart(4) + '   ' +
      maxReach('ground', r).toFixed(0).padStart(5) + '   ' + maxReach('node', r).toFixed(0).padStart(5));
  process.exit(0);
}

/* ============================================================
   2. GEOMETRY HELPERS
   ============================================================ */
const box = (e) => ({ x0: e.x - e.w / 2, x1: e.x + e.w / 2, y0: e.y - e.h / 2, y1: e.y + e.h / 2 });
const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const pointIn = (x, y, e, pad) => {
  const b = box(e); pad = pad || 0;
  return x > b.x0 - pad && x < b.x1 + pad && y > b.y0 - pad && y < b.y1 + pad;
};
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/* Where a moving solid travels over its whole cycle. Measured from the entity's
   BASE position — `e.x` is wherever this frame happens to have left it, which
   would make the answer depend on when the check ran. */
function sweep(e) {
  const m = e.motion;
  const base = { x: e.bx === undefined ? e.x : e.bx, y: e.by === undefined ? e.y : e.by, w: e.w, h: e.h };
  if (!m || m.type !== 'osc') return box(base);
  const dx = Math.abs(m.dx || 0), dy = Math.abs(m.dy || 0);
  const b = box(base);
  return { x0: b.x0 - dx, x1: b.x1 + dx, y0: b.y0 - dy, y1: b.y1 + dy };
}

/* Drop a body at a point and report what it settles on. This is how every
   "is this place safe" question is answered — by standing there. */
function settleAt(x, y, steps) {
  T.placeSpirit(x, y);
  for (let i = 0; i < (steps || 260); i++) {
    f.tick(1);
    if (f.PS.state === 'hurt') return { ok: false, why: 'dies' };
    if (f.G.phase !== 'play') return { ok: false, why: 'left play' };
    if (f.PS.state === 'ground' && Math.abs(f.body.vx) < 1 && Math.abs(f.body.vy) < 1)
      return { ok: true, x: f.body.x, y: f.body.y };
  }
  return { ok: false, why: 'never settles' };
}

/* ============================================================
   3. THE CHECKS
   ============================================================ */
function checkLevel(li) {
  const L = f.LEVELS[li];
  const n = li + 1;
  const tag = 'L' + n;
  console.log('\n=== ' + n + '. ' + L.name + '  (' + L.w + ' x ' + L.h + ') ===');

  /* --- numbers that must be numbers ------------------------------------- */
  const every = [].concat(L.solids || [], L.springs || [], L.spikes || [], L.beams || [],
    L.winds || [], L.nodes || [], L.motes || [], [L.gate], [L.spawn]);
  for (const e of every) {
    for (const k of ['x', 'y', 'w', 'h', 'r', 'strength']) {
      if (e[k] !== undefined && !finite(e[k])) fail(tag, 'non-finite ' + k + ' on ' + JSON.stringify(e));
    }
  }
  for (const s of (L.solids || [])) {
    if (s.w <= 0 || s.h <= 0) fail(tag, 'degenerate solid ' + JSON.stringify(s));
  }

  f.go(li);
  for (let i = 0; i < 40; i++) f.tick(1);

  /* --- spawn ------------------------------------------------------------- */
  const sp = settleAt(L.spawn.x, L.spawn.y);
  if (!sp.ok) fail(tag, 'spawn is not safe: ' + sp.why);
  else if (Math.hypot(sp.x - L.spawn.x, sp.y - L.spawn.y) > 200)
    warn(tag, 'spawn falls ' + Math.hypot(sp.x - L.spawn.x, sp.y - L.spawn.y).toFixed(0) + ' units before landing');
  for (const h of f.world.lethal)
    if (pointIn(L.spawn.x, L.spawn.y, h, 140)) fail(tag, 'spawn sits within 140 units of a hazard');
  for (const w of (L.winds || []))
    if (pointIn(L.spawn.x, L.spawn.y, w, 0)) fail(tag, 'spawn is inside a wind current');

  /* --- gate -------------------------------------------------------------- */
  const g = L.gate;
  if (g.x < 0 || g.x > L.w || g.y < 0 || g.y > L.h) fail(tag, 'gate is outside the world box');
  for (const s of (L.solids || [])) {
    if (pointIn(g.x, g.y, s, -4)) fail(tag, 'gate is buried inside a solid');
  }
  for (const h of f.world.lethal) if (pointIn(g.x, g.y, h, 60)) fail(tag, 'gate is inside/next to a hazard');

  /* --- checkpoints ------------------------------------------------------- */
  for (const m of (L.motes || [])) {
    const rx = m.x, ry = m.y - 26;               // exactly what checkTriggers stores
    const r = settleAt(rx, ry);
    if (!r.ok) { fail(tag, 'checkpoint at ' + m.x + ',' + m.y + ' does not respawn safely (' + r.why + ')'); continue; }
    if (Math.hypot(r.x - rx, r.y - ry) > 120)
      warn(tag, 'checkpoint respawn falls ' + Math.hypot(r.x - rx, r.y - ry).toFixed(0) + ' units');
    for (const h of f.world.lethal)
      if (pointIn(rx, ry, h, 150)) fail(tag, 'checkpoint respawn is within 150 units of a hazard');
    for (const w of (L.winds || []))
      if (pointIn(rx, ry, w, 20)) fail(tag, 'checkpoint respawn is inside a wind current');
    for (const s of f.world.springs)
      if (pointIn(rx, ry, s, 60)) fail(tag, 'checkpoint respawn is on top of a spring');
    // what it lands on must be ordinary, still ground
    const under = f.world.solids.find(s =>
      Math.abs(r.x - s.x) < s.w / 2 + 20 && Math.abs((r.y + MOVE.radius) - (s.y - s.h / 2)) < 26);
    if (under && under.motion) fail(tag, 'checkpoint respawns onto a MOVING platform');
    if (under && under.crumble) fail(tag, 'checkpoint respawns onto a CRUMBLING platform');
  }

  /* --- moving solids ----------------------------------------------------- */
  for (const e of f.world.movers) {
    const s = sweep(e);
    if (s.x0 < -140 || s.x1 > L.w + 140 || s.y1 > L.h + 100)
      fail(tag, 'a moving platform travels outside the world');
    for (const o of f.world.solids) {
      if (o === e) continue;
      const ob = o.motion ? sweep(o) : box(o);
      if (overlaps(s, ob)) warn(tag, 'the platform moving around ' + e.bx + ',' + e.by +
        ' sweeps through the solid at ' + o.x + ',' + o.y +
        ' (x ' + o.x + '+-' + (o.w / 2) + ', y ' + o.y + '+-' + (o.h / 2) + ')');
    }
    for (const h of f.world.lethal) if (overlaps(s, box(h)))
      fail(tag, 'a moving platform sweeps through a hazard');

    /* Headroom for a rider. A platform can clear every other solid as a box
       and still crush the spirit standing on it, because the passenger is
       26 units taller than the platform is. Check the space a rider occupies
       across the whole travel, not just the platform itself. */
    const rider = { x0: s.x0, x1: s.x1, y0: s.y0 - MOVE.radius * 2 - 6, y1: s.y0 };
    for (const o of f.world.solids) {
      if (o === e) continue;
      const ob = o.motion ? sweep(o) : box(o);
      if (overlaps(rider, ob))
        fail(tag, 'the platform moving around ' + e.bx + ',' + e.by +
          ' would crush a rider against the solid at ' + o.x + ',' + o.y);
    }
  }

  /* --- crumbling platforms reset ---------------------------------------- */
  const crumbles = f.world.solids.filter(s => s.crumble);
  for (const c of crumbles) {
    if (c.crumble < 1.0) fail(tag, 'a crumbling platform gives only ' + c.crumble + 's of warning');
    if (c.motion) fail(tag, 'a platform both crumbles and moves — two unknowns at once');
  }
  if (crumbles.length) {
    crumbles[0].crumbleT = 0.2; crumbles[0].broken = true;
    T.respawn();
    if (crumbles[0].broken || crumbles[0].crumbleT >= 0)
      fail(tag, 'crumbling platforms do not reset on respawn');
    f.go(li); for (let i = 0; i < 20; i++) f.tick(1);
  }

  /* --- wind -------------------------------------------------------------- */
  for (const w of (L.winds || [])) {
    if (!finite(w.strength) || w.strength <= 0) fail(tag, 'wind with no strength');
    // A current must stay weaker than gravity. One that is stronger does not
    // bend a leap, it takes the leap away: the body is carried off with no way
    // to fall out of it, which is the one thing wind must never do.
    if (w.strength >= MOVE.gravity * 0.75) fail(tag, 'wind strength ' + w.strength +
      ' is too close to gravity (' + MOVE.gravity + '): it would carry the spirit rather than bend it');
    const wb = box(w);
    // a current that is mostly inside rock can shove a body into geometry
    let buried = 0;
    for (const s of f.world.solids) if (overlaps(wb, box(s))) {
      const ov = (Math.min(wb.x1, box(s).x1) - Math.max(wb.x0, box(s).x0)) *
                 (Math.min(wb.y1, box(s).y1) - Math.max(wb.y0, box(s).y0));
      buried += Math.max(0, ov);
    }
    if (buried > w.w * w.h * 0.34) warn(tag, 'a wind current is mostly inside solid rock');
  }

  /* --- beams ------------------------------------------------------------- */
  for (const b of (L.beams || [])) {
    const p = b.pulse;
    if (!p) { warn(tag, 'a beam never switches off'); continue; }
    const lit = p.period * (p.duty === undefined ? 0.42 : p.duty);
    const dark = p.period - lit;
    if (dark < 1.6) fail(tag, 'beam window is only ' + dark.toFixed(2) + 's of darkness');
    if (b.w > b.h) fail(tag, 'a beam is drawn as a vertical column; this one is wider than it is tall');
  }

  /* --- springs: where do they actually throw you? ------------------------ */
  for (let si = 0; si < (L.springs || []).length; si++) {
    f.go(li); for (let i = 0; i < 20; i++) f.tick(1);
    const s = f.world.springs[si];            // rebuilt world: index, never a stale reference
    const nx = s.sa, ny = -s.ca, d = s.h / 2 + MOVE.radius + 24;
    T.placeSpirit(s.x + nx * d, s.y + ny * d);
    f.PS.state = 'air'; f.PS.t = 1; f.body.vx = -nx * 5; f.body.vy = -ny * 5;
    let fired = false, land = null;
    for (let i = 0; i < 420; i++) {
      f.tick(1);
      if (s.fire > 0.9) fired = true;
      if (f.PS.state === 'hurt') { land = 'DIES'; break; }
      if (f.G.phase !== 'play') { land = 'gate'; break; }
      if (fired && i > 6 && (f.PS.state === 'ground' || f.PS.state === 'cling')) {
        land = f.body.x.toFixed(0) + ',' + f.body.y.toFixed(0); break;
      }
    }
    if (!fired) fail(tag, 'a spring at ' + s.x + ',' + s.y + ' never fires when entered along its face');
    else if (land === 'DIES') fail(tag, 'the throw from the spring at ' + s.x + ',' + s.y + ' is fatal');
    else if (!land) fail(tag, 'the throw from the spring at ' + s.x + ',' + s.y + ' never lands');
    else console.log('  spring ' + String(s.x).padStart(5) + ',' + String(s.y).padEnd(5) +
      ' (' + (s.a * 180 / Math.PI).toFixed(0).padStart(3) + 'deg) -> lands ' + land);
  }

  /* --- the route: budget, framing, and standing room --------------------- */
  const route = L.route || [];
  if (route.length < 2) { fail(tag, 'no route declared'); return; }
  const budget = budgetFor(n);
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1];
    if (b[2] === 'gate' || a[2] === 'spring') continue;   // no aimed input involved
    if (b[2] === 'spring') continue;                      // entering a spring: aimed at a big target
    // A hop the level deliberately hands to a current is checked by flying it
    // (playtest.cjs), not against an envelope measured in still air.
    if (b[3] === 'wind') { console.log('  ' + ((i + 1) + '. ' + a[2] + ' -> ' + b[2]).padEnd(22) +
      'carried by a current — reachability checked by playtest'); continue; }
    const kind = a[2] === 'node' ? 'node' : 'ground';
    const d = demand(a, b, kind);
    const label = (i + 1) + '. ' + a[2] + ' -> ' + b[2];
    const over = d.ratio > budget;
    const horizon = d.dx > 520 && b[2] !== 'cling';
    console.log('  ' + label.padEnd(22) +
      'dx ' + d.dx.toFixed(0).padStart(4) + '  rise ' + d.rise.toFixed(0).padStart(4) +
      '  uses ' + (d.ratio * 100).toFixed(0).padStart(3) + '% of reach' +
      (over ? '   OVER BUDGET (' + (budget * 100) + '%)' : '') +
      (horizon ? '   BEYOND SIGHT' : ''));
    if (over) problems++;
    if (horizon) problems++;
  }

  /* --- mandatory waypoints must not sit in danger ------------------------ */
  for (const wp of route) {
    if (wp[2] === 'gate') continue;
    for (const h of f.world.lethal)
      if (pointIn(wp[0], wp[1], h, 30)) fail(tag, 'a route waypoint sits in a hazard');
  }

  /* --- the world box has to hold the level ------------------------------ */
  for (const s of (L.solids || [])) {
    const b = box(s);
    if (b.y0 < -40) warn(tag, 'a solid pokes out of the top of the world');
  }
  if (L.w < 700) warn(tag, 'world narrower than the camera can pan in');
}

const only = process.argv[2] && !process.argv[2].startsWith('--')
  ? [Number(process.argv[2]) - 1]
  : Array.from({ length: REAL_LEVELS }, (_, i) => i);
for (const li of only) checkLevel(li);

console.log('\n' + (problems ? problems + ' problem(s)' : 'no problems') +
  (warnings ? ', ' + warnings + ' warning(s)' : '') + '.');
if (problems) process.exitCode = 1;
