// Playtests every level the way a person would have to play it.
//
//   node tests/playtest.cjs            every level
//   node tests/playtest.cjs 3          just level 3
//
// Each level carries a `route`: the sequence of places the player is meant to
// pass through. For every hop in that route this asks the questions a designer
// has to answer, using the real simulation and the real camera:
//
//   REACH   is there any input that gets there at all?
//   MARGIN  how wide is the window of inputs that work? A hop that needs one
//           exact angle is a hop the player will fail over and over.
//   SEE     with the camera where it would actually be while aiming, is the
//           destination on screen before the player has to commit?
//   REST    once there, does the player get control back?
//
// A hop that fails any of these is a design bug, not a difficulty setting.
const { boot } = require('./harness.cjs');

const f = boot();
const T = f.internals;
const VW = 540, VH = 960, CAM_PAD = 95;

const ANGLES = 96;                 // 3.75-degree resolution
const POWERS = [0, 0.2, 0.4, 0.6, 0.8, 1];
const MIN_ANGLE_WINDOW = 12;       // degrees of aim slack a hop must allow
const MIN_COMBOS = 6;

function place(wp) {
  const [x, y, kind] = wp;
  T.placeSpirit(x, y);
  f.PS.t = 1;
  if (kind === 'cling') {
    f.PS.state = 'cling';
    // work out which side the wall is on from the geometry itself
    const right = f.world.solids.some(s => !s.a &&
      x < s.x + s.w / 2 + 30 && x > s.x - s.w / 2 - 30 && s.x > x &&
      y > s.y - s.h / 2 && y < s.y + s.h / 2);
    f.PS.clingSide = right ? -1 : 1;
    f.PS.clingT = 0;
  } else if (kind === 'node') {
    const n = f.world.nodes.reduce((b, n) =>
      (!b || Math.hypot(n.x - x, n.y - y) < Math.hypot(b.x - x, b.y - y)) ? n : b, null);
    f.body.x = n.x; f.body.y = n.y;
    f.PS.node = n; f.PS.state = 'node';
  } else {
    f.PS.state = 'ground'; f.PS.coyote = 1;
  }
}

/* Does a flight that starts here end at the target? Records where it actually
   ended, because "can the player see the destination" really means "can the
   player see the place they are about to come down on". */
const landed = { x: 0, y: 0 };
function arrives(target) {
  const [tx, ty, kind] = target;
  let touched = false, was = f.PS.state;
  for (let s = 0; s < 500; s++) {
    f.tick(1);
    // record where the arc first MEETS the surface, not where it stops after
    // sliding: the surface is what has to be on screen, and once the player
    // releases, the camera follows the spirit anyway
    if (!touched && was === 'air' && (f.PS.state === 'ground' || f.PS.state === 'cling')) {
      touched = true; landed.x = f.body.x; landed.y = f.body.y;
    }
    was = f.PS.state;
    if (!touched) { landed.x = f.body.x; landed.y = f.body.y; }
    if (f.G.phase === 'win' || f.G.phase === 'trans') return kind === 'gate';
    if (f.PS.state === 'hurt') return false;
    if (kind === 'node') {
      const n = T.nodeInReach();
      if (n && Math.hypot(n.x - tx, n.y - ty) < 60) { landed.x = n.x; landed.y = n.y; return true; }
    }
    if (kind === 'spring') {
      const hit = f.world.springs.find(sp => sp.fire > 0.9);
      if (hit) { landed.x = hit.x; landed.y = hit.y; return true; }
    }
    if (T.canAim()) {
      if (kind === 'gate') return false;
      if (kind === 'cling') return f.PS.state === 'cling' && Math.hypot(f.body.x - tx, f.body.y - ty) < 220;
      if (kind === 'ground') return f.PS.state === 'ground' && Math.hypot(f.body.x - tx, f.body.y - ty) < 190;
      return false;
    }
  }
  return false;
}

/* Where the camera settles while this aim is being held, and what it shows. */
function viewWhileAiming(angle, power) {
  f.Aim.on = true; f.Aim.angle = angle; f.Aim.power = power;
  T.refreshAimPreview();
  T.updateCamera(true);
  for (let i = 0; i < 50; i++) { T.refreshAimPreview(); T.updateCamera(false); }
  const z = f.cam.zoomT;
  const r = { x0: f.cam.x - VW / (2 * z), x1: f.cam.x + VW / (2 * z),
              y0: f.cam.y - VH / (2 * z), y1: f.cam.y + VH / (2 * z) };
  f.Aim.on = false; f.Aim.power = 0;
  return r;
}
function visible(rect, x, y, pad = 0) {
  return x > rect.x0 + pad && x < rect.x1 - pad && y > rect.y0 + pad && y < rect.y1 - pad;
}

