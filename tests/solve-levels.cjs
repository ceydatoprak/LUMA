// Design aid and gate-keeper: searches for a route through every level using
// the real simulation, so a level can never ship unreachable.
//
//   node tests/solve-levels.cjs            all levels
//   node tests/solve-levels.cjs 3          just level 3
//   SOLVER_BEAM=48 node tests/solve-levels.cjs   widen the search
//
// A "move" is one wind-up: an angle and a power, taken either from a surface
// or from an energy node. The search runs the game forward from each move
// until the spirit can act again, then scores how much closer to the gate it
// got. That is exactly the loop a player is in, so a route the solver finds is
// a route a player can walk.
const { boot } = require('./harness.cjs');

const f = boot();
const T = f.internals;

const ANGLES = 30;                       // directions tried per decision
const POWERS = [0.4, 0.7, 1];
const BEAM = Number(process.env.SOLVER_BEAM) || 36;
const MAX_MOVES = Number(process.env.SOLVER_MOVES) || 12;

function snapshot() {
  return {
    body: { ...f.body },
    PS: { ...f.PS, nodeIndex: f.PS.node ? f.world.nodes.indexOf(f.PS.node) : -1 },
    G: { t: f.G.t, phase: f.G.phase, phaseT: f.G.phaseT,
         spawnX: f.G.spawnX, spawnY: f.G.spawnY, bursts: f.G.bursts },
    nodes: f.world.nodes.map(n => n.cool),
    support: f.world.solids.indexOf(f.PS.support),
    solids: f.world.solids.map(e => ({crumbleT:e.crumbleT,broken:e.broken})),
    springs: f.world.springs.map(e => ({lock:e.lock,off:e.off,cool:e.cool,fire:e.fire})),
    loop: {...T.springLoop},
    motes: f.world.motes.map(m => m.got),
    movers: f.world.movers.map(m => ({ x: m.x, y: m.y, a: m.a, ca: m.ca, sa: m.sa })),
  };
}
function restore(s) {
  Object.assign(f.body, s.body);
  Object.assign(f.PS, s.PS);
  f.PS.node = s.PS.nodeIndex >= 0 ? f.world.nodes[s.PS.nodeIndex] : null;
  f.PS.support = f.world.solids[s.support] || null;
  f.world.solids.forEach((e,i)=>Object.assign(e,s.solids[i]));
  f.world.springs.forEach((e,i)=>Object.assign(e,s.springs[i]));
  Object.assign(T.springLoop,s.loop);
  Object.assign(f.G, s.G);
  f.world.nodes.forEach((n, i) => { n.cool = s.nodes[i]; });
  f.world.motes.forEach((m, i) => { m.got = s.motes[i]; });
  f.world.movers.forEach((m, i) => { Object.assign(m, s.movers[i]); });
  f.Aim.on = false;
}

const AIMABLE = 'aimable', NODE = 'node', DEAD = 'dead', WON = 'won', STUCK = 'stuck';

/* Run the world forward until the player would next have a decision to make. */
function advance(limit = 420) {
  for (let i = 0; i < limit; i++) {
    f.tick(1);
    if (f.G.phase === 'win' || f.G.phase === 'trans') return WON;
    if (f.PS.state === 'hurt' || f.PS.state === 'spawn') return DEAD;
    if (T.canAim()) return AIMABLE;
    if (T.nodeInReach()) return NODE;
  }
  return STUCK;
}

function dist() {
  const g = f.world.gate;
  return Math.hypot(f.body.x - g.x, f.body.y - g.y);
}

/* A state is worth keeping if it is closer to the gate than anything else with
   a similar footprint; the key coarsens position so the beam does not fill up
   with a hundred variations of the same ledge. */
function key() {
  return [Math.round(f.body.x / 40), Math.round(f.body.y / 40), f.PS.state,
          f.world.motes.filter(m => m.got).length].join(':');
}

