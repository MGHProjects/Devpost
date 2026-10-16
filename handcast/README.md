# HANDCAST

**Your own hand is the only optic.** HANDCAST is a seated, hands-first
mixed-reality puzzle game for Meta Quest, built with the
[Immersive Web SDK](https://iwsdk.dev) (WebXR) and played in the Quest Browser.

A small glass bench sits on your real table, seen through passthrough. Lamps
and pools of coloured light sit on it, with crystals that each want one exact
colour and hush stones that must stay dark. Shape your hand in the light and
hold still: molten glass flows over it from wrist to fingertips and freezes
into a glass copy of that exact 25-joint pose. Slide your hand out and the
glass stays. Light that enters one open end of a glass hand leaves through
every other open fingertip, so the shape you made is the puzzle piece. There
is no controller anywhere in the game.

- **Play:** https://mghprojects.github.io/Devpost/ (Meta Quest Browser, tap
  the **Enter XR** button at the bottom of the page, hand tracking on). If the
  table is not found within 15 s, the bench appears in front of you.
- **Competition:** Meta VR Start Developer Competition 2026, Gaming track,
  New Experience division. Submission text: [`SUBMISSION.md`](SUBMISSION.md).
- **Content:** 49 campaign boards in 7 chapters, a Daily board, the Kiln
  (endless generated boards), the Studio (make boards with your hands) and the
  Hall of Hands (share and solve other players' boards).

## How to play

### The first five minutes

1. Sit at a table, put the controllers down, open the link and tap **Enter
   XR**. You see your room, dimmed except for a pool of light around the bench.
2. **Find the table.** The panel says "Rest one hand flat on your table and
   hold still." Lay a hand palm down with the fingers straight for about a
   second. The bench appears under your hand, turned to face you. On Quest it
   is saved as a persistent spatial anchor, so next time it comes back where
   you left it (if the anchor cannot be restored, the bench is placed in
   front of you). **Menu → Table** runs this step again.
3. **Cast.** The first board, *First Light*, says "Rest your open hand in the
   pool." Put your open hand in the pool of light. Beams leave your fingertips
   and crystals ring as they light up. Hold still: the hand glows as molten
   glass flows from wrist to fingertips (about 0.7 s), then it sets.
4. **Withdraw.** "Slide your hand out. The glass stays." The glass hand keeps
   working without you. A board is solved when the glass hands alone light
   every crystal in its exact colour and wake no hush stone. The board plays
   its chord, the maker's glass hands fade in beside yours as ghosts, and
   **Next** appears.
5. **Fix and retry.** The glass tokens on the panel show how many glass hands
   the board allows. Pinch a glass hand's foot to slide or turn it, knock it
   over with a fist to get the glass back, or tap **Undo** to shatter the last
   one. **Hint** shows a ghost hand to copy for six seconds, and every board
   has a one-line hint in the status line.

### Gestures

| You do | What happens |
| --- | --- |
| Hold a hand over the bench (palm less than 11 cm above it) | Your live hand is an optic: the beams re-trace every frame as you change shape. |
| Hold still while your hand is lit | A casting meter fills in 0.7 s (1.2 s in Steady mode) and the pose freezes into glass. Moving drains the meter twice as fast as it fills. |
| Move the casting hand away | It must move 7 cm (or leave the bench) before it can cast again, so a hand never re-casts on top of its own glass. |
| Pinch the frosted foot under a glass hand | You hold it. Move to slide it; turn your wrist to twist it in 3 degree steps. Releasing it off the bench shatters it. |
| Knock a glass hand with your fist | It shatters and its glass token comes back. |
| Run your index fingertip across an open glass finger | The finger plays a plucked glass note, like a kalimba tine (casts of the left hand sound an octave lower). |
| Look at a crystal for half a second | It rings its note, gets a highlight ring, and the status line names the colour it wants, e.g. "yellow (red + green)". |
| Point and pinch at the panel, or poke it | Presses a button. Presses are ignored while a hand is holding glass or casting. |

### The panel and the menu

The panel floats above the far edge of the bench. In play it shows the
chapter and board, a status line, the glass tokens, one dot per crystal (lit
in the crystal's colour when glass lights it) and the buttons **Undo**,
**Reset**, **Hint** and **Menu**. **Next** appears after a solve, and **Like**
after solving a Hall board.

**Menu** shows all 49 boards by chapter (solved ones in gold) plus **Daily**
(with your streak, "Daily x3"), **Kiln**, **Studio**, **Hall**, **Sound**
(mute), **Steady**, **Table** (find the table again) and **Back**. Progress,
the current board, the streak and the settings are kept in the browser's local
storage, so the game reopens where you left it.

## The light rules

- **Lamps** shoot a beam. **Pools of light** feed any open fingertip dipped in
  them, and an open hand whose palm rests in a pool takes the light in at the
  wrist.
- **Fan (open hand, palm up or down).** Light entering any open end (the
  wrist, or an open fingertip) leaves through every other open fingertip,
  carrying the sum of all the colours that came in. A finger is open when it is
  straight (tip-to-knuckle distance over 0.88 of its length) and points along
  the bench. Curled fingers stay dark.
- **Blade (flat hand on its edge, four fingers straight and together).** A
  two-sided mirror from the wrist to the middle fingertip.
- **Stone (fist).** Absorbs light. The body of every hand blocks light too.
- **Walls** block light; **mirrors** on the board reflect it.
- **Crystals** add up what reaches them: red + green = yellow, green + blue =
  cyan, red + blue = magenta, all three = white. A crystal counts only with its
  exact colour; extra colour makes it wrong. Glyphs at its foot (triangle red,
  circle green, square blue) show the parts it needs and brighten as each part
  arrives.
- **Hush stones** must stay dark. Any light wakes them with a sour cluster of
  notes, and the board is not solved while one is awake.
- **Solve check.** Only glass counts: the glass hands, within the board's glass
  budget, must light every crystal exactly and wake no hush stone.
- **Aim assist.** A beam leaving a fingertip bends by up to 6 degrees to hit a
  crystal or another hand's open end within 60 cm. It never bends toward a
  hush stone, and a beam that already reaches a crystal or an open end is left
  alone.

## Content

### Campaign: 49 boards in 7 chapters

| Chapter | Boards | Key | What it is about |
| --- | ---: | --- | --- |
| Prologue: First Light | 5 | C major | An open hand in a pool; choosing which fingers shine. |
| I. Fingers | 8 | G major | Finger counts and shapes; light entering through a fingertip. |
| II. Catch | 8 | D major | Catching lamp beams with a fingertip or the wrist; mixing two lamps in one hand. |
| III. Mirror Palm | 8 | A minor | The blade mirror, then boards that need two glass hands. |
| IV. Relay | 8 | F major | Glass hands passing light to each other (up to three hands), walls. |
| V. Colour | 8 | E minor | Mixing pools and lamps into yellow, cyan, magenta and white; decoy pools. |
| Finale: Count to Ten | 4 | C major | A left and a right glass hand together, up to eight crystals. |

The boards are generated offline by a solution-first generator
(`src/core/board-gen.ts`) from the specs in `src/content/campaign-specs.ts`
and stored in `src/content/levels/*.json`. `tests/content.test.ts` checks
that every board passes `validateBoard`: its reference solution solves it, the
empty bench is not solved, the solution survives small hand wobbles (each
crystal stays lit and each hush stone dark in at least 80% of wobbled
re-casts), a lazy open hand does not also solve it (the first board is the one
exception), and every cast is a pose a real hand can rest on a table. It also
checks that difficulty rises within each chapter and that the generator
reproduces sample boards exactly from their spec and seed. To regenerate:

```bash
npx vite-node --config vitest.config.ts scripts/gen-campaign.ts            # every chapter
npx vite-node --config vitest.config.ts scripts/gen-campaign.ts daily      # the Daily pack
```

### Daily: "One Hand"

One glass hand allowed, the same board for everyone on a given calendar date
(the player's local date). Mondays to Thursdays use one light source; Fridays
to Sundays add colour mixing or a blade. Boards from 2026-10-15 to 2027-01-31
are precomputed with full validation (`src/content/levels/daily.json`); other
dates are generated at runtime with lighter validation. Solving on consecutive
days builds a streak. After the last campaign board, **Next** opens the Daily.

### The Kiln

Endless boards from a random seed (`src/content/kiln.ts`), with generated
names such as "Amber Lantern". Tier 1 is one hand and one light source; tier 2
(after 16 solved campaign boards) adds colour mixing or a blade; tier 3 (after
32) needs two glass hands relaying light.

## Studio

**Menu → Studio** opens a 44 x 30 cm bench with one pool of white light.
Authoring is cast-first:

1. **Cast your solution.** Rest your palm in the pool and hold still. Studio
   casts are retargeted to standard hand proportions at once, so the board is
   built around the same hand that will be published.
2. **Tap Crystals.** A crystal of the right colour drops on every beam your
   glass hands send, hush stones go where a lazier hand would spill light, and
   targets your hands no longer reach are cleared.
3. **Shape it with fingertip pinches on the bench.** Pick a tool:
   - **Lamp:** pinch to place, pull to aim; pull from an existing lamp to
     re-aim it.
   - **Pool:** pinch to place, pull to size it.
   - **Hush:** pinch to place a stone that light must never touch.
   - **Wall:** pinch and pull to draw one.
   - **Erase:** pinch anything, or a glass hand by its foot, to remove it.
   - With no tool selected, pinch an element to move it.
4. **Tap to change.** A quick pinch (under 0.4 s, under 12 mm of movement) on
   a lamp, pool or crystal cycles its colour; on a wall it turns the wall into
   a mirror and back.
5. **Undo** steps back through whole-board snapshots, glass hands included.
6. **Publish** runs a seal check: your glass hands solve the board within its
   budget, the empty board is not solved, there is at least one crystal and
   everything is on the bench. If an open or flat hand at your spot would also
   solve it, the Studio warns once; tap **Publish** again to publish anyway.
   **Done** returns to the campaign.

Positions snap to 5 mm and lamp headings to 5 degrees. A Studio board can use
up to 6 glass hands.

## Hall of Hands

**Menu → Hall** has three tabs, **Featured**, **New** and **Top**, each
listing up to six boards with author, solves and likes.

- **Offline (default build).** Featured shows the eight built-in boards
  (`public/community/featured.json`, rebuilt from code if the file cannot be
  loaded). New and Top show the boards made on this device. Publishing keeps
  the board locally and writes a share link (`#l=<code>`) into the address
  bar; opening that link on any device loads the board. The code is a
  compressed binary of the board and its solution, small enough for a URL.
- **Online (with the Worker).** New and Top come from the server. After you
  solve a Hall board, the status line gives your solver rank, the share of
  players who shaped their hand like you and the number of distinct hands so
  far, and up to eight other players' glass hands fade in as ghosts (offline,
  the maker's hands appear instead). **Like** counts once per device.

Every network call times out after 4 s and falls back to the offline path, so
the game never waits on the network.

### Privacy and moderation

- **Hand size never leaves the device.** Before publishing or reporting a
  solve, every glass hand is retargeted onto a canonical hand
  (`src/core/privacy.ts`): only the joint rotations and the wrist position are
  kept; bone lengths, palm proportions and joint radii are replaced.
- **No free text.** Board titles and player handles are generated
  (`src/core/moderation.ts`).
- **Gesture filter.** A cast whose only open long finger is the middle finger
  is rejected, in any orientation, by both the client and the Worker.
- **Server checks.** The Worker re-decodes and re-anonymises every upload,
  enforces size limits, re-traces each solution within its budget, stores
  device ids and IPs only as salted SHA-256 hashes, rate-limits writes, and
  hides a board after three reports from different devices (the API supports
  reports; the game has no report button yet).

## Sound and music

Each chapter has a key and a chord progression, and each board is one chord.
Crystals take the chord's tones from left to right, climbing an octave every
three crystals. A crystal rings when it lights up and holds a soft pad
while glass keeps it lit; solving plays the chord over its bass note. The glass
has its own voices: a sizzle while a cast forms, a crackle and a ting when it
sets, a glass-harmonica hum while a glass hand carries light, shattering, a
sour cluster when a hush stone wakes, and plucked tines. Everything is
synthesised with Web Audio (no audio files), and sounds on the bench are placed
in 3D with HRTF panning.

## Accessibility

- **Seated, within reach.** The bench sits on your table and there is no
  locomotion.
- **One hand at a time.** Every gesture (casting, pinching, twisting,
  knocking, plucking, pressing buttons) uses one hand, and nothing needs both
  hands at once. Either hand can cast on any board. The reference solutions
  use both left and right hands, and we have not checked every board with one
  hand only.
- **Steady mode** (Menu → Steady) slows the casting meter from 0.7 s to 1.2 s
  and doubles the stillness tolerances (palm 14 mm, fingertips 20 mm,
  8 degrees, 3 stray samples), for hands with a tremor.
- **Gaze help.** Look at a crystal to hear its note and read the colour it
  needs.
- **Colour without hue.** The status line names colours in words, and crystal
  glyphs (triangle, circle, square) show each colour's parts.
- **Hints** on every board, and a ghost hand on demand.
- **Sound** can be muted from the menu.

## Architecture

```
src/
  index.ts             World.create() and registration of HandcastSystem
  assets.ts            asset manifest (only the HUD panel; everything else is procedural)
  components.ts        component manifest (empty)
  hc/
    game-system.ts     the ECS system: tracking, casting, grab / twist / knock / pluck,
                       calibration, Studio and Hall wiring, gaze, debug API (window.handcast)
    studio.ts          Studio session: tools, pinch drags, taps, undo history, seal messages
    hud.ts             thin wrapper over public/ui/hud.uikitml
    level-source.ts    campaign, Daily, Kiln and the music for each board
    progress.ts        local progress and settings
    pose-ops.ts        moving / turning a glass hand about its foot
  core/                pure TypeScript, no three.js (shared with the Worker and tests)
    types.ts joints.ts vec2.ts math3.ts
    hand-features.ts   hand pose -> optic (open fingers, fan / blade / stone, ports, body)
    trace2d.ts         the light tracer (fixpoint over hands relaying light, aim assist)
    fk-hand.ts hand-bind.ts pose-library.ts   forward-kinematics hands and named poses
    validate.ts board-gen.ts                  board validation and the solution-first generator
    editor.ts          Studio model: placement, Crystals drop, hush suggestions, seal check
    codec.ts           share codes (#l=...)
    privacy.ts         retargeting casts to canonical proportions
    moderation.ts      gesture filter, limits, solution re-trace, generated names
    music.ts           keys, progressions, crystal notes
    iwer-pose.ts       drives IWER emulated hands from FK poses (tests, capture)
  content/             campaign.ts, campaign-specs.ts, levels/*.json, daily.ts, kiln.ts, names.ts
  community/           client.ts (HallClient, offline-first), featured.ts (built-in shelf)
  input/               hand-tracker.ts (25 joints, filters, pinch, palm, speeds), one-euro.ts,
                       stillness.ts, gestures.ts (twist, knock, pluck), anchor.ts (spatial anchor)
  render/bench/        bench-view.ts, props.ts, beams2d.ts, ambience.ts (passthrough dimming)
  render/glass/        hand-model.ts, bake.ts, cast-view.ts, glass-material.ts,
                       coat-material.ts (molten coat on the live hand), shatter.ts
  audio/               engine.ts (bells, pads, ticks, chords), voices.ts (glass voices)
public/
  ui/hud.uikitml       the panel
  scenes/main.iwsdk.scene.json
  models/{left,right}.glb   WebXR generic-hand models (MIT, webxr-input-profiles)
  community/featured.json   the built-in Hall shelf
community/worker/      Cloudflare Worker + D1 backend for the Hall (see its README)
scripts/
  gen-campaign.ts      offline campaign / Daily generation
  gen-hand-bind.mjs    extracts the hand models' bind pose into src/core/hand-bind.ts
  e2e/                 XR end-to-end scenarios (+ run-local.mjs: run them in a private headless browser)
  video/               demo-video capture (record.mjs) and assembly (assemble.py)
  brand/               logo, thumbnail and video cards (make_logo.py -> media/brand/)
media/                 demo video and brand marks
tests/                 vitest suites (15 files)
```

`iwsdk.config.json` is the project authority: immersive AR (passthrough) with
hand tracking, gaze tracking and anchors enabled, no locomotion, and the IWER
Meta Quest 3 emulator for development.

## Run it locally

Node 20.19+, 22.12+ or 24 (`.nvmrc` pins 22.12.0).

```bash
cd handcast
npm install
npm run dev          # iwsdk dev restart --open --foreground: Vite on port 8081 plus a
                     # managed browser with the IWER Meta Quest 3 emulator
npm run typecheck    # tsc --noEmit
npx vitest run       # 318 tests in 15 files (there is no "npm test" script)
npm run build        # static site in dist/
npm run preview      # serve the build
```

To try it on a Quest on the same Wi-Fi, run `npx @iwsdk/cli dev status`, open
the network URL it prints in the Quest Browser and accept the local certificate
warning. In a desktop browser without XR the page shows an attract loop in
which the solutions of the first boards pour in as glass; playing needs hand
tracking (a headset, or the emulator in the managed browser).

To use a local Hall backend, start the Worker (`wrangler dev`, see
[`community/worker/README.md`](community/worker/README.md)) and run
`VITE_HANDCAST_API=http://localhost:8787 npm run dev`.

### End-to-end tests (emulated XR)

The scripts drive IWER's emulated hands through the real tracking path and
print one PASS or FAIL line per check.

```bash
npx @iwsdk/cli dev up --headless --allow-browser-automation
npx @iwsdk/cli xr enter --input-json '{}'
npx @iwsdk/cli browser run scripts/e2e/hc-xr.mjs       # 10 checks: cast, solve, withdraw, slide, knock, hush stone, blade
npx @iwsdk/cli browser run scripts/e2e/hc-studio.mjs   # 11 checks: Studio, publish, Hall, solve rank
```

Without the managed browser (or past its 110 s script limit), run scenarios in
a private headless Chromium against the dev server:

```bash
node scripts/e2e/run-local.mjs scripts/e2e/hc-xr.mjs scripts/e2e/hc-studio.mjs
node scripts/e2e/run-local.mjs scripts/e2e/hc-campaign.mjs   # casts all 49 boards' reference hands (~10 min)
```

### Demo video and brand marks

```bash
node scripts/video/record.mjs artifacts/video            # frame-accurate capture in the emulator (~30 min)
python3 scripts/video/assemble.py artifacts/video https://mghprojects.github.io/Devpost/
python3 scripts/brand/make_logo.py                       # emblem, logo, thumbnail, video cards
```

In the page, `window.handcast` exposes the debug API the scripts use
(`state()`, `load(i)`, `cast(...)`, `iwerHand(...)`, `iwerSolution(i)`,
`studioPinch(a, b)` and more; see `exposeDebug()` in `src/hc/game-system.ts`).

## Deploy

- **GitHub Pages.** `.github/workflows/handcast-pages.yml` runs on pushes to
  `main` or `claude/clever-bell-ohs0lz` that touch `handcast/`, and on manual
  dispatch. It installs, type-checks, runs the unit tests, builds and deploys
  `handcast/dist` to https://mghprojects.github.io/Devpost/. The Vite `base` is
  `./`, so the build works under the `/Devpost/` sub-path. One-time setup:
  **Settings → Pages → Source: GitHub Actions**, and the `github-pages`
  environment must allow the branch you deploy from.
- **Hall backend (optional).** Deploy the Worker as described in
  [`community/worker/README.md`](community/worker/README.md), then add a
  repository variable `VITE_HANDCAST_API` (Settings → Secrets and variables →
  Actions → Variables) set to the Worker URL with no trailing slash, and re-run
  the workflow. Without it the Hall works offline.

## License

MIT (see [`LICENSE`](LICENSE)). The project scaffolding from `@iwsdk/create`
is MIT-licensed by Meta Platforms, Inc.; the generic-hand models come from
the MIT-licensed WebXR Input Profiles.
