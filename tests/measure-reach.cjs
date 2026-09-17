// DESIGN TOOL — measures the spirit's real reach envelope from the live
// simulation, so level geometry is built from what the movement actually does
// instead of from a guess.
//
//   node tests/measure-reach.cjs            the summary every level uses
//   node tests/measure-reach.cjs --table    the full envelope table
//
// Method: fly the real body out of an otherwise empty world and record the
// arc. A platform can only be placed where the arc is DESCENDING, so for each
// vertical offset the tool reports the furthest horizontal distance at which
// the arc is still coming down. That is the reach a designer can actually use.
const { boot } = require('./harness.cjs');

const f = boot();
const T = f.internals;
const MOVE = f.MOVE;

// A blank sky with the ground far below and nothing to assist against.
const PAD = { name: 'measure', tip: '', w: 9000, h: 6000, bg: ['#000', '#000'],
  accent: [120, 170, 255], spawn: { x: 600, y: 2960 }, gate: { x: 8600, y: 200 },
  solids: [{ x: 600, y: 3040, w: 700, h: 200 }], route: [] };
const PAD_WALL = JSON.parse(JSON.stringify(PAD));
PAD_WALL.solids.push({ x: 980, y: 2300, w: 120, h: 1600 });   // a face to hold
const PAD_NODE = JSON.parse(JSON.stringify(PAD));
PAD_NODE.nodes = [{ x: 1500, y: 2400 }];
const PAD_SPRING = JSON.parse(JSON.stringify(PAD));

const SLOT = f.LEVELS.length;
function useLevel(src) { f.LEVELS[SLOT] = src; f.go(SLOT); for (let i = 0; i < 60; i++) f.tick(1); }

/* Fly one launch and return the arc, relative to the launch point. */
function fly(angle, power, opts) {
  const o = Object.assign({ steps: 400 }, opts || {});
  const x0 = f.body.x, y0 = f.body.y;
  if (!T.canAim()) return null;
  f.burst(angle, power);
  const arc = [];
  let peak = 0;
  for (let i = 0; i < o.steps; i++) {
    f.tick(1);
    const dx = f.body.x - x0, dy = y0 - f.body.y;      // dy positive = higher
    if (dy > peak) peak = dy;
    arc.push({ dx, dy, vy: f.body.vy, t: i / 60 });
    if (f.PS.state === 'hurt' || f.G.phase !== 'play') break;
    if (i > 4 && (f.PS.state === 'ground' || f.PS.state === 'cling')) break;
  }
  return { arc, peak };
}

/* The reach envelope: for each vertical offset, the furthest horizontal
   distance at which the arc is still descending (i.e. could land on a top). */
function envelope(setup, opts) {
  opts = opts || {};
  const dir = opts.dir || 1;                  // which way counts as "forward"
  const bands = new Map();                    // dy bucket -> max dx
  let maxFlat = 0, maxPeak = 0;
  const STEPS = 180;                          // 2-degree aim resolution
  const POWERS = opts.powers || [0.25, 0.4, 0.55, 0.7, 0.85, 1];
  for (const power of POWERS) {
    for (let i = 0; i <= STEPS; i++) {
      const angle = -Math.PI + i * (Math.PI * 2 / STEPS);
      setup();
      const r = fly(angle, power, opts);
      if (!r) continue;
      if (r.peak > maxPeak) maxPeak = r.peak;
      for (const p of r.arc) {
        if (p.vy <= 0) continue;              // only a descending arc can land
        const dx = p.dx * dir;
        if (dx < 0) continue;
        const band = Math.round(p.dy / 20) * 20;
        if (!bands.has(band) || bands.get(band) < dx) bands.set(band, dx);
      }
      // the flat leap: where the arc crosses back through its own height
      for (let k = 1; k < r.arc.length; k++) {
        const a = r.arc[k - 1], b = r.arc[k];
        if (a.dy >= 0 && b.dy < 0 && b.dx * dir > maxFlat) maxFlat = b.dx * dir;
      }
    }
  }
  return { bands, maxFlat, maxPeak };
}

function show(title, env) {
  console.log('\n### ' + title);
  console.log('  flat leap (land at launch height)   ' + env.maxFlat.toFixed(0) + ' units');
  console.log('  apex gain (straight up)             ' + env.maxPeak.toFixed(0) + ' units');
  const keys = [...env.bands.keys()].sort((a, b) => b - a);
  if (process.argv.includes('--table')) {
    console.log('   rise   max horizontal');
    for (const k of keys) {
      if (k % 40) continue;
      console.log('  ' + String(k).padStart(5) + '   ' + env.bands.get(k).toFixed(0).padStart(5));
    }
  }
  return env;
}

