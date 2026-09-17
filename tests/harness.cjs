// Runs the real game in a minimal DOM/canvas shell; no browser dependencies.
// Everything the tests drive goes through the same code paths the player does.
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

// A store that behaves like localStorage, including surviving a "reload":
// pass the previous `dump()` back in and the new boot sees the same data.
function makeStorage(seed, broken) {
  const map = new Map(Object.entries(seed || {}));
  const fail = () => { throw new Error('storage unavailable'); };
  return {
    getItem: broken ? fail : (k) => (map.has(k) ? map.get(k) : null),
    setItem: broken ? fail : (k, v) => { map.set(k, String(v)); },
    removeItem: broken ? fail : (k) => { map.delete(k); },
    dump: () => Object.fromEntries(map),
  };
}

function boot(opts) {
  const o = opts || {};
  const events = {}, nodes = new Map();
  let rect = { left: 0, top: 0, width: 540, height: 960 };
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const context = new Proxy({}, { get: (c, k) => c[k] ?? (k.startsWith('create') ? () => gradient : noop) });
  // Enough of an element to answer the questions the UI tests ask: what text
  // is on it, which attributes it carries, and which classes it has.
  const node = (id) => {
    const el = {
      id: id || '', width: 540, height: 960, style: {}, textContent: '',
      attrs: {}, classes: new Set(),
      classList: {
        add: (...c) => c.forEach((k) => el.classes.add(k)),
        remove: (...c) => c.forEach((k) => el.classes.delete(k)),
        toggle: (k, on) => { if (on === undefined ? el.classes.has(k) : !on) el.classes.delete(k); else el.classes.add(k); },
        contains: (k) => el.classes.has(k),
      },
      getContext: () => context, getBoundingClientRect: () => rect,
      setAttribute: (k, v) => { el.attrs[k] = String(v); },
      getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
      contains: () => false,
      appendChild: (child) => { nodes.set(child.id, child); },
      addEventListener: (key, fn) => { events[key] = fn; },
    };
    return el;
  };
  const html = node('html');
  const document = {
    hidden: false, title: '', documentElement: html,
    getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); },
    querySelector: (sel) => { if (!nodes.has(sel)) nodes.set(sel, node(sel)); return nodes.get(sel); },
    createElement: () => node(),
    addEventListener: (k, f) => { events[k] = f; },
  };
  const window = { devicePixelRatio: 3, addEventListener: (k, f) => { events[k] = f; } };
  const storage = makeStorage(o.storage, o.brokenStorage);
  const sandbox = {
    window, document, location: { search: o.search || '' },
    localStorage: storage,
    performance, setTimeout: noop,
    requestAnimationFrame: () => 1, cancelAnimationFrame: noop, console,
  };
  vm.createContext(sandbox);
  const source = readFileSync(require.resolve('../game.js'), 'utf8').replace(
    'window.FLUX = {',
    'window.TEST = { frame, fit, predict, cancelAim, circleVsBox, nearBox, killSpirit, respawn, ' +
    'restartLevel, restartRun, placeSpirit, updateCamera, stepBody, integrate, nodeInReach, grabNode, ' +
    'canAim, buffered, RES, beamLevel, doBurst, powerCurve, burstSpeed, launchSpeed, buildWorld, refreshAimPreview, preview, updateDrag, beginAim, toScreen, cameraMode, aimVelocity, ' +
    'springLoop, releaseSprings, fireSpring, applyBranding, updateHud, dom, reachGate }; window.FLUX = {');
  vm.runInContext(source, sandbox);
  return {
    ...window.FLUX,
    internals: window.TEST,
    events, document, storage, html,
    canvas: nodes.get('game'),
    el: (id) => nodes.get(id),
    text: (id) => (nodes.has(id) ? nodes.get(id).textContent : undefined),
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

module.exports = { boot, makeStorage };