function solve(level) {
  f.go(level);
  for (let i = 0; i < 40; i++) f.tick(1);          // let the spawn settle
  let beam = [{ state: snapshot(), path: [], score: -dist() }];

  for (let depth = 0; depth < MAX_MOVES; depth++) {
    const found = new Map();
    for (const b of beam) {
      for (let ai = 0; ai < ANGLES; ai++) {
        const angle = -Math.PI + (ai * TAU_STEP);
        for (const power of POWERS) {
          restore(b.state);
          // a decision is only ever taken from a state that allows one
          if (!T.canAim()) {
            const n = T.nodeInReach();
            if (!n) continue;
            T.grabNode(n, f.body.x, f.body.y, null);
            f.Aim.on = false;                       // the solver aims instantly
          }
          f.burst(angle, power);
          const path = [...b.path, [angle, power]];

          // fly until something happens, taking every node offered on the way
          let out = advance();
          let guard = 0;
          while (out === NODE && guard++ < 6) {
            const n = T.nodeInReach();
            if (!n) break;
            T.grabNode(n, f.body.x, f.body.y, null);
            f.Aim.on = false;
            break;                                   // a node IS a decision point
          }
          if (f.G.phase === 'win' || f.G.phase === 'trans') return path;
          if (out === DEAD || out === STUCK) continue;

          const score = -dist() + f.world.motes.filter(m => m.got).length * 400;
          const k = key();
          const prev = found.get(k);
          if (!prev || prev.score < score) found.set(k, { state: snapshot(), path, score });
        }
      }
    }
    beam = [...found.values()].sort((a, b) => b.score - a.score).slice(0, BEAM);
    const best = beam[0];
    console.log(`L${level + 1} move ${depth + 1}: ${beam.length} candidates, best gap ${best ? (-best.score).toFixed(0) : 'n/a'}`);
    if (!beam.length) break;
  }
  return null;
}
const TAU_STEP = (Math.PI * 2) / ANGLES;

/* Replay a found route through a clean level, and report which mechanics it
   actually used. A level that places nodes or springs the best route ignores
   is a level that does not teach what it thinks it teaches, so this is a
   design check, not just a correctness one. */
function verify(level, route) {
  f.go(level);
  for (let i = 0; i < 40; i++) f.tick(1);
  const used = { cling: 0, node: 0, spring: 0, mote: 0, won: false };
  let wasCling = false;
  for (const [angle, power] of route) {
    if (!T.canAim()) {
      const n = T.nodeInReach();
      if (!n) break;
      T.grabNode(n, f.body.x, f.body.y, null);
      f.Aim.on = false;
      used.node++;
    }
    if (!T.canAim()) break;
    f.burst(angle, power);
    for (let i = 0; i < 420; i++) {
      const fired = f.world.springs.filter(s => s.fire > 0.9).length;
      f.tick(1);
      if (f.world.springs.filter(s => s.fire > 0.9).length > fired) used.spring++;
      const c = f.PS.state === 'cling';
      if (c && !wasCling) used.cling++;
      wasCling = c;
      if (f.G.phase !== 'play') break;
      if (T.canAim() || T.nodeInReach()) break;
    }
    if (f.G.phase !== 'play') break;
  }
  used.mote = f.world.motes.filter(m => m.got).length;
  used.won = f.G.phase === 'win' || f.G.phase === 'trans';
  return used;
}

const only = process.argv[2] ? [Number(process.argv[2]) - 1] : f.LEVELS.map((_, i) => i);
const out = [];
const report = [];
let failed = false;
for (const level of only) {
  const route = solve(level);
  if (!route) { failed = true; report.push({ level: level + 1, route: null }); continue; }
  const used = verify(level, route);
  if (!used.won) { console.log(`L${level + 1}: route failed replay`); failed = true; }
  out[level] = route;
  report.push({ level: level + 1, name: f.LEVELS[level].name, moves: route.length, ...used });
}

console.log('\n  lvl  name           moves  cling  node  spring  mote   result');
for (const r of report) {
  if (!r.name) { console.log(`  ${String(r.level).padStart(3)}  UNSOLVED`); continue; }
  console.log(`  ${String(r.level).padStart(3)}  ${r.name.padEnd(13)} ${String(r.moves).padStart(5)}  ` +
    `${String(r.cling).padStart(5)} ${String(r.node).padStart(5)} ${String(r.spring).padStart(7)} ` +
    `${String(r.mote).padStart(5)}   ${r.won ? 'WIN' : 'FAIL'}`);
}
// a level that offers a mechanic the best route never touches is a design bug
for (const r of report) {
  if (!r.name) continue;
  const L = f.LEVELS[r.level - 1];
  if ((L.nodes || []).length && !r.node) console.log(`  ! L${r.level} places nodes the route ignores`);
  if ((L.springs || []).length && !r.spring) console.log(`  ! L${r.level} places springs the route ignores`);
}
if (failed) process.exitCode = 1;
module.exports = { out, report };
require('node:fs').writeFileSync(require('node:path').join(__dirname,'completion-routes.json'),JSON.stringify({out,report},null,2));