/* --- 1. the plain leap, by power ---------------------------------------- */
console.log('=== LUMA reach measurements (live simulation) ===');
console.log('\n### Plain leap from the ground, by pull');
console.log('  pull   speed    flat reach    apex');
for (const pull of [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1]) {
  const power = T.powerCurve(pull);
  let flat = 0, apex = 0;
  for (let i = 0; i <= 180; i++) {
    const angle = -Math.PI + i * (Math.PI * 2 / 180);
    useLevel(PAD);
    const r = fly(angle, power);
    if (!r) continue;
    if (r.peak > apex) apex = r.peak;
    for (let k = 1; k < r.arc.length; k++) {
      const a = r.arc[k - 1], b = r.arc[k];
      if (a.dy >= 0 && b.dy < 0 && b.dx > flat) flat = b.dx;
    }
  }
  console.log('  ' + pull.toFixed(2) + '   ' + T.burstSpeed(power).toFixed(2) + '    ' +
    flat.toFixed(0).padStart(6) + '      ' + apex.toFixed(0).padStart(5));
}

/* --- 2. full ground envelope -------------------------------------------- */
const ground = show('Ground launch envelope (all pulls)', envelope(() => useLevel(PAD)));

/* --- 3. wall cling ------------------------------------------------------- */
function clingSetup() {
  useLevel(PAD_WALL);
  T.placeSpirit(980 - 60 - MOVE.radius + 2, 2100);
  f.PS.state = 'cling'; f.PS.clingSide = -1; f.PS.clingT = 0; f.PS.t = 1;
  f.PS.clingWall = f.world.solids[1];
}
const wall = show('Wall-cling launch envelope (measured away from the face)',
  envelope(clingSetup, { dir: -1 }));

/* --- 4. energy node ------------------------------------------------------ */
function nodeSetup() {
  useLevel(PAD_NODE);
  const n = f.world.nodes[0];
  T.placeSpirit(n.x, n.y);
  f.body.vx = 0; f.body.vy = 0;
  T.grabNode(n, n.x, n.y, null);
  f.Aim.on = false;
  f.PS.t = 1;
}
const node = show('Energy-node redirect envelope', envelope(nodeSetup));

/* --- 5. spring ----------------------------------------------------------- */
console.log('\n### Spring throw (no input; the spring does the work)');
for (const a of [0, 12, 25, 40]) {
  const src = JSON.parse(JSON.stringify(PAD_SPRING));
  src.springs = [{ x: 1500, y: 2600, w: 180, h: 44, a: a }];
  f.LEVELS[SLOT] = src; f.go(SLOT); for (let i = 0; i < 20; i++) f.tick(1);
  const sp = f.world.springs[0];
  // drop in along the launch normal, the way an arriving player does
  const nx = sp.sa, ny = -sp.ca, d = sp.h / 2 + MOVE.radius + 24;
  T.placeSpirit(sp.x + nx * d, sp.y + ny * d);
  f.PS.state = 'air'; f.PS.t = 1;
  f.body.vx = -nx * 5; f.body.vy = -ny * 5;
  const x0 = f.body.x, y0 = f.body.y;
  let peak = 0, far = 0, fired = false;
  for (let i = 0; i < 400; i++) {
    f.tick(1);
    if (sp.fire > 0.9) fired = true;
    const dx = f.body.x - x0, dy = y0 - f.body.y;
    if (dy > peak) peak = dy;
    if (dy > -5) far = Math.max(far, Math.abs(dx));
    if (fired && i > 5 && (f.PS.state === 'ground' || f.PS.state === 'cling')) break;
  }
  console.log('  face ' + String(a).padStart(2) + 'deg   apex +' + peak.toFixed(0).padStart(3) +
    '   horizontal carry at launch height ' + far.toFixed(0).padStart(4) +
    (fired ? '' : '   (never fired)'));
}

/* --- 6. the numbers the level design is built on ------------------------- */
const B = (e, dy) => (e.bands.get(dy) || 0);
console.log('\n=== DESIGN BUDGET ===================================');
console.log('  MAX flat gap (theoretical)          ' + ground.maxFlat.toFixed(0));
console.log('  MAX rise, straight up               ' + ground.maxPeak.toFixed(0));
for (const dy of [100, 160, 220, 280, 340]) {
  console.log('  rise +' + String(dy).padStart(3) + ' -> horizontal available   ' + B(ground, dy).toFixed(0));
}
console.log('  wall: MAX flat                      ' + wall.maxFlat.toFixed(0));
console.log('  wall: MAX rise                      ' + wall.maxPeak.toFixed(0));
console.log('  node: MAX flat                      ' + node.maxFlat.toFixed(0));
console.log('  node: MAX rise                      ' + node.maxPeak.toFixed(0));
console.log('\n  comfort budgets (fraction of MAX flat gap):');
for (const row of [['L1-5   65%', 0.65], ['L6-10  75%', 0.75], ['L11-14 82%', 0.82], ['L15    90%', 0.90]])
  console.log('    ' + row[0] + '  -> ' + (ground.maxFlat * row[1]).toFixed(0) + ' units');
console.log('\n  landing assist adds up to ' + MOVE.assistReach + ' units past a ledge edge,');
console.log('  so a gap is really more forgiving than the raw number suggests.');
