// Design aid: find and replay legal shot sequences through the real integrator.
// Run with `node tests/solve-levels.cjs [one-based level]`.
const { boot } = require('./game.test.cjs');
const f = boot();
const goals = [
  [['color', 'cyan', 490, 700], ['pos', 420, 460], ['exit']],
  [['color', 'orange', 445, 700], ['pos', 270, 425], ['exit']],
  [['ice', 270, 555], ['pos', 270, 440], ['exit']],
  [['color', 'cyan', 490, 700], ['pos', 270, 455], ['exit']],
  [['color', 'cyan', 490, 700], ['pos', 270, 420], ['color', 'orange', 490, 290], ['exit']],
  [['pos', 270, 420], ['color', 'cyan', 50, 392], ['exit']],
  [['ice', 160, 595], ['color', 'lime', 490, 380], ['exit']],
  [['color', 'lime', 490, 700], ['crystal', 270, 540], ['pos', 270, 420], ['exit']],
  [['ice', 250, 655], ['color', 'cyan', 50, 460], ['pos', 375, 250], ['exit']],
  [['color', 'cyan', 50, 790], ['ice', 250, 675], ['pos', 270, 280], ['color', 'orange', 490, 200], ['exit']],
];
function snapshot() {
  const entities = new Map();
  const copy = e => { if (!entities.has(e)) entities.set(e, { ...e }); return entities.get(e); };
  const world = {};
  for (const [k, v] of Object.entries(f.world)) world[k] = Array.isArray(v) && v[0]?.kind ? v.map(copy) : v;
  world.portal = { ...f.world.portal };
  return { orb: { ...f.orb }, world, G: { ...f.G }, paintTime: f.internals.getPaintTime() };
}
function restore(s) {
  Object.assign(f.orb, s.orb); Object.assign(f.G, s.G);
  f.internals.setPaintTime(s.paintTime);
  const entities = new Map();
  const copy = e => { if (!entities.has(e)) entities.set(e, { ...e }); return entities.get(e); };
  for (const [k, v] of Object.entries(s.world)) f.world[k] = Array.isArray(v) ? v.map(e => e?.kind ? copy(e) : e) : v;
  f.world.portal = { ...s.world.portal };
}
function reached(g) {
  if (g[0] === 'color') return f.orb.color === g[1];
  if (g[0] === 'ice') return !f.world.ice.length;
  if (g[0] === 'crystal') return !f.world.crystals.length;
  if (g[0] === 'pos') return Math.hypot(f.orb.x - g[1], f.orb.y - g[2]) < 65;
  return f.G.phase === 'win';
}
function target(g) {
  if (g[0] === 'exit') return [f.world.portal.x, f.world.portal.y];
  return g.slice(-2);
}
function solve(level) {
  f.go(level);
  const plan = goals[level];
  let beam = [{ state: snapshot(), path: [], stage: 0, score: 0 }];
  for (let depth = 0; depth < (f.LEVELS[level].shots || 10); depth++) {
    const candidates = new Map();
    for (const b of beam) {
      restore(b.state);
      const [tx, ty] = target(plan[b.stage]);
      const direct = Math.atan2(ty - f.orb.y, tx - f.orb.x);
      const angles = [direct];
      for (let a = 0; a < 72; a++) angles.push(a * Math.PI / 36);
      for (const angle of angles) for (const power of [0.3, 0.6, 1]) {
        restore(b.state);
        f.shoot(angle, power);
        let stage = b.stage;
        for (let step = 0; step < 360; step++) {
          f.tick(1);
          while (stage < plan.length && reached(plan[stage])) stage++;
          if (f.G.phase !== 'play' || Math.hypot(f.orb.vx, f.orb.vy) === 0) break;
        }
        const path = [...b.path, [angle, power]];
        if (f.G.phase === 'win') return path;
        if (f.G.phase !== 'play' || !f.ready()) continue;
        const [x, y] = target(plan[Math.min(stage, plan.length - 1)]);
        const score = stage * 1500 - Math.hypot(f.orb.x - x, f.orb.y - y) +
          (2 - (f.world.ice[0]?.hp || 0)) * 90;
        const key = [stage, Math.round(f.orb.x / 25), Math.round(f.orb.y / 25), f.orb.color,
          f.world.ice[0]?.hp, Math.floor(f.G.t % 5)].join(':');
        if (!candidates.has(key) || candidates.get(key).score < score)
          candidates.set(key, { state: snapshot(), path, stage, score });
      }
    }
    beam = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, Number(process.env.SOLVER_BEAM) || 32);
    console.log(`L${level + 1} shot ${depth + 1}: ${beam.length} candidates, stage ${beam[0]?.stage}`);
    if (!beam.length) break;
  }
  return null;
}
for (const level of process.argv[2] ? [Number(process.argv[2]) - 1] : goals.map((_, i) => i)) {
  const solution = solve(level);
  if (solution) {
    f.go(level);
    for (const [angle, power] of solution) {
      f.shoot(angle, power);
      for (let step = 0; step < 360; step++) {
        f.tick(1);
        if (f.G.phase !== 'play' || Math.hypot(f.orb.vx, f.orb.vy) === 0) break;
      }
    }
    if (f.G.phase !== 'win') throw new Error(`Level ${level + 1}: solution failed replay`);
  }
  console.log(JSON.stringify({ level: level + 1, solution }));
  if (!solution) process.exitCode = 1;
}
