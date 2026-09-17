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
    'window.TEST = { BASH, updateBashProjectiles, frame, fit, predict, checkTriggers, cancelAim, circleVsBox, resetOrb, restartLevel, cam, getPaintTime: () => lastPaint, setPaintTime: t => { lastPaint = t; } }; window.FLUX = {');
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
  /* ---- movement system -------------------------------------------------
     The launch, the speed bands, the contact response and the input
     forgiveness are one system, so they are exercised as one. */
  const mv = boot();
  const { MOVE, PS } = mv;
  const speed = () => Math.hypot(mv.orb.vx, mv.orb.vy);
  const settle = (limit = 900) => {
    for (let i = 0; i < limit; i++) { mv.tick(1); if (speed() === 0 || mv.G.phase !== 'play') break; }
  };

  // --- launch strength ---
  mv.go(0);
  mv.shoot(0, 0);
  assert.equal(+speed().toFixed(6), MOVE.launchMin, 'Minimum launch uses the tuned floor speed');
  mv.go(0); mv.shoot(0, 1);
  assert.equal(+speed().toFixed(6), MOVE.launchMax, 'Full launch uses the tuned ceiling speed');
  assert(MOVE.launchMax < MOVE.speedMax, 'A launch must leave headroom under the clamp');
  let prev = 0;
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    mv.go(0); mv.shoot(0, p);
    assert(speed() >= prev, 'Launch speed must rise monotonically with power');
    prev = speed();
  }

  // --- speed clamp ---
  mv.go(0);
  mv.orb.vx = 500; mv.orb.vy = 500; mv.orb.dash = 0;
  mv.tick(1);
  assert(speed() <= MOVE.speedMax + 1e-9, 'Velocity is clamped for stability');

  // --- dash window, then momentum, then a decisive stop ---
  mv.go(0);
  mv.world.solids.length = 0; mv.world.hazards.length = 0; mv.world.voids.length = 0;
  mv.world.portal.x = -9999; mv.world.portal.y = -9999;
  mv.orb.x = 270; mv.orb.y = 480; mv.G.shotLimit = 0;
  mv.shoot(0, 1);
  const launched = speed();
  mv.tick(1);
  assert.equal(+speed().toFixed(6), +launched.toFixed(6), 'The dash window holds launch speed');
  settle();
  assert.equal(speed(), 0, 'A launch always reaches a true stop');
  assert(PS.state === 'rest', 'A stopped character is in the rest band');

  // --- speed bands agree with the tuning table ---
  mv.go(0);
  for (const [v, band] of [[0, 'rest'], [2, 'settle'], [8, 'flow'], [25, 'dash']]) {
    mv.orb.vx = v; mv.orb.vy = 0; mv.orb.dash = 0;
    mv.tick(1);
    assert.equal(PS.state, band, `${v} units/step is the ${band} band`);
  }

  // --- corner determinism: neighbouring approaches must not scatter ---
  const exits = [];
  for (let d = -2; d <= 2; d++) {
    mv.go(0);
    mv.orb.x = 200 + d; mv.orb.y = 600; mv.orb.vx = -14; mv.orb.vy = 14; mv.orb.dash = 0;
    for (let i = 0; i < 40; i++) mv.tick(1);
    exits.push(Math.atan2(mv.orb.vy, mv.orb.vx) * 180 / Math.PI);
  }
  assert(Math.max(...exits) - Math.min(...exits) < 1,
    `A corner must resolve the same way for neighbouring approaches (spread ${(Math.max(...exits) - Math.min(...exits)).toFixed(1)}deg)`);

  // --- angled surfaces redirect predictably and keep flow ---
  mv.go(0);
  const slope = mv.world.solids.find(e => e.a !== 0 && !e.deadly) || mv.world.solids[0];
  let lastOut = -Infinity;
  for (const inc of [20, 40, 60]) {
    mv.go(0);
    mv.world.solids.length = 0;
    mv.world.solids.push({ kind: 'wall', x: 270, y: 800, w: 900, h: 40, a: 0, ca: 1, sa: 0,
      br: Math.hypot(900, 40) / 2, solid: true, dead: false, vx: 0, vy: 0, av: 0 });
    mv.world.hazards.length = 0; mv.world.voids.length = 0; mv.world.portal.x = -9999;
    const a = inc * Math.PI / 180;
    mv.orb.x = 120; mv.orb.y = 600; mv.orb.vx = Math.sin(a) * 22; mv.orb.vy = Math.cos(a) * 22; mv.orb.dash = 0;
    for (let i = 0; i < 40; i++) { mv.tick(1); if (mv.orb.vy < 0) break; }
    assert(mv.orb.vy < 0, `A ${inc}deg impact must rebound off the surface`);
    const out = Math.atan2(mv.orb.vx, -mv.orb.vy) * 180 / Math.PI;
    assert(out > lastOut, 'A shallower approach must leave shallower than a steeper one');
    assert(Math.hypot(mv.orb.vx, mv.orb.vy) > 22 * 0.5, 'A rebound must keep most of its energy');
    lastOut = out;
  }

  // --- no tunnelling at the clamp, and no resting overlap ---
  for (const v of [MOVE.speedFlow, MOVE.speedDash, MOVE.speedMax]) {
    mv.go(0);
    mv.world.solids.length = 0;
    mv.world.solids.push({ kind: 'wall', x: 270, y: 480, w: 500, h: 14, a: 0, ca: 1, sa: 0,
      br: Math.hypot(500, 14) / 2, solid: true, dead: false, vx: 0, vy: 0, av: 0 });
    mv.world.hazards.length = 0; mv.world.voids.length = 0; mv.world.portal.x = -9999;
    mv.orb.x = 270; mv.orb.y = 900; mv.orb.vx = 0; mv.orb.vy = -v; mv.orb.dash = 0;
    for (let i = 0; i < 20; i++) mv.tick(1);
    assert(mv.orb.y > 480 + 7 + mv.orb.r - 1, `${v} units/step must not tunnel through thin geometry`);
  }

  // --- settling against a surface must not chatter ---
  mv.go(0);
  mv.world.solids.length = 0;
  mv.world.solids.push({ kind: 'wall', x: 270, y: 700, w: 500, h: 24, a: 0, ca: 1, sa: 0,
    br: Math.hypot(500, 24) / 2, solid: true, dead: false, vx: 0, vy: 0, av: 0 });
  mv.world.hazards.length = 0; mv.world.voids.length = 0; mv.world.portal.x = -9999;
  mv.orb.x = 270; mv.orb.y = 500; mv.orb.vx = 0; mv.orb.vy = 7; mv.orb.dash = 0;
  let reversals = 0, lastVy = 7;
  for (let i = 0; i < 600; i++) {
    mv.tick(1);
    if (mv.orb.vy * lastVy < 0) reversals++;
    lastVy = mv.orb.vy;
    if (speed() === 0) break;
  }
  assert(reversals <= 2, `Settling must not micro-bounce (got ${reversals} reversals)`);
  assert.equal(speed(), 0, 'A body resting on a surface comes to a true stop');

  // --- pointer drag: mouse and touch take the identical path ---
  const drag = boot();
  const pt = (x, y, id = 7) => ({ clientX: x, clientY: y, pointerId: id, button: 0,
    target: drag.canvas, preventDefault() {} });
  drag.go(0);
  const sx = drag.orb.x, sy = drag.orb.y;
  drag.events.pointerdown(pt(sx, sy));
  assert.equal(drag.G.aiming, true, 'A touch on a resting character starts an aim');
  assert.equal(drag.G.power, 0, 'A centred touch starts at zero power');
  drag.events.pointermove(pt(sx, sy + 4));
  drag.events.pointerup(pt(sx, sy + 4));
  assert.equal(drag.G.shots, 0, 'A drag shorter than the dead zone is a cancel, not a launch');
  drag.events.pointerdown(pt(sx, sy));
  drag.events.pointermove(pt(sx, sy + 400));       // far past the full-power distance
  assert.equal(drag.G.power, 1, 'Drag power saturates at the tuned distance');
  drag.events.pointerup(pt(sx, sy + 400));
  assert.equal(drag.G.shots, 1, 'A full drag launches');
  assert(drag.orb.vy < 0, 'The character launches away from the pull');
  assert.equal(+Math.hypot(drag.orb.vx, drag.orb.vy).toFixed(6), MOVE.launchMax,
    'A saturated drag launches at full speed');

  // a touch far from the character still aims — the target is never too small
  drag.go(0);
  drag.events.pointerdown(pt(drag.orb.x + 240, drag.orb.y - 300));
  assert.equal(drag.G.aiming, true, 'A touch anywhere on the field can start an aim');
  drag.events.pointercancel();

  // --- early touches are buffered, not thrown away ---
  const buf = boot();
  buf.go(0);
  buf.orb.vx = MOVE.catchSpeed - 1; buf.orb.vy = 0; buf.orb.dash = 0;
  buf.events.pointerdown(pt(buf.orb.x, buf.orb.y, 9));
  assert.equal(buf.G.aiming, false, 'A touch on a moving character does not aim immediately');
  assert.equal(buf.G.shots, 0);
  for (let i = 0; i < 200 && !buf.G.aiming; i++) buf.tick(1);
  assert.equal(buf.G.aiming, true, 'A buffered touch becomes an aim once control returns');
  buf.events.pointercancel();
  // ...but only from the forgiving band, never from a committed dash
  buf.go(0);
  buf.orb.vx = MOVE.catchSpeed + 6; buf.orb.vy = 0; buf.orb.dash = 0;
  buf.events.pointerdown(pt(buf.orb.x, buf.orb.y, 9));
  for (let i = 0; i < 200; i++) buf.tick(1);
  assert.equal(buf.G.aiming, false, 'A committed dash cannot be caught by an early touch');
  // lifting the finger abandons the buffer
  buf.go(0);
  buf.orb.vx = MOVE.catchSpeed - 1; buf.orb.dash = 0;
  buf.events.pointerdown(pt(buf.orb.x, buf.orb.y, 9));
  buf.events.pointerup(pt(buf.orb.x, buf.orb.y, 9));
  for (let i = 0; i < 200; i++) buf.tick(1);
  assert.equal(buf.G.aiming, false, 'A lifted finger does not fire a buffered aim');

  // --- special objects still respond to the new movement ---
  const obj = boot();
  obj.go(5);                                   // level 6 carries a bumper
  const bumper = obj.world.bumpers[0];
  obj.orb.x = bumper.x; obj.orb.y = bumper.y + bumper.r + obj.orb.r + 2;
  obj.orb.vx = 0; obj.orb.vy = -12; obj.orb.dash = 0;
  obj.tick(1);
  assert(obj.orb.vy > 0, 'A bumper reverses the character');
  assert(Math.hypot(obj.orb.vx, obj.orb.vy) <= MOVE.bumperMax + 1e-9, 'Bumper output is clamped');
  assert(Math.hypot(obj.orb.vx, obj.orb.vy) > 12, 'A bumper adds energy');

  obj.go(2);                                   // level 3 carries ice
  const iceBlock = obj.world.ice[0];
  const hp0 = iceBlock.hp;
  obj.orb.x = iceBlock.x; obj.orb.y = iceBlock.y + iceBlock.h / 2 + obj.orb.r + 2;
  obj.orb.vx = 0; obj.orb.vy = -14; obj.orb.dash = 0;
  obj.tick(1);
  assert(iceBlock.hp < hp0 || iceBlock.dead, 'A solid hit still damages ice');

  obj.go(4);                                   // level 5 carries a colour gate
  const gate = obj.world.gates[0];
  obj.orb.color = gate.color === 'cyan' ? 'orange' : 'cyan';
  obj.orb.x = gate.x; obj.orb.y = gate.y + gate.h / 2 + obj.orb.r + 2;
  obj.orb.vx = 0; obj.orb.vy = -14; obj.orb.dash = 0;
  obj.tick(1);
  assert(obj.orb.vy > 0, 'A gate still rejects the wrong signature');
  obj.orb.color = gate.color;
  obj.orb.x = gate.x; obj.orb.y = gate.y + gate.h / 2 + obj.orb.r + 2;
  obj.orb.vx = 0; obj.orb.vy = -14; obj.orb.dash = 0;
  obj.tick(1);
  assert(obj.orb.vy < 0, 'A gate still opens to its own signature');

  obj.go(3);                                   // level 4 carries a pulsing hazard
  const hz = obj.world.hazards[0];
  for (let i = 0; i < 600 && obj.G.phase === 'play'; i++) {
    obj.orb.x = hz.x; obj.orb.y = hz.y; obj.orb.vx = 0; obj.orb.vy = 0;
    obj.tick(1);
  }
  assert.equal(obj.G.phase, 'fail', 'A live hazard still kills');

  // --- restart and progression ---
  const flow = boot();
  flow.go(6);
  const spawn = { x: flow.orb.x, y: flow.orb.y };
  flow.shoot(1, 1);
  flow.tick(30);
  flow.internals.restartLevel(true);
  assert.equal(flow.G.levelIndex, 6, 'Restart keeps the level');
  assert.equal(flow.G.shots, 0, 'Restart refills the launch budget');
  assert.equal(flow.orb.x, spawn.x, 'Restart returns the character to its spawn');
  assert.equal(Math.hypot(flow.orb.vx, flow.orb.vy), 0, 'Restart parks the character');
  assert.equal(flow.PS.state, 'rest', 'Restart returns the character to the rest band');
  flow.go(0);
  flow.orb.x = flow.world.portal.x; flow.orb.y = flow.world.portal.y;
  flow.orb.color = flow.world.portal.color; flow.orb.vx = 0; flow.orb.vy = 0;
  flow.tick(1);
  assert.equal(flow.G.phase, 'win', 'Reaching a matching portal still wins');
  for (let i = 0; i < 200 && flow.G.levelIndex === 0; i++) flow.tick(1);
  assert.equal(flow.G.levelIndex, 1, 'A win still advances to the next level');

  // --- aim preview stays a preview ---
  const aim = boot();
  aim.go(4);
  const soft = aim.internals.predict(aim.orb.x, aim.orb.y, 0, -MOVE.launchMin, 2, 190);
  const hard = aim.internals.predict(aim.orb.x, aim.orb.y, 0, -MOVE.launchMax, 2, 330);
  assert(soft.n > 0 && hard.n > 0, 'The aim guide produces a path');
  assert(hard.n < 40, 'The aim guide never draws the whole level');

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
  console.log('PASS: 10 safe spawns and winning routes, launch band, speed bands, corner determinism, ' +
    'angled rebounds, tunnelling, settling, pointer drag, buffered touch, bumper/ice/gate/hazard/portal, ' +
    'restart and progression, aim preview, pixel budgets, adaptive quality recovery, touch cancellation, ' +
    'tab suspension, end curtain, final-shot win.');
}
module.exports = { boot };
