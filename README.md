# LUMA

Işığın yolunu bul.

Run `npm start`, then open http://localhost:8090. No packages or build step are required. Opening `index.html` directly also works. The identity is configured only in `GAME.title` in `game.js`; the existing `flux.progress` storage namespace is preserved.

`npm test` runs the movement regressions, the environment tests, the level validator, the designer-route checks and the full-level solver/replays. `npm run measure` prints the physics tables the levels are built from, and `npm run validate` runs the structural checks on their own.

## The numbers the levels are built from

Nothing in the campaign is a guessed coordinate. Two tools measure the real movement model out of the live simulation, and the level geometry is sized from their output:

`npm run measure` →

| | |
|---|---|
| full-power leap, flat | **917** units |
| full-power leap, straight up | **405** |
| reach remaining at +160 of rise | 733 |
| reach remaining at +280 of rise | 521 |
| energy node (throws slightly harder) | 961 flat, 427 up |
| wall hold | launches exactly as hard as the ground |
| spring at 12° / 20° / 28° | rises 526 / 486 / 438, carries 365 / 573 / 732 |
| landing assist | reaches 46 units past a ledge edge |

...and the one that actually decides the shapes:

> **While aiming, the player can see about 560 units ahead and 990 above.**

The view is 540 × 960 and portrait. So a horizontal leap can be physically possible and still be a blind jump, and the honest limit on a mandatory sideways hop is around 500 units, not 917. That is why this campaign climbs, folds and zig-zags instead of running to the right: height is cheap to frame and distance is not. Long leaps are left for optional shortcuts, where not seeing the far side is the player's own choice.

Because of that ceiling, difficulty is **not** raised by making hops longer. Every mandatory hop across all fifteen levels sits between 24% and 76% of the reach available in its own direction. What rises instead is what a hop asks you to do: time it, ride it, choose a route, read a pattern, chain it to the next one.

## The fifteen levels

Each level introduces at most one idea, and introduces it safely before asking anything of it.

| | name | idea | shape |
|---|---|---|---|
| 1 | İlk Işık | pull back further, go further | rightward climb, floor throughout, nothing can kill you |
| 2 | Tutun | wall cling — a stub first, then the tower | one tower, its crown is the goal |
| 3 | Yankı | energy node — one free to ignore, one that is the level | wide chamber, a 380-unit shelf no leap reaches |
| 4 | Sıçrama | springs — one unmissable, one aimed back over the level | rising zig-zag, compact |
| 5 | Kızıl Yol | danger, and the first choice | a spike pit with a stepping stone over it, or one 480-unit crossing |
| 6 | Nabız | beams | a shaft: the first hop passes *under* a beam, the last sails *over* one |
| 7 | Salınım | moving ground | a slow one over a floor, then a lift 600 units past any leap |
| 8 | Kırılgan | crumbling ground | one safe lesson, then two steps that *are* the climb |
| 9 | Akış | wall + spring, joined up | a tower and a throw, nothing dangerous |
| 10 | Kement | node over moving ground; first checkpoint | held at the node, the world is frozen — pick the moment |
| 11 | Akıntı | currents: feel it, fight it, ride it | a rising current to a shelf 420 up |
| 12 | Döngü | spring and beam alternating; checkpoint | rest → thrown → land → count → cross → rest, twice |
| 13 | Ayrım | one chasm, two honest ways over | patient: crumble + lift. Bold: one 400-unit leap into a node |
| 14 | Tırmanış | the first long climb; two checkpoints | wall → REST → lift → wind+node → REST → spring → REST → out |
| 15 | Son Işık | everything, in order; three checkpoints | the closing chain is wall → node → spring → landing |

Level 15 is the only one allowed to be genuinely hard, and its hardness is the length of the chain rather than the precision of any one link.

Two details worth knowing when reading the data. Springs are mounted **beside** a landing area, never across the whole of one, so there is always somewhere to come down that is not a spring. And a node throws nearly a thousand units — far enough to skip most of a level — so in Level 15 the node halfway up sits under a roof, and that ceiling is what turns the throw back into the move the chamber is asking for.

### Authoring

Levels are written the way a designer thinks about them and converted at the point of definition:

