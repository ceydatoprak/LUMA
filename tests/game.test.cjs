// Real game physics in a minimal DOM/canvas shell; no browser dependencies.
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

function boot() {
  const events = {}, nodes = new Map();
  let rect = { left: 0, top: 0, width: 540, height: 960 };
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const context = new Proxy({}, { get: (o, k) => o[k] ?? (k.startsWith('create') ? () => gradient : noop) });
  const node = () => ({ width: 540, height: 960, style: {}, classList: { add: noop, remove: noop, toggle: noop },
    getContext: () => context, getBoundingClientRect: () => rect, setAttribute: noop, contains: () => false,
    addEventListener: (key, fn) => { events[key] = fn; } });
  const document = { hidden: false, getElementById: id => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  }, querySelector: () => node(), createElement: node, addEventListener: (k, f) => { events[k] = f; } };
  const window = { devicePixelRatio: 3, addEventListener: (k, f) => { events[k] = f; } };
  const sandbox = { window, document, location: { search: '' },
    localStorage: { getItem: () => null, setItem: noop }, performance, setTimeout: noop,
    requestAnimationFrame: () => 1, cancelAnimationFrame: noop, console };
  vm.createContext(sandbox);
  const source = readFileSync(require.resolve('../game.js'), 'utf8').replace('window.FLUX = {',
    'window.TEST = { BASH, updateBashProjectiles, frame, fit, predict, checkTriggers, cancelAim, circleVsBox, resetOrb, cam, getPaintTime: () => lastPaint, setPaintTime: t => { lastPaint = t; } }; window.FLUX = {');
  vm.runInContext(source, sandbox);
  return { ...window.FLUX, internals: window.TEST, events, document, canvas: nodes.get('game'),
    resize: (width, height) => { rect = { ...rect, width, height }; window.TEST.fit(); } };
}

