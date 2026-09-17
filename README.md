# LUMA

Işığın yolunu bul.

Run `npm start`, then open http://localhost:8090. No packages or build step are required. Opening `index.html` directly also works. The identity is configured only in `GAME.title` in `game.js`; the existing `flux.progress` storage namespace is preserved.

Run `npm test` for the movement regressions, environment tests, designer-route checks and full-level solver/replays. The solver writes reproducible inputs and completion results to `tests/completion-routes.json`.

## Design and systems

The 15 explicit level layouts are in `LEVELS`. Each has a short Turkish hint and an intended route used to check reachability, camera visibility and input tolerance. This revision rebuilds only levels 1–5 as the opening chapter; levels 6–15 and the movement/camera systems are unchanged.

1. **İlk Işık** — start, wide middle ledge, higher ledge, short goal crossing. A catch floor keeps ordinary misses recoverable. Sequential replays use 40–50% power for the first leap, 55–65% for the second, and at most 30% for the final leap.
2. **Tutun** — one tower, its side, its own crown, then a separate goal ledge. The tower requires a wall hold, with a broad top to rest on.
3. **Yankı** — safe intermediate ledge, one node, upper-right goal. The node is a comfortable second decision in mid-air.
4. **Yükseliş** — safe intermediate ledge, one spring angled upward-right, upper resting ledge, normal jump to the goal. The 12-degree spring face gives clearance from the final ledge above; the arrival restores control before the last jump.
5. **Kızıl Yol** — visible red danger below the crossing. The lower intermediate ledge provides the safe route; `fastRoute` documents a direct optional crossing using one fewer pull. Neither path needs maximum power.

Completion-time ranges in the design brief remain human-playtest targets, not enforced timers or measured claims. No deliberate waiting or movement changes were added to make a stopwatch match them.

- Moving solids use the existing `motion` configuration: `{type:'osc', dx, dy, period, phase}` gives a smooth repeating path relative to the platform's centre. `period` is in seconds. Grounded riders receive displacement once per tick. The trajectory forecasts moving surfaces and beam phases without changing the live world.
- Set `crumble` on a solid to its warning duration in seconds. Landing starts the warning; cracks brighten and a remaining-time line shrinks before the platform disappears. Respawn and restart restore it. Aiming pauses the warning along with the rest of the world.
- `winds` define `{x,y,w,h,dx,dy,strength}`. Direction is normalized; acceleration is applied only in flight and shared with the preview. Animated arrows show the current's area and direction.
- The start screen and level grid use the existing save. Buttons are disabled for locked levels and the selection handler independently checks unlocks. Going back from the grid resumes the current checkpoint/state. Starting a selected level always starts safely from its beginning. Replay preserves unlocks.
- Procedural audio adds a quiet tonal bed, nearby filtered wind, crystal cracks and subtle landing/grip variation to the existing magical event motifs. It starts after a user gesture, respects mute and suspends when the document is hidden.
- Completion pulls the spirit into the portal, then releases a short particle bloom. The finale has a larger portal and richer burst/chord. The session-only timer is deliberately hidden on the ending screen because it does not represent total saved play time.

## Validation

All 15 levels have been completed by the real-simulation solver and replayed from clean starts. All intended route hops pass reachability, visibility and generous-input checks. Existing core movement tests remain, including camera-independent aiming, stationary aim stability, pointer cancellation/resize, wall-to-top assistance and spring rearming.

New tests cover moving landings and 20-second rides through horizontal/vertical cycles; preview/live landing parity and snapshot restoration; crumble warning, aim pause and respawn/restart; wind direction and grounded immunity; normal-menu lock enforcement; save reload and migration from a completed six-level save; and off-centre spring launches in every spring level. Timed-beam spring approaches are checked in their safe window.

`tests/opening.test.cjs` additionally searches the **intended** opening sequences from each actual preceding landing, then replays them using touch pointer events at a 390-pixel phone width. This includes pointer-driven node capture, stationary aiming, visible destinations, visibility of the spring's landing before entering it, and both level 5 routes. Reproducible inputs are saved to `tests/opening-routes.json`. `node tests/playtest.cjs 5 fast` checks shortcut visibility and aiming margin independently. These are simulation checks, not a claim of physical phone testing.

Browser checks at 390×844 and 844×390 covered menu visibility, all 15 lock states, starting a level, backward dragging, orientation resize, audio initialization and rendered wind. No browser console errors were observed. These checks do not replace physical Android/iOS touch testing or a listening pass on phone speakers. Full-level automated replays prove completion, not a subjective difficulty rating.

For developer inspection only, `?dev=1` enables arrow-key chapter navigation and frame timing; `?dev=0` turns it off. Normal players cannot use this navigation unless developer mode was explicitly enabled. `window.FLUX` remains the existing internal test/debug API regardless of the displayed title.
