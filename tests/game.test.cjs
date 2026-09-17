// Behaviour tests for WISP. Everything runs the real simulation through the
// same entry points the player uses, so a pass here means the game works, not
// that the code merely parses.
//
//   node tests/game.test.cjs
const assert = require('node:assert/strict');
const { boot } = require('./harness.cjs');

const pass = [];
function section(name) { pass.push(name); }

if (require.main === module) {
  const f = boot();
  const T = f.internals;
  const { MOVE } = f;
  const speed = () => Math.hypot(f.body.vx, f.body.vy);

  /* ---- levels are sane and survivable on arrival --------------------- */
  for (let i = 0; i < f.LEVELS.length; i++) {
    f.go(i);
    const L = f.LEVELS[i];
    for (const e of f.world.solids) {
      assert(!T.circleVsBox(f.body.x, f.body.y, f.body.r, e),
        `Level ${i + 1}: spawn is inside a surface`);
    }
    assert(L.w > 0 && L.h > 0, `Level ${i + 1}: needs a world size`);
    assert(f.world.gate, `Level ${i + 1}: needs a gate`);
    f.tick(180);
    assert.equal(f.G.phase, 'play', `Level ${i + 1}: spawn is not survivable`);
    assert(Number.isFinite(f.body.x) && Number.isFinite(f.body.y),
      `Level ${i + 1}: simulation produced a non-finite position`);
    assert(f.aimable(), `Level ${i + 1}: the spirit never regains control at spawn`);

    // Every checkpoint has to be a place you can actually restart from. A mote
    // above a spring, for instance, turns each respawn into a trampoline and
    // the player never gets control back.
    for (let m = 0; m < f.world.motes.length; m++) {
      f.go(i);
      const mote = f.world.motes[m];
      f.G.spawnX = mote.x; f.G.spawnY = mote.y - 26;
      f.internals.respawn();
      let ok = false;
      for (let s = 0; s < 260; s++) {
        f.tick(1);
        if (f.G.phase !== 'play') break;
        if (f.aimable()) { ok = true; break; }
      }
      assert(ok, `Level ${i + 1} mote ${m + 1}: respawning there never returns control`);
      assert.notEqual(f.PS.state, 'hurt', `Level ${i + 1} mote ${m + 1}: respawning there is fatal`);
    }
  }
  section('six levels spawn safe, and every checkpoint is a usable restart');

  /* ---- an open-field arena, for measuring movement on its own --------- */
  function arena(extra) {
    f.go(0);
    for (const k of ['solids', 'springs', 'nodes', 'motes', 'lethal', 'beams', 'movers']) {
      f.world[k].length = 0;
    }
    f.world.w = 40000; f.world.h = 40000;
    f.world.gate.x = -99999; f.world.gate.y = -99999;
    for (const e of (extra || [])) f.world[e.list].push(box(e));
  }
  function box(o) {
    const e = { kind: o.kind || 'solid', x: o.x, y: o.y, w: o.w, h: o.h,
      a: (o.a || 0) * Math.PI / 180, vx: 0, vy: 0, av: 0, gfx: {}, seed: 0, fire: 0 };
    e.ca = Math.cos(e.a); e.sa = Math.sin(e.a);
    e.br = Math.hypot(o.w, o.h) / 2;
    return e;
  }
  function drop(x, y, vx, vy, steps) {
    f.internals.placeSpirit(x, y);
    f.PS.state = 'air'; f.PS.t = 1;
    f.body.vx = vx; f.body.vy = vy; f.body.burst = 0;
    for (let i = 0; i < steps; i++) { f.tick(1); if (f.G.phase !== 'play') break; }
  }
  function standAt(x, y) {
    f.internals.placeSpirit(x, y);
    f.PS.state = 'ground'; f.PS.t = 1; f.PS.coyote = 1;
  }

  /* ---- the burst ------------------------------------------------------ */
  arena();
  standAt(1000, 1000);
  f.burst(-Math.PI / 2, 0);
  assert.equal(+speed().toFixed(6), MOVE.burstMin, 'A zero-power leap uses the tuned floor speed');
  standAt(1000, 1000);
  f.burst(-Math.PI / 2, 1);
  assert.equal(+speed().toFixed(6), MOVE.burstMax, 'A full leap uses the tuned ceiling speed');
  let prev = -1;
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    standAt(1000, 1000);
    f.burst(-Math.PI / 2, p);
    assert(speed() > prev, 'Leap speed must rise with power');
    prev = speed();
  }
  assert(MOVE.burstMax < MOVE.speedMax, 'A leap must leave headroom under the clamp');
  section('leap power band is monotonic and clamped');

  /* ---- gravity: what goes up comes back down, in an arc --------------- */
  arena();
  standAt(1000, 1000);
  f.burst(-Math.PI / 2, 1);
  let apex = 1000, air = 0;
  for (let i = 0; i < 400; i++) {
    f.tick(1); air += 1 / 60;
    apex = Math.min(apex, f.body.y);
    if (f.body.y > 1000 && i > 20) break;
  }
  const rise = 1000 - apex;
  assert(rise > 250 && rise < 450, `A full leap should rise a readable amount (got ${rise.toFixed(0)})`);
  assert(air > 0.9 && air < 2.0, `A full leap should hang for about a second (got ${air.toFixed(2)}s)`);
  // and it must actually come down
  assert(f.body.y > 1000, 'Gravity must bring the spirit back');
  // terminal velocity holds
  drop(1000, 0, 0, 0, 600);
  assert(f.body.vy <= MOVE.fallMax + 1e-9, 'Falling is capped at terminal velocity');
  section('gravity produces a readable arc and a capped fall');

  /* ---- ordinary surfaces catch, they do not bounce -------------------- */
  arena([{ list: 'solids', x: 1000, y: 1400, w: 900, h: 80 }]);
  drop(1000, 600, 0, 0, 240);
  assert.equal(f.PS.state, 'ground', 'A fall onto a floor ends grounded');
  assert.equal(f.body.vy <= 1, true, 'A floor must not throw the spirit back up');
  assert(f.body.y > 1300 && f.body.y < 1360, 'The spirit rests on the surface it landed on');
  // it must never rebound, however hard it arrives
  let maxRebound = 0;
  for (const v of [6, 14, 20, MOVE.fallMax]) {
    arena([{ list: 'solids', x: 1000, y: 1400, w: 900, h: 80 }]);
    drop(1000, 1000, 0, v, 6);
    for (let i = 0; i < 60; i++) { f.tick(1); maxRebound = Math.min(maxRebound, f.body.vy); }
  }
  assert(maxRebound > -1.2, `No ordinary surface may bounce the spirit (worst rebound ${maxRebound.toFixed(2)})`);
  // arriving sideways keeps some slide, then settles
  arena([{ list: 'solids', x: 1000, y: 1400, w: 1400, h: 80 }]);
  drop(700, 1300, 12, 4, 4);
  const slideStart = f.body.x;
  f.tick(120);
  assert(f.body.x > slideStart + 12, 'Landing with sideways speed produces a slide');
  assert.equal(f.body.vx, 0, 'A slide settles to a stop');
  section('floors catch and slide instead of bouncing');

  /* ---- walls: take hold, then let go ---------------------------------- */
  arena([{ list: 'solids', x: 1400, y: 1000, w: 80, h: 900 }]);   // face at x = 1360
  function flyIntoWall() {
    arena([{ list: 'solids', x: 1400, y: 1000, w: 80, h: 900 }]);
    drop(1200, 1000, 14, 0, 1);
    for (let i = 0; i < 90; i++) { f.tick(1); if (f.PS.state === 'cling') return true; }
    return false;
  }
  assert(flyIntoWall(), 'Meeting a wall in flight takes hold of it');
  assert(f.aimable(), 'A wall hold hands control back immediately');
  assert.equal(f.PS.clingSide, -1, 'The hold knows which side the wall is on');
  // full grip first, then a slow readable slide
  const yGrip = f.body.y;
  for (let i = 0; i < Math.floor(MOVE.clingGrip * 60) - 2; i++) f.tick(1);
  assert(Math.abs(f.body.y - yGrip) < 2,
    `The first part of a hold does not slide (drifted ${(f.body.y - yGrip).toFixed(2)})`);
  f.tick(24);
  assert(f.body.y > yGrip + 2, 'A hold slides once the grip runs out');
  assert(f.body.vy <= MOVE.clingSlide + 0.01, 'The slide is slow enough to read');
  // and the hold expires rather than lasting forever
  for (let i = 0; i < 200; i++) { f.tick(1); if (f.PS.state !== 'cling') break; }
  assert.notEqual(f.PS.state, 'cling', 'A wall hold must expire');
  // a leap off a wall clears the wall
  assert(flyIntoWall());
  f.burst(-Math.PI / 2, 1);                       // straight up, along the face
  f.tick(20);
  assert(f.body.x < 1355, 'A leap off a wall pushes clear of it');
  assert(f.body.y < 1000, 'A leap off a wall still gains height');
  section('wall holds grip, slide, expire and push off cleanly');

  /* ---- energy nodes ---------------------------------------------------- */
  arena();
  f.world.nodes.push({ kind: 'node', x: 1000, y: 700, r: 26, cool: 0, glow: 0, spin: 0,
    br: 26, gfx: {}, seed: 0, vx: 0, vy: 0, av: 0 });
  const nd = f.world.nodes[0];
  drop(1000, 300, 0, 2, 1);                       // fall past it from above
  let sawReach = false;
  for (let i = 0; i < 200; i++) { f.tick(1); if (T.nodeInReach()) { sawReach = true; break; } }
  assert(sawReach, 'Flying past a node puts it in reach');
  T.grabNode(nd, f.body.x, f.body.y, null);
  assert.equal(f.PS.state, 'node', 'Taking a node holds the spirit');
  assert.equal(speed(), 0, 'A node arrests the spirit completely');
  assert(f.aimable(), 'A held spirit may aim');
  // the world is frozen while the wind-up is held
  const frozen = { t: f.G.t, x: f.body.x };
  f.tick(20);
  assert.equal(f.G.t, frozen.t, 'A wind-up freezes the world');
  // and it is drawn into the node while held
  assert(Math.hypot(f.body.x - nd.x, f.body.y - nd.y) < 4, 'A node draws the spirit in');
  f.Aim.on = false;
  f.burst(-Math.PI / 2, 1);
  assert.equal(+speed().toFixed(6), MOVE.nodeBurst, 'A node releases at its own speed');
  assert(nd.cool > 0, 'A spent node goes dark');
  assert.equal(T.nodeInReach(), null, 'A dark node cannot catch you again');
  for (let i = 0; i < Math.ceil(MOVE.nodeCool * 60) + 2; i++) f.tick(1);
  assert.equal(nd.cool, 0, 'A node recharges');
  // no infinite redirects: a node cannot be taken while grounded
  arena([{ list: 'solids', x: 1000, y: 1400, w: 900, h: 80 }]);
  f.world.nodes.push({ kind: 'node', x: 1000, y: 1340, r: 26, cool: 0, glow: 0, spin: 0,
    br: 26, gfx: {}, seed: 0, vx: 0, vy: 0, av: 0 });
  drop(1000, 1000, 0, 0, 200);
  assert.equal(f.PS.state, 'ground');
  assert.equal(T.nodeInReach(), null, 'Nodes only catch a spirit that is airborne');
  section('nodes catch, freeze, throw, recharge and cannot be spammed');

  /* ---- spirit springs --------------------------------------------------- */
  arena([{ list: 'solids', x: 1000, y: 1400, w: 900, h: 80 }]);
  f.world.springs.push(box({ kind: 'spring', x: 1000, y: 1340, w: 170, h: 36 }));
  drop(1000, 900, 0, 6, 1);
  let springApex = 9999, fired = false, fireY = 0;
  for (let i = 0; i < 300; i++) {
    f.tick(1);
    if (!fired && f.world.springs[0].fire > 0.9) { fired = true; fireY = f.body.y; }
    if (fired) springApex = Math.min(springApex, f.body.y);
    if (fired && f.PS.state === 'ground' && i > 30) break;
  }
  assert(fired, 'A spring fires when the spirit reaches it');
  const lift = fireY - springApex;
  assert(lift > 300, `A spring throws the spirit far above its face (got ${lift.toFixed(0)})`);
  assert(lift > 250 + MOVE.burstMax * 8, 'A spring must give more height than a standing leap');
  // direction follows the spring's face, not the approach
  arena();
  f.world.springs.push(box({ kind: 'spring', x: 1400, y: 1000, w: 170, h: 36, a: -90 }));
  drop(1300, 1000, 12, 0, 12);
  assert(f.body.vx < -10, 'A sideways spring throws sideways, whatever the approach');
  assert(Math.abs(f.body.vy) < 6, 'A sideways spring does not throw you upward');
  section('springs throw along their own face, predictably');

  /* ---- collision stability ---------------------------------------------- */
  // Neighbouring approaches into a corner must not diverge: a one-unit change
  // in where you start may only produce about a one-unit change in where you
  // end up. This is the property that makes a rebound worth aiming.
  const ex = [], ey = [];
  for (let d = -2; d <= 2; d++) {
    arena([{ list: 'solids', x: 1000, y: 1400, w: 900, h: 80 },
           { list: 'solids', x: 1400, y: 1000, w: 80, h: 900 }]);
    drop(1000 + d, 1000, 12, 12, 40);
    ex.push(f.body.x); ey.push(f.body.y);
  }
  const spreadX = Math.max(...ex) - Math.min(...ex);
  const spreadY = Math.max(...ey) - Math.min(...ey);
  assert(spreadX < 12 && spreadY < 4,
    `A corner must resolve consistently (4 units of input became ${spreadX.toFixed(1)} x ${spreadY.toFixed(1)})`);
  // thin geometry must not be tunnelled, even at the clamp
  for (const v of [MOVE.fallMax, MOVE.speedMax]) {
    arena([{ list: 'solids', x: 1000, y: 1200, w: 700, h: 14 }]);
    drop(1000, 600, 0, v, 30);
    assert(f.body.y < 1200, `${v} units/step tunnelled through thin geometry`);
  }
  // a narrow channel must not vibrate
  arena([{ list: 'solids', x: 968, y: 1000, w: 60, h: 900 },
         { list: 'solids', x: 1032, y: 1000, w: 60, h: 900 }]);
  drop(1000, 400, 0.8, 8, 1);
  let flips = 0, lastVx = f.body.vx;
  for (let i = 0; i < 200; i++) {
    f.tick(1);
    if (f.body.vx * lastVx < 0) flips++;
    lastVx = f.body.vx;
  }
  assert(flips <= 4, `A narrow channel must not make the spirit vibrate (${flips} reversals)`);
  section('corners are deterministic, thin walls hold, channels stay quiet');

  /* ---- failure and checkpoints ------------------------------------------ */
  f.go(4);                                  // a level with motes
  const mote = f.world.motes[0];
  const start = { x: f.G.spawnX, y: f.G.spawnY };
  f.internals.placeSpirit(mote.x, mote.y + 4);
  f.PS.state = 'air'; f.PS.t = 1;                 // past the reform, in flight
  f.tick(2);
  assert(mote.got, 'Touching a mote claims it');
  assert.notEqual(f.G.spawnY, start.y, 'A claimed mote becomes the respawn point');
  T.killSpirit('hazard');
  assert.equal(f.PS.state, 'hurt', 'A hazard dissolves the spirit');
  let respawnSteps = 0;
  for (let i = 0; i < 200; i++) { f.tick(1); respawnSteps++; if (f.PS.state !== 'hurt') break; }
  assert(respawnSteps / 60 < 0.5, `Respawn must be fast (took ${(respawnSteps / 60).toFixed(2)}s)`);
  assert(Math.abs(f.body.x - mote.x) < 2, 'Respawn puts the spirit back at the last mote');
  for (let i = 0; i < 90; i++) f.tick(1);
  assert(f.aimable(), 'Control returns shortly after a respawn');
  // leaving the world in any direction is fatal
  for (const [dx, dy] of [[0, 9999], [-9999, 0], [9999, 0]]) {
    f.go(0);
    f.tick(60);
    f.body.x = f.LEVELS[0].spawn.x + dx; f.body.y = f.LEVELS[0].spawn.y + dy;
    f.tick(2);
    assert.equal(f.PS.state, 'hurt', 'Leaving the world dissolves the spirit');
  }
  section('death is fast, checkpoints hold, the void is a boundary');

  /* ---- hazards ----------------------------------------------------------- */
  f.go(5);                                  // has beams
  const beam = f.world.beams[0];
  let litSeen = false, darkSeen = false;
  for (let i = 0; i < 400; i++) { f.tick(1); if (beam.k > 0.9) litSeen = true; if (beam.k <= 0) darkSeen = true; }
  assert(litSeen && darkSeen, 'A pulsing beam must actually cycle');
  f.go(5);
  const beam2 = f.world.beams[0];             // go() rebuilds: re-fetch it
  f.tick(30);
  // park the spirit inside the beam and wait for it to light
  let killedWhileLit = false, survivedWhileDark = false;
  for (let i = 0; i < 400; i++) {
    f.internals.placeSpirit(beam2.x, beam2.y);
    f.PS.state = 'air'; f.PS.t = 1;
    f.tick(1);                                // this is the tick that sets k
    if (f.PS.state === 'hurt') { if (beam2.k > 0.35) killedWhileLit = true; break; }
    if (beam2.k <= 0) survivedWhileDark = true;
  }
  assert(killedWhileLit, 'A lit beam kills');
  assert(survivedWhileDark, 'A dark beam is safe to stand in');
  section('beams cycle and kill only while lit');

  /* ---- input: one gesture, mouse and touch identical ---------------------- */
  const inp = boot();
  const pt = (x, y, id = 5) => ({ clientX: x, clientY: y, pointerId: id, button: 0,
    target: inp.canvas, preventDefault() {} });
  const screen = (wx, wy) => [wx - inp.cam.x + 270, wy - inp.cam.y + 480];
  inp.go(0);
  inp.tick(90);
  assert(inp.aimable(), 'grounded before the input test');
  let [sx, sy] = screen(inp.body.x, inp.body.y);
  inp.events.pointerdown(pt(sx, sy));
  assert.equal(inp.Aim.on, true, 'A touch on the spirit starts a wind-up');
  assert.equal(inp.Aim.power, 0, 'A centred touch starts at zero power');
  inp.events.pointermove(pt(sx, sy + 4));
  inp.events.pointerup(pt(sx, sy + 4));
  assert.equal(inp.G.bursts, 0, 'A drag inside the dead zone is a cancel');
  // a full drag downward should leap upward
  inp.events.pointerdown(pt(sx, sy));
  inp.events.pointermove(pt(sx, sy + 400));
  assert.equal(inp.Aim.power, 1, 'Drag power saturates at the tuned distance');
  inp.events.pointerup(pt(sx, sy + 400));
  assert.equal(inp.G.bursts, 1, 'A full drag leaps');
  assert(inp.body.vy < 0, 'Dragging down leaps up');
  assert.equal(+Math.hypot(inp.body.vx, inp.body.vy).toFixed(6), MOVE.burstMax);
  // a touch anywhere on the screen still works
  inp.go(0); inp.tick(90);
  [sx, sy] = screen(inp.body.x + 230, inp.body.y - 300);
  inp.events.pointerdown(pt(sx, sy));
  assert.equal(inp.Aim.on, true, 'A touch far from the spirit still starts a wind-up');
  inp.events.pointercancel();
  assert.equal(inp.Aim.on, false, 'A cancelled pointer cancels the wind-up');
  assert.equal(inp.G.bursts, 0, 'A cancelled wind-up does not leap');
  // a second finger cannot hijack a wind-up
  inp.go(0); inp.tick(90);
  [sx, sy] = screen(inp.body.x, inp.body.y);
  inp.events.pointerdown(pt(sx, sy, 1));
  inp.events.pointermove(pt(sx, sy + 300, 1));
  inp.events.pointerup(pt(sx, sy + 300, 2));
  assert.equal(inp.Aim.on, true, 'Another finger must not release the wind-up');
  inp.events.pointerup(pt(sx, sy + 300, 1));
  assert.equal(inp.Aim.on, false);
  // a wind-up held forever lapses instead of pausing the game
  inp.go(0); inp.tick(90);
  [sx, sy] = screen(inp.body.x, inp.body.y);
  inp.events.pointerdown(pt(sx, sy));
  inp.tick(Math.ceil(MOVE.aimHold * 60) + 4);
  assert.equal(inp.Aim.on, false, 'A wind-up held too long lapses');
  section('one gesture, identical for mouse and touch, safe against stray fingers');

  /* ---- input forgiveness --------------------------------------------------- */
  const fg = boot();
  const pt2 = (x, y, id = 9) => ({ clientX: x, clientY: y, pointerId: id, button: 0,
    target: fg.canvas, preventDefault() {} });
  // pressing just before landing is spent on landing, not thrown away
  fg.go(0); fg.tick(90);
  fg.burst(-Math.PI / 2, 1);
  fg.tick(60);
  assert.equal(fg.state(), 'air');
  const before = fg.G.bursts;
  fg.events.pointerdown(pt2(270, 480));
  assert.equal(fg.Aim.on, false, 'An early press does not act immediately');
  assert(fg.internals.buffered.on, 'An early press is held');
  for (let i = 0; i < 240 && !fg.Aim.on; i++) fg.tick(1);
  assert.equal(fg.Aim.on, true, 'A held press becomes a wind-up when control returns');
  assert.equal(fg.G.bursts, before, 'Buffering does not leap on its own');
  fg.internals.cancelAim();
  // coyote time: aiming still works just after walking off an edge
  arenaOn(fg);
  fg.internals.placeSpirit(1000, 1000);
  fg.PS.state = 'ground'; fg.PS.coyote = MOVE.coyote; fg.PS.t = 1;
  fg.tick(2);
  assert.equal(fg.state(), 'air', 'stepping into empty air');
  assert(fg.aimable(), 'Coyote time lets a leap happen just after leaving a surface');
  fg.tick(Math.ceil(MOVE.coyote * 60) + 4);
  assert(!fg.aimable(), 'Coyote time runs out');
  section('early presses are buffered and leaving an edge is forgiven');

  function arenaOn(g) {
    g.go(0);
    for (const k of ['solids', 'springs', 'nodes', 'motes', 'lethal', 'beams', 'movers']) g.world[k].length = 0;
    g.world.w = 40000; g.world.h = 40000;
    g.world.gate.x = -99999; g.world.gate.y = -99999;
  }

  /* ---- camera -------------------------------------------------------------- */
  f.go(5);
  f.tick(40);
  assert(Math.abs(f.cam.x - f.body.x) < 400 && Math.abs(f.cam.y - f.body.y) < 500,
    'The camera stays with the spirit');
  // and never drifts further than the padding past the world edge
  const padX = 270 - 95, padY = 480 - 95;
  for (let i = 0; i < 400; i++) {
    f.tick(1);
    assert(f.cam.x >= padX - 1 && f.cam.x <= f.world.w - padX + 1,
      'Camera stays within the padded world horizontally');
    assert(f.cam.y >= padY - 1 && f.cam.y <= f.world.h - padY + 1,
      'Camera stays within the padded world vertically');
  }
  section('the camera follows and never leaves the world');

  /* ---- progression, restart, scaling ---------------------------------------- */
  f.go(2);
  const spawn2 = { x: f.body.x, y: f.body.y };
  f.burst(0, 1); f.tick(40);
  f.internals.restartLevel(true);
  assert.equal(f.G.levelIndex, 2, 'Restart keeps the level');
  assert.equal(f.G.bursts, 0, 'Restart resets the leap count');
  assert(Math.abs(f.body.x - spawn2.x) < 2, 'Restart returns the spirit to the start');
  f.go(0);
  f.tick(60);                                    // past the reform, in control
  f.body.x = f.world.gate.x; f.body.y = f.world.gate.y;
  f.tick(2);
  assert.equal(f.G.phase, 'win', 'Reaching the gate wins');
  for (let i = 0; i < 300 && f.G.levelIndex === 0; i++) f.tick(1);
  assert.equal(f.G.levelIndex, 1, 'A win advances to the next level');

  f.resize(1800, 3200);
  assert(f.canvas.width * f.canvas.height <= 1100000, 'Desktop pixel budget');
  f.Q.level = 0; f.resize(1800, 3200);
  assert(f.canvas.width * f.canvas.height <= 700000, 'Reduced pixel budget');
  f.resize(390, 693);
  assert(f.canvas.width * f.canvas.height <= 700000, 'Mobile pixel budget');
  f.Q.level = 1;
  section('progression, restart and every pixel budget hold');

  /* ---- frame loop: no catch-up, no drift ------------------------------------ */
  const lp = boot();
  lp.internals.frame(1000); lp.internals.frame(1017);
  const t0 = lp.G.t;
  lp.document.hidden = true; lp.events.visibilitychange(); lp.internals.frame(5000);
  assert.equal(lp.G.t, t0, 'A hidden tab must not advance the simulation');
  lp.document.hidden = false; lp.events.visibilitychange(); lp.internals.frame(10000);
  assert.equal(lp.G.t, t0, 'Resuming must not replay the hidden time');
  const adaptive = boot();
  for (let i = 0; i < 100; i++) adaptive.internals.frame(1000 + i * 34);
  assert.equal(adaptive.Q.level, 0, 'Slow frames reduce decoration quality');
  for (let i = 0; i < 650; i++) adaptive.internals.frame(4400 + i * (1000 / 60));
  assert.equal(adaptive.Q.level, 1, 'Quality recovers on a healthy display');
  section('frame loop clamps stalls and adapts quality');

  /* ---- the aim guide tells the truth ----------------------------------------- */
  arena([{ list: 'solids', x: 1000, y: 1400, w: 1200, h: 80 }]);
  standAt(700, 1340);
  const ang = -0.9, power = 1;
  const sp = MOVE.burstMin + (MOVE.burstMax - MOVE.burstMin) * f.internals.burstCurve(power);
  const guide = T.predict(f.body.x, f.body.y, Math.cos(ang) * sp, Math.sin(ang) * sp, 1400);
  assert(guide.n > 2, 'The guide draws a path');
  const predicted = { x: guide.lx, y: guide.ly };
  assert(guide.land >= 0, 'The guide finds where the leap ends');
  standAt(700, 1340);
  f.burst(ang, power);
  for (let i = 0; i < 400; i++) { f.tick(1); if (f.PS.state === 'ground') break; }
  assert(Math.hypot(f.body.x - predicted.x, f.body.y - predicted.y) < 40,
    `The guide must land where the leap lands (off by ${Math.hypot(f.body.x - predicted.x, f.body.y - predicted.y).toFixed(0)})`);
  section('the aim guide matches the simulation it previews');

  console.log('PASS:\n  - ' + pass.join('\n  - '));
}

module.exports = { boot };