if (require.main === module) {
  const f = boot();
  for (let i = 0; i < f.LEVELS.length; i++) {
    f.go(i);
    for (const e of f.world.solids) {
      const overlaps = e.round ? Math.hypot(f.orb.x - e.x, f.orb.y - e.y) < f.orb.r + e.r :
        f.internals.circleVsBox(f.orb.x, f.orb.y, f.orb.r, e);
      assert(!overlaps,
        `Level ${i + 1}: spawn intersects ${e.kind}`);
    }
    f.tick(60);
    assert.equal(f.G.phase, 'play', `Level ${i + 1}: unsafe idle spawn`);
    assert(Number.isFinite(f.orb.x) && Number.isFinite(f.orb.y));
  }
  f.resize(1800, 3200);
  assert(f.canvas.width * f.canvas.height <= 1100000, 'Desktop pixel budget');
  f.Q.level = 0; f.resize(1800, 3200);
  assert(f.canvas.width * f.canvas.height <= 700000, 'Reduced pixel budget');
  f.resize(390, 693);
  assert(f.canvas.width * f.canvas.height <= 700000, 'Mobile pixel budget');

  f.go(3); f.G.aiming = true; f.G.power = 1;
  f.events.pointercancel();
  assert.equal(f.G.shots, 0, 'Cancelled touch must not launch');
  assert.equal(f.G.aiming, false);
  f.internals.frame(1000); f.internals.frame(1017);
  const t = f.G.t;
  f.document.hidden = true; f.events.visibilitychange(); f.internals.frame(5000);
  assert.equal(f.G.t, t, 'Hidden tab must not advance physics');
  f.document.hidden = false; f.events.visibilitychange(); f.internals.frame(10000);
  assert.equal(f.G.t, t, 'Resume must not catch up hidden time');

  const adaptive = boot();
  for (let i = 0; i < 100; i++) adaptive.internals.frame(1000 + i * 34);
  assert.equal(adaptive.Q.level, 0, 'Slow frames should reduce quality');
  assert(adaptive.canvas.width * adaptive.canvas.height <= 700000, 'Quality changes resize immediately');
  for (let i = 0; i < 650; i++) adaptive.internals.frame(4400 + i * (1000 / 60));
  assert.equal(adaptive.Q.level, 1, 'Quality should recover on a healthy 60 Hz display');
  adaptive.G.phase = 'done'; adaptive.G.transDir = -1; adaptive.G.transT = 0;
  for (let i = 0; i < 80; i++) adaptive.internals.frame(16000 + i * (1000 / 60));
  assert.equal(adaptive.G.transDir, 0, 'End curtain finishes before simulation sleeps');
  const endTime = adaptive.G.t;
  adaptive.internals.frame(18000);
  assert.equal(adaptive.G.t, endTime, 'Completed game stops simulation');

  f.go(4); f.G.shots = f.G.shotLimit;
  f.orb.x = f.world.portal.x; f.orb.y = f.world.portal.y;
  f.orb.color = f.world.portal.color; f.orb.vx = 0; f.orb.vy = 0;
  f.tick(1);
  assert.equal(f.G.phase, 'win', 'A win on the last shot must not become a failure');
  const solutions = require('./solutions.json');
  const catcher = boot();
  const pointer = (x, y, id = 1) => ({ clientX: x, clientY: y, pointerId: id, button: 0,
    target: catcher.canvas, preventDefault() {} });
  catcher.shoot(0, 0.8);
  const flyingSpeed = catcher.orb.vx;
  const cx = catcher.orb.x, cy = catcher.orb.y;
  const bash = catcher.internals.BASH;
  const spark = { x: cx + 40, y: cy, vx: -2.6, vy: 0, r: 8,
    life: 7, cooldown: 0, reflected: false, color: null };
  catcher.events.pointerdown(pointer(cx, cy));
  assert.equal(catcher.G.aiming, false, 'Free mid-air grabbing requires a target now');
  bash.projectiles.push(spark);
  catcher.events.pointerdown(pointer(cx + 200, cy));
  assert.equal(catcher.G.aiming, false, 'Distant touches must not catch a flying orb');
  catcher.events.pointerdown(pointer(cx + 20, cy));
  assert.equal(catcher.G.aiming, true, 'A nearby projectile enables Bash');
  assert.equal(catcher.G.power, 0, 'An off-centre catch must not create launch power');
  const frozenTime = catcher.G.t;
  catcher.tick(10);
  assert.equal(catcher.G.t, frozenTime, 'Bash aiming freezes the entire world');
  assert.equal(spark.x, cx + 40, 'The target projectile also freezes');
  assert.equal(catcher.orb.x, cx, 'A held orb freezes in flight');
  assert.equal(catcher.orb.y, cy);
  catcher.events.pointermove(pointer(cx + 20, cy + 100));
  catcher.events.pointerup(pointer(cx + 20, cy + 100, 2));
  assert.equal(catcher.G.aiming, true, 'Another finger must not release the catch');
  catcher.events.pointerup(pointer(cx + 20, cy + 100));
  assert.equal(catcher.G.shots, 1, 'Bash chains do not spend normal launches');
  assert.equal(catcher.orb.vy, bash.speed, 'Bash aims toward the drag, not away');
  assert.equal(spark.vy, -bash.speed, 'The projectile flies in the opposite direction');
  assert.equal(spark.reflected, true);
  spark.cooldown = 0;
  catcher.events.pointerdown(pointer(cx + 20, cy));
  const resumeVy = catcher.orb.vy;
  catcher.events.pointercancel();
  assert.equal(catcher.orb.vy, resumeVy, 'Cancelled catch preserves flight velocity');
  assert.equal(catcher.G.shots, 1);
  catcher.events.pointerdown(pointer(cx, cy));
  catcher.tick(121);
  assert.equal(catcher.G.aiming, false, 'The two-second aim window must expire');
  catcher.go(3); catcher.G.shots = catcher.G.shotLimit;
  catcher.orb.vx = flyingSpeed;
  catcher.events.pointerdown(pointer(catcher.orb.x, catcher.orb.y));
  assert.equal(catcher.G.aiming, false, 'No target means no free grab at zero launches');
  bash.projectiles.push({ ...spark, x: catcher.orb.x + 40, y: catcher.orb.y, life: 7, cooldown: 0 });
  catcher.events.pointerdown(pointer(catcher.orb.x, catcher.orb.y));
  assert.equal(catcher.G.aiming, true, 'Bash remains available on the last normal launch');
  catcher.events.pointercancel();
  catcher.go(2);
  bash.emitters.length = 0;
  const ice = catcher.world.ice[0];
  bash.projectiles.push({ ...spark, x: ice.x, y: ice.y + 50, vx: 0, vy: -18,
    reflected: true, color: 'cyan', life: 4 });
  for (let i = 0; i < 3; i++) catcher.internals.updateBashProjectiles();
  assert.equal(catcher.world.ice.length, 0, 'A reflected projectile shatters ice');
  catcher.go(0);
  assert.equal(bash.projectiles.length, 0, 'Restart clears old projectiles');
  assert.equal(bash.target, null);
  const danger = boot();
  danger.go(0);
  const spike = danger.world.livewalls.find(e => e.spikes);
  const tooth = spike.outline[1];
  danger.orb.x = spike.x + tooth.x;
  danger.orb.y = spike.y + tooth.y - danger.orb.r + 1;
  danger.tick(1);
  assert.equal(danger.G.phase, 'fail', 'Touching a spike tip must kill, even at rest');
  danger.go(0);
  const bar = danger.world.livewalls.find(e => !e.spikes);
  danger.orb.x = bar.x; danger.orb.y = bar.y + bar.h / 2 + danger.orb.r + 4;
  danger.orb.vy = -20;
  danger.tick(1);
  assert.equal(danger.G.phase, 'fail', 'A fast shot into a red bar must kill');
  danger.go(0);
  const guide = danger.internals.predict(bar.x, bar.y + 100, 0, -15, 2);
  assert.equal(guide.hazard, true, 'Aim preview must warn about lethal bars');
  for (let i = 0; i < solutions.length; i++) {
    f.go(i);
    for (const [angle, power] of solutions[i]) {
      assert(f.ready(), `Level ${i + 1}: route must use legal launches`);
      f.shoot(angle, power);
      for (let step = 0; step < 360; step++) {
        f.tick(1);
        if (f.G.phase !== 'play' || Math.hypot(f.orb.vx, f.orb.vy) === 0) break;
      }
    }
    assert.equal(f.G.phase, 'win', `Level ${i + 1}: verified route must win`);
    assert(!f.G.shotLimit || f.G.shots <= f.G.shotLimit, `Level ${i + 1}: shot budget`);
  }
  console.log('PASS: 10 safe spawns and winning routes, pixel budgets, adaptive quality recovery, touch cancellation, tab suspension, end curtain, final-shot win.');
}
module.exports = { boot };
