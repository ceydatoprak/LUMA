// DESIGN TOOL — how far can the player SEE while winding up?
//
//   node tests/measure-camera.cjs
//
// Reach is not the limit on a hop; framing usually is. The view is 540 x 960
// world units, it leads toward the aim, and it refuses to push the spirit
// further than `camHold` of the half-view from centre. This measures the
// resulting "sight budget": how far ahead of the spirit a destination can sit
// and still be on screen at the moment the player has to commit.
const { boot } = require('./harness.cjs');

const f = boot();
const T = f.internals;
const MOVE = f.MOVE;
const VW = 540, VH = 960;

// A world large enough that the camera is never clamped by its edges.
const PAD = { name: 'cam', tip: '', w: 12000, h: 9000, bg: ['#000', '#000'],
  accent: [120, 170, 255], spawn: { x: 6000, y: 4460 }, gate: { x: 11600, y: 200 },
  solids: [{ x: 6000, y: 4540, w: 1400, h: 200 }], route: [] };
const SLOT = f.LEVELS.length;
f.LEVELS[SLOT] = PAD;

function viewWhileAiming(angle, power) {
  f.go(SLOT);
  for (let i = 0; i < 60; i++) f.tick(1);
  f.Aim.on = true; f.Aim.angle = angle; f.Aim.power = power;
  f.Aim.pull = power;
  f.Aim.pullLen = MOVE.dragDead + 1 + (MOVE.dragFull - MOVE.dragDead) * power;
  T.refreshAimPreview();
  T.updateCamera(true);
  for (let i = 0; i < 80; i++) { T.refreshAimPreview(); T.updateCamera(false); }
  const z = f.cam.zoom;
  const bx = f.body.x, by = f.body.y;
  const r = {
    left:  bx - (f.cam.x - VW / (2 * z)),
    right: (f.cam.x + VW / (2 * z)) - bx,
    up:    by - (f.cam.y - VH / (2 * z)),
    down:  (f.cam.y + VH / (2 * z)) - by,
    zoom: z,
  };
  f.Aim.on = false; f.Aim.power = 0; f.Aim.pullLen = 0;
  return r;
}

console.log('=== LUMA sight budget while aiming (distance from the spirit) ===');
console.log('view is ' + VW + ' x ' + VH + ' world units at zoom 1\n');
console.log('  aim direction        pull   zoom    ahead   behind   above   below');
const DIRS = [
  ['right (flat)', 0], ['up-right 30', -30], ['up-right 45', -45],
  ['up-right 60', -60], ['straight up', -90], ['down-right 30', 30],
];
const sight = {};
for (const d of DIRS) {
  for (const pull of [0.4, 0.7, 1]) {
    const power = T.powerCurve(pull);
    const ang = d[1] * Math.PI / 180;
    const r = viewWhileAiming(ang, power);
    // "ahead" measured along the aim direction, which is what a hop uses
    const ahead = Math.cos(ang) >= 0 ? r.right : r.left;
    const vert = Math.sin(ang) < 0 ? r.up : r.down;
    if (pull === 1) sight[d[0]] = { ahead: ahead, vert: vert };
    console.log('  ' + d[0].padEnd(18) + ' ' + pull.toFixed(2) + '   ' +
      r.zoom.toFixed(2) + '   ' + ahead.toFixed(0).padStart(6) + '   ' +
      r.left.toFixed(0).padStart(6) + '   ' + r.up.toFixed(0).padStart(5) +
      '   ' + r.down.toFixed(0).padStart(5));
  }
}

console.log('\n=== WHAT THIS MEANS FOR GEOMETRY ====================');
console.log('  A destination further ahead than the "ahead" figure is a BLIND jump:');
console.log('  the player is asked to commit to somewhere they cannot see.\n');
console.log('  horizontal sight limit (flat, full pull)   ~' + sight['right (flat)'].ahead.toFixed(0));
console.log('  vertical   sight limit (up, full pull)     ~' + sight['straight up'].vert.toFixed(0));
console.log('\n  So: mandatory HORIZONTAL displacement should stay near or under');
console.log('  ~' + (sight['right (flat)'].ahead - 40).toFixed(0) + ' units, even though the body can physically fly 917.');
console.log('  VERTICAL travel is far cheaper to frame — the view is 960 tall and');
console.log('  portrait, so climbs and descents read much better than long runs.');
