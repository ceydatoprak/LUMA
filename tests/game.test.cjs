// Behaviour tests for FLUX. Everything runs the real simulation through the
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
  f.burst(-Math.PI / 2, 1);
  assert.equal(+speed().toFixed(6), +MOVE.burstMax.toFixed(6), 'A full leap uses the tuned ceiling speed');
  standAt(1000, 1000);
  f.burst(-Math.PI / 2, 0);
  const floorSpeed = speed();
  assert(Math.abs(floorSpeed - MOVE.burstMax * Math.sqrt(MOVE.reachMin)) < 1e-6,
    'A zero-power leap uses the floor implied by reachMin');
  let prev = -1;
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    standAt(1000, 1000);
    f.burst(-Math.PI / 2, p);
    assert(speed() > prev, 'Leap speed must rise with power');
    prev = speed();
  }
  assert(MOVE.burstMax < MOVE.speedMax, 'A leap must leave headroom under the clamp');
  section('leap power band is monotonic and clamped');

  /* ---- TEST E: the three pulls must produce genuinely different leaps ----
     The complaint this fixes was that a short pull went almost as far as a
     full one. Reach, not speed, is what the player perceives, so reach is what
     is measured here. */
  function reachAt(power) {
    arena();
    standAt(1000, 1000);
    f.burst(-Math.PI / 4, power);
    for (let i = 0; i < 900; i++) { f.tick(1); if (f.body.y > 1004 && i > 12) break; }
    return f.body.x - 1000;
  }
  {
    const short = reachAt(T.powerCurve(0.2));
    const medium = reachAt(T.powerCurve(0.55));
    const full = reachAt(1);
    const sPct = short / full, mPct = medium / full;
    assert(sPct > 0.35 && sPct < 0.62,
      `A short pull should reach about 40-60% of a full one (got ${(sPct * 100) | 0}%)`);
    assert(mPct > 0.62 && mPct < 0.88,
      `A medium pull should reach about 70-85% of a full one (got ${(mPct * 100) | 0}%)`);
    assert(medium - short > full * 0.15 && full - medium > full * 0.12,
      'Short, medium and full must be clearly different leaps, not three shades of one');
  }
  section('short, medium and full pulls are three distinct leaps');

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

  /* ---- wall to the top of the same block --------------------------------
     The most natural move in the game and, until this was fixed, an
     impossible one: the safety kick rewrote the sideways half of the launch,
     so pulling up-and-over produced a leap in the opposite direction. Both
     sides are checked, because a bug here is almost always one-sided. */
  function blockArena() {
    arena();
    const b = box({ list: 'solids', x: 2000, y: 2200, w: 400, h: 600 });
    f.world.solids.push(b);
    return b;                     // top 1900, faces at 1800 and 2200
  }
  function holdWall(b, side, below) {
    const top = b.y - b.h / 2;
    const face = side > 0 ? b.x + b.w / 2 : b.x - b.w / 2;
    f.internals.placeSpirit(face + side * (f.body.r + 0.1), top + below);
    f.PS.state = 'cling'; f.PS.t = 1; f.PS.clingT = 0;
    f.PS.clingSide = side; f.PS.clingWall = b;
    f.body.vx = 0; f.body.vy = 0;
  }
  function wallToTop(side, deg, below) {
    const b = blockArena();
    const top = b.y - b.h / 2;
    holdWall(b, side, below);
    f.burst(deg * Math.PI / 180, 0.8);
    assert.notEqual(f.PS.state, 'cling', 'the launch must detach from the wall');
    let regrabbed = false;
    for (let i = 0; i < 400; i++) {
      f.tick(1);
      if (f.PS.state === 'cling') { regrabbed = true; break; }
      if (f.PS.state === 'ground') break;
      if (f.PS.state === 'hurt') break;
    }
    return {
      regrabbed,
      grounded: f.PS.state === 'ground',
      onTop: Math.abs((f.body.y + f.body.r) - top) < 26 &&
             f.body.x > b.x - b.w / 2 && f.body.x < b.x + b.w / 2,
      aimable: f.aimable(),
    };
  }
  {
    // holding the RIGHT face, pulling so it launches up and to the LEFT
    for (const deg of [-155, -135, -115, -95]) {
      const r = wallToTop(1, deg, 40);
      assert(!r.regrabbed, `Right face, aim ${deg}: must not be caught by the same wall again`);
      assert(r.onTop, `Right face, aim ${deg}: must clear the corner and land on top`);
      assert(r.aimable, `Right face, aim ${deg}: must hand control back on top`);
    }
    // ...and the mirror image, holding the LEFT face
    for (const deg of [-25, -45, -65, -85]) {
      const r = wallToTop(-1, deg, 40);
      assert(!r.regrabbed, `Left face, aim ${deg}: must not be caught by the same wall again`);
      assert(r.onTop, `Left face, aim ${deg}: must clear the corner and land on top`);
      assert(r.aimable, `Left face, aim ${deg}: must hand control back on top`);
    }
    // it works from well down the face too, not only right under the lip
    for (const below of [15, 90, 160]) {
      assert(wallToTop(1, -120, below).onTop, `Right face from ${below} below the top`);
      assert(wallToTop(-1, -60, below).onTop, `Left face from ${below} below the top`);
    }
    // the window is wide, not pixel-perfect
    let window = 0, run = 0;
    for (let d = -180; d < 0; d += 5) {
      if (wallToTop(1, d, 40).onTop) { run += 5; window = Math.max(window, run); } else run = 0;
    }
    assert(window >= 45, `Wall-to-top must not need precise aiming (window ${window}deg)`);

    // the player's chosen direction must survive the safety kick
    const b = blockArena();
    holdWall(b, 1, 40);
    const sp = T.launchSpeed(0.8, false);
    const ang = -130 * Math.PI / 180;
    f.burst(ang, 0.8);
    assert(f.body.vx < 0,
      'Pulling up-and-over a right-hand wall must launch leftward, not be flipped outward');
    assert(Math.abs(f.body.vx - Math.cos(ang) * sp) < 0.01,
      'An upward aim off a wall is taken literally');
    // ...while a flat aim still gets pushed clear of the face
    holdWall(b, 1, 40);
    f.burst(Math.PI, 0.8);                       // straight at the wall, no lift
    assert(f.body.vx > 0, 'A flat aim into the wall is still pushed clear of it');

    // and the guide agrees with all of it
    holdWall(b, 1, 40);
    f.Aim.on = true; f.Aim.angle = -130 * Math.PI / 180; f.Aim.power = 0.8;
    f.Aim.pull = 0.8; f.Aim.pullLen = MOVE.dragFull * 0.8;
    T.refreshAimPreview();
    const pv = T.preview;
    assert(pv.land >= 0, 'A wall-to-top launch is previewed to its landing');
    const pred = { x: pv.lx, y: pv.ly };
    T.cancelAim();
    holdWall(b, 1, 40);
    f.burst(-130 * Math.PI / 180, 0.8);
    let hit = null;
    for (let i = 0; i < 400; i++) {
      f.tick(1);
      if (f.PS.state === 'ground' || f.PS.state === 'cling') { hit = { x: f.body.x, y: f.body.y }; break; }
    }
    assert(hit && Math.hypot(hit.x - pred.x, hit.y - pred.y) < 6,
      'The guide must show the corner-clearing arc the spirit actually flies');
  }
  section('wall to the top of the same block works from both sides, widely');

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
  // the canvas is 540x960 in the harness, so client coords ARE screen coords
  const screen = (wx, wy) => [wx - inp.cam.x + 270, wy - inp.cam.y + 480];
  inp.go(0);
  inp.tick(90);
  assert(inp.aimable(), 'grounded before the input test');
  let [sx, sy] = screen(inp.body.x, inp.body.y);
  inp.events.pointerdown(pt(sx, sy));
  assert.equal(inp.Aim.on, true, 'A touch starts a stretch');
  assert.equal(inp.Aim.power, 0, 'Any touch starts at zero power');
  inp.events.pointermove(pt(sx, sy + 4));
  inp.events.pointerup(pt(sx, sy + 4));
  assert.equal(inp.G.bursts, 0, 'A pull inside the dead zone is a cancel');

  // The slingshot: you pull BACKWARD and the spirit launches the other way.
  // This is the control the whole game rests on, so all four are checked.
  const dirs = [
    ['down',  0,  400, 'up',    (b) => b.vy < -8 && Math.abs(b.vx) < 3],
    ['up',    0, -400, 'down',  (b) => b.vy > 8 && Math.abs(b.vx) < 3],
    ['left', -400, 0,  'right', (b) => b.vx > 8 && Math.abs(b.vy) < 3],
    ['right', 400, 0,  'left',  (b) => b.vx < -8 && Math.abs(b.vy) < 3],
  ];
  for (const [pull, dx, dy, go, ok] of dirs) {
    inp.go(0); inp.tick(90);
    [sx, sy] = screen(inp.body.x, inp.body.y);
    inp.events.pointerdown(pt(sx, sy));
    inp.events.pointermove(pt(sx + dx, sy + dy));
    assert.equal(inp.Aim.power, 1, 'Pull power saturates at the tuned distance');
    inp.events.pointerup(pt(sx + dx, sy + dy));
    assert.equal(inp.G.bursts, 1, `Pulling ${pull} leaps`);
    assert(ok(inp.body), `Pulling ${pull} must launch ${go}`);
    assert.equal(+Math.hypot(inp.body.vx, inp.body.vy).toFixed(6), +MOVE.burstMax.toFixed(6));
  }
  // a short pull still goes somewhere useful
  inp.go(0); inp.tick(90);
  [sx, sy] = screen(inp.body.x, inp.body.y);
  inp.events.pointerdown(pt(sx, sy));
  inp.events.pointermove(pt(sx, sy + MOVE.dragDead + 6));
  inp.events.pointerup(pt(sx, sy + MOVE.dragDead + 6));
  assert(Math.hypot(inp.body.vx, inp.body.vy) >= MOVE.burstMax * Math.sqrt(MOVE.reachMin) - 1e-6,
    'The smallest real pull still leaps at the floor speed');
  assert(inp.body.vy < 0, 'A small downward pull still launches upward');
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
  /* Thinking is not a timeout. A player presses, looks at the level, decides
     where to go, and only then drags — and that has to still work. This was
     the bug that made the controls feel dead: the stretch was being cancelled
     out from under a held finger after a couple of seconds, and after that
     neither dragging nor releasing did anything. */
  for (const think of [1, 3, 6, 10]) {
    inp.go(0); inp.tick(90);
    const before = inp.G.bursts;
    [sx, sy] = screen(inp.body.x, inp.body.y);
    inp.events.pointerdown(pt(sx, sy));
    inp.tick(think * 60);                        // hold still and deliberate
    assert.equal(inp.Aim.on, true, `Holding still for ${think}s must not cancel the stretch`);
    inp.events.pointermove(pt(sx, sy + 200));
    assert(inp.Aim.power > 0, `Dragging after ${think}s of thinking must still aim`);
    inp.events.pointerup(pt(sx, sy + 200));
    assert.equal(inp.G.bursts, before + 1, `Releasing after ${think}s of thinking must leap`);
    assert(inp.body.vy < 0, 'and it still launches the way the pull says');
  }
  /* A drag must also survive the game resizing its own canvas underneath it.
     The adaptive quality system reassigns the backing store when frames get
     slow, which drops pointer capture — on a weaker machine that quietly
     killed the gesture mid-drag. */
  inp.go(0); inp.tick(90);
  {
    const before = inp.G.bursts;
    [sx, sy] = screen(inp.body.x, inp.body.y);
    inp.events.pointerdown(pt(sx, sy));
    inp.events.pointermove(pt(sx, sy + 120));
    const aimedPower = inp.Aim.power;
    inp.resize(900, 1500);                       // as a quality change would
    inp.Q.level = 0; inp.resize(900, 1500);
    assert.equal(inp.Aim.on, true, 'A canvas resize must not cancel a drag in progress');
    assert.equal(inp.Aim.power, aimedPower, 'and it must not disturb the aim');
    inp.events.pointerup(pt(sx, sy + 120));
    assert.equal(inp.G.bursts, before + 1, 'the drag still launches after a resize');
    inp.Q.level = 1;
  }

  // the lapse is only a stuck-pointer guard, and it is long and not silent
  assert(MOVE.aimHold >= 15, 'The hold guard must be far longer than anyone deliberates');
  inp.go(0); inp.tick(90);
  [sx, sy] = screen(inp.body.x, inp.body.y);
  inp.events.pointerdown(pt(sx, sy));
  inp.tick(Math.ceil(MOVE.aimHold * 60) + 4);
  assert.equal(inp.Aim.on, false, 'A pointer the browser forgot about does eventually lapse');
  assert(inp.G.deny > 0, 'and the lapse is shown, never silent');
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

  /* ---- landing assist ------------------------------------------------------
     Coming down a hand's width short of a ledge should not end a run. */
  arena([{ list: 'solids', x: 1200, y: 1400, w: 500, h: 80 }]);   // left edge at 950
  // a fall that misses the edge by a little must be caught
  drop(950 - 22, 900, 0, 4, 1);
  let caught = false;
  for (let i = 0; i < 200; i++) { f.tick(1); if (f.PS.state === 'ground') { caught = true; break; } }
  assert(caught, 'A near miss at a ledge edge is nudged onto it');
  // a miss by much more than the assist reach is still a miss
  arena([{ list: 'solids', x: 1200, y: 1400, w: 500, h: 80 }]);
  drop(950 - MOVE.assistReach * 3, 900, 0, 4, 1);
  let alsoCaught = false;
  for (let i = 0; i < 200; i++) { f.tick(1); if (f.PS.state === 'ground') { alsoCaught = true; break; } }
  assert(!alsoCaught, 'The assist must not reach out and grab a clear miss');
  // and it never fires upward or while rising
  arena([{ list: 'solids', x: 1200, y: 1400, w: 500, h: 80 }]);
  drop(900, 1200, 0, -10, 1);
  const vx0 = f.body.vx;
  f.tick(1);
  assert.equal(f.body.vx, vx0 * MOVE.airDrag, 'The assist does nothing while the spirit is rising');
  section('landing assist catches near misses without grabbing clear ones');

  /* ---- the camera frames the leap ------------------------------------------- */
  f.go(0);
  f.tick(120);
  /* Start a real stretch through the real input path: a pointer-down, then a
     pointer-move to a screen offset. `launchDeg` is where the player wants to
     GO, so the finger goes the opposite way. */
  function stretch(g, launchDeg, pullFraction) {
    const a = launchDeg * Math.PI / 180;
    const len = MOVE.dragDead + (MOVE.dragFull - MOVE.dragDead) * pullFraction;
    const ax = 270, ay = 480;                       // anchor: middle of the screen
    T.beginAim(ax, ay, null);
    T.updateDrag(ax - Math.cos(a) * len, ay - Math.sin(a) * len);
    return { len };
  }
  function holdFrames(n) {
    for (let i = 0; i < n; i++) { T.refreshAimPreview(); T.updateCamera(false); }
  }

  /* ---- TEST A: a stationary finger must not move the aim ------------------
     The camera moves for a second and a half underneath a completely still
     pointer. If anything about the aim changes by even a float wobble, the
     input is reading the camera somewhere and the whole thing breathes. */
  f.go(0); f.tick(120);
  {
    stretch(f, -50, 0.7);
    T.updateCamera(true);
    const a0 = f.Aim.angle, p0 = f.Aim.power, pull0 = f.Aim.pull;
    holdFrames(150);
    assert.equal(f.Aim.angle, a0, 'A stationary pointer must not change the aim angle');
    assert.equal(f.Aim.power, p0, 'A stationary pointer must not change the aim power');
    assert.equal(f.Aim.pull, pull0, 'A stationary pointer must not change the stretch');
    T.cancelAim();
  }
  section('TEST A — a held stretch does not drift while the camera moves');

  /* ---- TEST B: the same finger movement means the same leap, at any zoom -- */
  f.go(0); f.tick(120);
  {
    const results = [];
    for (const z of [1.0, 0.85, 0.75, MOVE.zoomAim]) {
      f.cam.zoom = z; f.cam.tzoom = z;
      f.cam.x = f.body.x + 137; f.cam.y = f.body.y - 211;   // and any camera position
      stretch(f, -50, 0.7);
      results.push({ z, a: f.Aim.angle, p: f.Aim.power });
      T.cancelAim();
    }
    for (const r of results.slice(1)) {
      assert.equal(r.a, results[0].a, `Aim angle must not depend on camera zoom (${r.z})`);
      assert.equal(r.p, results[0].p, `Aim power must not depend on camera zoom (${r.z})`);
    }
  }
  section('TEST B — aim is identical at every camera zoom and position');

  /* ---- TEST C: the zoom must converge, never oscillate -------------------- */
  f.go(0); f.tick(120);
  {
    stretch(f, -50, 1);
    T.updateCamera(true);
    f.cam.zoom = 1;                                  // start away from the target
    let reversals = 0, prevDir = 0;
    const zs = [];
    for (let i = 0; i < 240; i++) {
      const before = f.cam.zoom;
      T.refreshAimPreview(); T.updateCamera(false);
      const d = f.cam.zoom - before;
      if (Math.abs(d) > 1e-6) {
        const dir = Math.sign(d);
        if (prevDir && dir !== prevDir) reversals++;
        prevDir = dir;
      }
      zs.push(f.cam.zoom);
    }
    assert.equal(reversals, 0, `Aim zoom must converge without reversing (${reversals} reversals)`);
    const last = zs.slice(-30);
    assert(Math.max(...last) - Math.min(...last) < 1e-4, 'Aim zoom must settle and stay settled');
    assert(Math.abs(zs[zs.length - 1] - f.cam.tzoom) < 1e-3, 'Aim zoom settles on its target');
    T.cancelAim();
  }
  section('TEST C — aim zoom converges once, with no oscillation');

  /* ---- TEST D: the guide must match the jump it previews ------------------ */
  f.go(0); f.tick(120);
  {
    stretch(f, -50, 0.6);
    T.refreshAimPreview();
    const pv = T.preview;
    assert(pv.n > 2, 'A held stretch produces a trajectory');
    assert(pv.land >= 0, 'and the guide finds where it ends');
    const pred = { x: pv.lx, y: pv.ly };
    const a = f.Aim.angle, p = f.Aim.power;
    T.cancelAim();
    f.burst(a, p);
    let hit = null;
    for (let i = 0; i < 400; i++) {
      f.tick(1);
      if (f.PS.state === 'ground' || f.PS.state === 'cling') { hit = { x: f.body.x, y: f.body.y }; break; }
    }
    assert(hit, 'the previewed leap actually lands');
    const off = Math.hypot(hit.x - pred.x, hit.y - pred.y);
    assert(off < 24, `The guide must land where the leap lands (off by ${off.toFixed(1)})`);
  }
  section('TEST D — the guide and the jump are the same simulation');

  /* ---- the camera keeps the spirit in shot, whatever is aimed ------------- */
  f.go(0); f.tick(120);
  {
    for (const pull of [0.05, 0.3, 0.6, 1]) {
      for (const deg of [-135, -90, -45, 0]) {
        stretch(f, deg, pull);
        T.updateCamera(true);
        holdFrames(80);
        const z = f.cam.zoom;
        assert(Math.abs(f.body.x - f.cam.x) < 270 / z && Math.abs(f.body.y - f.cam.y) < 480 / z,
          `The camera must never lead so far that the spirit leaves the screen (${deg}deg pull ${pull})`);
        assert(z <= 1 + 1e-9 && z >= MOVE.zoomAim - 1e-6, 'Aim zoom stays inside its tuned range');
        T.cancelAim();
      }
    }
    // the zoom-out is present but restrained
    assert(MOVE.zoomAim >= 0.78 && MOVE.zoomAim <= 0.9,
      'Aim zoom-out should open the view without shrinking the world');
  }
  section('the camera leads the launch and always keeps the spirit in shot');

  /* ---- levels are compact and declare a route ------------------------------- */
  for (let i = 0; i < f.LEVELS.length; i++) {
    const L = f.LEVELS[i];
    assert(Array.isArray(L.route) && L.route.length >= 2,
      `Level ${i + 1}: must declare the route it intends`);
    // A guard against levels sprawling, not a hard design rule. Level 1 sits
    // near the top of it on purpose: its ledges are deliberately huge so that
    // almost any forward pull lands on one, and that costs width.
    assert(L.w <= 1620 && L.h <= 1700,
      `Level ${i + 1}: world is larger than a handcrafted space needs (${L.w}x${L.h})`);
  }
  // the first level teaches one thing and introduces nothing else
  const first = f.LEVELS[0];
  assert(!first.nodes && !first.springs && !first.beams && !first.spikes,
    'Level 1 must contain nothing but ground to leap between');
  section('levels are compact, routed, and level 1 teaches one thing');

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

  /* ---- the guide tells the truth, from every launch surface ---------------
     TEST D covers the ordinary case through the real input path; this checks
     the two that have extra rules layered on: a wall (which adds an outward
     component) and a node (which launches at its own speeds). Both have to be
     in the preview, or the guide quietly lies exactly where the player is most
     dependent on it. */
  for (const ang of [-0.9, -2.2, -1.5]) {
    arena([{ list: 'solids', x: 1000, y: 1400, w: 1200, h: 80 }]);
    standAt(700, 1340);
    const sp = T.launchSpeed(1, false);
    const guide = T.predict(f.body.x, f.body.y, Math.cos(ang) * sp, Math.sin(ang) * sp, 1400);
    if (guide.land < 0) continue;
    const predicted = { x: guide.lx, y: guide.ly };
    standAt(700, 1340);
    f.burst(ang, 1);
    for (let i = 0; i < 400; i++) { f.tick(1); if (f.PS.state === 'ground') break; }
    const off = Math.hypot(f.body.x - predicted.x, f.body.y - predicted.y);
    assert(off < 26, `The guide must land where the leap lands (${ang} off by ${off.toFixed(0)})`);
  }
  // a wall launch: the outward push has to be in the preview too
  {
    arena([{ list: 'solids', x: 1400, y: 1000, w: 80, h: 900 },
           { list: 'solids', x: 900, y: 1500, w: 1200, h: 80 }]);
    drop(1200, 1000, 14, 0, 1);
    for (let i = 0; i < 90; i++) { f.tick(1); if (f.PS.state === 'cling') break; }
    assert.equal(f.PS.state, 'cling', 'on the wall for the wall-guide check');
    f.Aim.on = true; f.Aim.angle = -Math.PI / 2; f.Aim.power = 1;
    f.Aim.pullLen = MOVE.dragFull; f.Aim.pull = 1;
    T.refreshAimPreview();
    const pv = T.preview;
    assert(pv.n > 2, 'a wall launch is previewed');
    const pred = { x: pv.lx, y: pv.ly, land: pv.land };
    const a = f.Aim.angle, p = f.Aim.power;
    T.cancelAim();
    // cancelAim does not leave the wall, so re-establish the hold
    f.PS.state = 'cling'; f.PS.clingSide = -1; f.PS.clingT = 0;
    f.burst(a, p);
    let hit = null;
    for (let i = 0; i < 400; i++) {
      f.tick(1);
      if (f.PS.state === 'ground' || f.PS.state === 'cling') { hit = { x: f.body.x, y: f.body.y }; break; }
    }
    if (pred.land >= 0 && hit) {
      const off = Math.hypot(hit.x - pred.x, hit.y - pred.y);
      assert(off < 30, `A wall launch must follow its own preview (off by ${off.toFixed(0)})`);
    }
  }
  section('the guide matches the jump from the ground and from a wall');

  console.log('PASS:\n  - ' + pass.join('\n  - '));
}

module.exports = { boot };