```js
const p2 = ledge(500, 780, 690, 90);   // left edge, right edge, top, thickness
const keep = tower(1170, 1410, 480, 1330);
route: [at(p1, 120), grip(keep, -1, 700), at(keep), [0, 0, 'gate']]
```

`at` places a route waypoint on a surface, `grip` on one face of a tower, `via` on a node, `onto` on a spring. `gateOn` and `checkOn` place the gate and a checkpoint above a surface. Every number below those helpers can be reasoned about directly against the tables above.

## Systems

- Moving solids use `motion: {type:'osc', dx, dy, period, phase}`, relative to the platform's centre; `period` is in seconds. Grounded riders receive displacement once per tick.
- `crumble` on a solid is its warning in seconds. Landing starts it; cracks brighten and a remaining-time line shrinks before it goes. Respawn and restart restore it. Aiming pauses it with the rest of the world.
- `winds` are `{x,y,w,h,dx,dy,strength}`. A current is always weaker than gravity — it bends a leap, it never takes the leap away — and it only acts in flight.
- `beams` blink on a cycle with a charge ramp before they become lethal. No beam in the campaign is dark for less than 2.5 seconds.
- Checkpoints (`motes`) are claimed on touch and become the respawn point. None respawns onto moving ground, crumbling ground, a spring, inside a current, or within 150 units of a hazard — the validator enforces each of those.
- The start screen, level grid, save/migration, procedural audio and completion sequence are unchanged.

## Developer mode

`?dev=1` turns it on and persists it; `?dev=0` removes it. `?dev=1&level=10` jumps straight to a level — developer mode only, so a shared link cannot unlock anything.

| | |
|---|---|
| `G` | debug overlay on/off |
| `H` | declared route on/off |
| `←` `→` | previous / next level |
| `R` | restart |
| `F` | frame timing |

The overlay draws collision boxes as the simulation sees them, the full travel of moving ground, spring trigger regions and throw directions, node catch radii, checkpoint respawn points, current bounds and direction, and the declared route with its waypoint kinds — plus a readout of world size, spirit position and velocity, camera and zoom.

## Validation

`npm test` is the gate. All fifteen levels pass:

- **`validate-levels.cjs`** — the structural checks, measured against a reach envelope rebuilt from the live simulation on every run, so retuning `MOVE` retunes the budget with it. Spawn is safe and grounded; the gate is not buried; checkpoints respawn safely and away from hazards, currents, springs, moving and crumbling ground; moving platforms stay in bounds, never sweep through geometry or a hazard, **and never crush a rider against a ceiling**; crumbling platforms reset on respawn and give at least a second of warning; currents stay weaker than gravity and are not buried in rock; every beam has a dark window; every spring is entered along its face, fires, and is reported with the exact point it lands you; no route waypoint sits in a hazard; and every hop is reported as a percentage of the reach available in its direction, against the budget for that point in the campaign.
- **`playtest.cjs`** — flies every declared hop in the real simulation with the real camera: is it reachable, how many degrees of aim slack does it allow, for a level with beams or moving ground how many of eight points around the world's cycle admit it, and is the destination on screen at the moment the player has to commit. Every hop in the campaign is reachable, forgiving and visible.
- **`solve-levels.cjs`** — searches each level from scratch with no knowledge of the declared route, then replays what it finds and audits which mechanics it used. All fifteen are solved and replayed.
- **`opening.test.cjs`** — replays the intended sequence for levels 1–5 using touch pointer events at a 390-pixel phone width, including both routes through level 5, and asserts the destination is framed before each release.

The solver is an exhaustive optimiser, not a representative player, and it finds shorter lines than the designed routes — mostly by holding platform faces. Where the designed route uses a mechanic and the optimiser skips it, the audit says so and calls it a shortcut rather than a fault; that is the mastery reward, and it is the intended reading of Level 13, which is built around the choice. It reports a genuine fault only when *neither* route touches an object the level is carrying.

Browser checks covered menu visibility, level jumping, the debug overlay and normal rendering with no console errors. These are simulation and desktop-browser checks: they do not replace physical Android/iOS touch testing, a listening pass on phone speakers, or a human opinion about how hard any of it feels. Completion-time targets remain design intent, not measured or enforced claims — an automated replay proves a level can be finished, never that it is enjoyable.