function checkHop(level, from, to) {
  const wins = [];
  for (let ai = 0; ai < ANGLES; ai++) {
    const angle = -Math.PI + ai * (Math.PI * 2 / ANGLES);
    for (const power of POWERS) {
      f.go(level);
      for (let i = 0; i < 20; i++) f.tick(1);
      place(from);
      if (!T.canAim()) continue;
      f.burst(angle, power);
      if (arrives(to)) wins.push({ angle, power, deg: angle * 180 / Math.PI, lx: landed.x, ly: landed.y });
    }
  }
  if (!wins.length) return { ok: false, combos: 0, window: 0, seeing: 0 };

  // For each working input, would the player have been able to see where it
  // lands while they were aiming it? The hop is only fair if some of them are
  // — a player aims at what they can see, so an input that works blind does
  // not count for anything.
  for (const w of wins) {
    f.go(level);
    for (let i = 0; i < 20; i++) f.tick(1);
    place(from);
    const rect = viewWhileAiming(w.angle, w.power);
    w.seen = visible(rect, w.lx, w.ly, 16);
    w.rect = rect;
  }
  const seeing = wins.filter(w => w.seen);

  // widest run of consecutive angles that work AND land somewhere you can see
  const pool = seeing.length ? seeing : wins;
  let window = 0, best = pool[0];
  for (const power of POWERS) {
    const at = pool.filter(w => w.power === power).sort((a, b) => a.deg - b.deg);
    let run = 0, runStart = 0;
    for (let i = 0; i < at.length; i++) {
      if (i && at[i].deg - at[i - 1].deg <= 360 / ANGLES + 0.01) run++;
      else { run = 1; runStart = i; }
      const span = run * (360 / ANGLES);
      if (span > window) { window = span; best = at[runStart + ((run / 2) | 0)]; }
    }
  }
  return { ok: true, combos: wins.length, seeing: seeing.length, window, best };
}

const only = process.argv[2] ? [Number(process.argv[2]) - 1] : f.LEVELS.map((_, i) => i);
let problems = 0;

for (const li of only) {
  const L = f.LEVELS[li];
  f.go(li);
  const route = L.route || [];
  console.log(`\n=== ${li + 1}. ${L.name}  (${L.w} x ${L.h}, ${route.length - 1} hops) ===`);
  if (route.length < 2) { console.log('  ! no route declared'); problems++; continue; }

  for (let i = 0; i < route.length - 1; i++) {
    const from = route[i], to = route[i + 1];
    const label = `${from[2]} -> ${to[2]}`;

    // a spring hop needs no input at all: it is the spring that moves you
    if (from[2] === 'spring') {
      f.go(li);
      for (let k = 0; k < 20; k++) f.tick(1);
      const sp = f.world.springs.reduce((b, s) =>
        (!b || Math.hypot(s.x - from[0], s.y - from[1]) < Math.hypot(b.x - from[0], b.y - from[1])) ? s : b, null);
      T.placeSpirit(sp.x - sp.sa * 40, sp.y + sp.ca * 40);
      f.PS.state = 'air'; f.PS.t = 1; f.body.vy = 2;
      const ok = arrives(to);
      console.log(`  ${String(i + 1).padStart(2)}. ${label.padEnd(18)} ${ok ? 'OK   (the spring does the work)' : 'FAIL the throw does not arrive'}`);
      if (!ok) problems++;
      continue;
    }

    const r = checkHop(li, from, to);
    if (!r.ok) {
      console.log(`  ${String(i + 1).padStart(2)}. ${label.padEnd(18)} UNREACHABLE`);
      problems++;
      continue;
    }

    const tight = r.window < MIN_ANGLE_WINDOW || r.seeing < MIN_COMBOS;
    const flags = [];
    if (!r.seeing) {
      flags.push('BLIND');
      if (process.env.PT_DEBUG) {
        const q = r.best;
        console.log(`      best view x ${q.rect.x0.toFixed(0)}..${q.rect.x1.toFixed(0)} ` +
          `y ${q.rect.y0.toFixed(0)}..${q.rect.y1.toFixed(0)}   lands (${q.lx.toFixed(0)},${q.ly.toFixed(0)})`);
      }
    }
    if (tight) flags.push('TIGHT');
    if (flags.length) problems++;
    console.log(`  ${String(i + 1).padStart(2)}. ${label.padEnd(18)} ` +
      `${flags.length ? flags.join('+').padEnd(11) : 'OK'.padEnd(11)} ` +
      `aim ${r.best.deg.toFixed(0).padStart(5)}deg p${r.best.power}  ` +
      `slack ${r.window.toFixed(0).padStart(3)}deg  ${String(r.seeing).padStart(3)}/${r.combos} inputs land in view`);
  }
}

console.log(problems ? `\n${problems} hop(s) need redesign.` : '\nEvery hop is reachable, forgiving and visible.');
if (problems) process.exitCode = 1;
