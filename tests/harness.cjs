// Runs the real game in a minimal DOM/canvas shell; no browser dependencies.
// Everything the tests drive goes through the same code paths the player does.
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function boot() {
  const events = {}, nodes = new Map();
  let rect = { left: 0, top: 0, width: 540, height: 960 };
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const context = new Proxy({}, { get: (o, k) => o[k] ?? (k.startsWith('create') ? () => gradient : noop) });
  const node = () => ({
    width: 540, height: 960, style: {},
    classList: { add: noop, remove: noop, toggle: noop },
    getContext: () => context, getBoundingClientRect: () => rect,
    setAttribute: noop, contains: () => false,
    addEventListener: (key, fn) => { events[key] = fn; },
  });
  const document = {
    hidden: false,
    getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    querySelector: () => node(),
    createElement: node,
    addEventListener: (k, f) => { events[k] = f; },
  };
  const window = { devicePixelRatio: 3, addEventListener: (k, f) => { events[k] = f; } };
  const sandbox = {
    window, document, location: { search: '' },
    localStorage: { getItem: () => null, setItem: noop },
    performance, setTimeout: noop,
    requestAnimationFrame: () => 1, cancelAnimationFrame: noop, console,
  };
  vm.createContext(sandbox);
  const source = readFileSync(require.resolve('../game.js'), 'utf8').replace(
    'window.FLUX = {',
    'window.TEST = { frame, fit, predict, cancelAim, circleVsBox, killSpirit, respawn, ' +
    'restartLevel, placeSpirit, updateCamera, stepBody, integrate, nodeInReach, grabNode, ' +
    'canAim, buffered, RES, beamLevel, doBurst, powerCurve, burstSpeed, launchSpeed, buildWorld, refreshAimPreview, preview, updateDrag, beginAim, toScreen, cameraMode, aimVelocity }; window.FLUX = {');
  vm.runInContext(source, sandbox);
  return {
    ...window.FLUX,
    internals: window.TEST,
    events, document, canvas: nodes.get('game'),
    resize: (width, height) => { rect = { ...rect, width, height }; window.TEST.fit(); },
    // drive the simulation until the player can act again, or we give up
    settle(limit = 600) {
      for (let i = 0; i < limit; i++) {
        this.tick(1);
        if (this.G.phase !== 'play') return i;
        if (this.aimable()) return i;
      }
      return -1;
    },
  };
}

module.exports = { boot };
