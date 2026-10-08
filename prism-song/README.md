# Prism Song

**Light puzzles that sing.** A seated, hands-first mixed-reality puzzle game for
Meta Quest, built with the [Immersive Web SDK](https://iwsdk.dev) (WebXR).

A small glass table appears in front of you, in your own room. Beams of
coloured light cross it. You pinch mirrors, prisms, half-mirrors and colour
filters out of a tray, set them down and twist them with your wrist, steering
the light into crystals. Every crystal is a note. Light them all and the board
plays its chord; finish a movement and the eight chords you've solved play back
as a song.

- **Track:** Gaming. **Division:** New Experience (all code written from 24 Sep 2026).
- **Runs in the Quest browser.** No install, no controllers.
- 24 puzzles in three movements (Dawn, Noon, Dusk), plus a **Daily Chord**
  puzzle that's the same for everyone each day and keeps a streak.

## How it plays

| You do | What happens |
| --- | --- |
| **Pinch** a piece | You pick it up. Beams re-trace live while it's in your fingers, so you can hear and see where the light goes before you let go. |
| **Twist your wrist** while pinching | Mirrors and half-mirrors turn in 22.5° steps, with a tactile tick on each step. |
| **Release** over a cell | The piece snaps into place. Release away from the board and it goes back to the tray. |
| **Poke** with a fingertip | Taps a piece: turns a mirror one step, selects a tray piece, then a cell to place it. One finger is enough to play the whole game. |
| **Look** at a crystal | It sings its note and the panel tells you which colour it wants (eye tracking where available, head direction otherwise). |
| **Pinch the handle** on the far edge | Carries the whole table. It stays anchored in your room between sessions. |

Pointing with a hand ray and pinching, a controller, or a mouse on desktop all work too.

### The light rules

- **Mirrors** reflect. **Half-mirrors** reflect *and* let light through.
- **Prisms** unweave light: red bends left, green goes straight, blue bends right.
- **Filters** keep only their own colour.
- **Crystals** add up whatever reaches them. Red and green make yellow, and so
  on. A crystal is only satisfied by its exact colour. Too much light flickers.
- Each crystal shows its colour as small glyphs on its base (▲ red, ● green,
  ■ blue), so colour-blind players can read it without relying on hue.

## Design notes (Meta VR Start criteria)

- **Seated and hands-first.** Everything sits on a 40 cm table within arm's
  reach (the "airplane seat test"). There's no locomotion and no controller
  requirement, and the whole game can be played with one hand or one finger.
- **Quick to start and stop.** Each puzzle takes 30 s to 3 min. Progress saves
  automatically, and the last puzzle reopens where you left it.
- **First five minutes.** The six Dawn lessons each teach one idea (turn,
  place, walls, prism, mixing, splitting/filters). A ghost hint appears on its
  own if you're stuck for a few seconds, and a Hint button is always there.
- **A reason to come back.** The Daily Chord, the streak, and the songs you
  build movement by movement.
- **Platform features:** WebXR hand tracking (joints for pinch and twist), poke
  (`PokeInteractable`), ray, gaze plus pinch, passthrough (`immersive-ar`),
  persistent spatial anchors for the table, and HRTF spatial audio.
- **Not a wrapper.** No external services. Every sound is synthesised live
  with Web Audio, every model is generated in code, and the levels come from a
  seeded generator plus hand-written lessons.

## Run it

```bash
cd prism-song
npm install
npm run dev          # managed dev server + IWER Quest 3 emulator, https://localhost:8081
npm run typecheck
npx vitest run       # beam tracer, every campaign level, a year of daily puzzles
npm run build        # static site in dist/
```

On a Quest on the same Wi-Fi, open the network URL that `npx @iwsdk/cli dev status`
prints and accept the local certificate. Or open the hosted build (see the
GitHub Pages workflow in `.github/workflows/prism-song-pages.yml`).

### End-to-end tests (emulated XR)

With the dev server running (`npx @iwsdk/cli dev up --headless --allow-browser-automation`):

```bash
npx @iwsdk/cli browser run scripts/e2e/desktop.mjs     # real mouse clicks
npx @iwsdk/cli xr enter --input-json '{}'
npx @iwsdk/cli browser run scripts/e2e/xr-hands.mjs    # pinch, twist, poke, handle
```

### Demo video

`scripts/video/record.mjs` drives the IWER emulator's hands and headset frame by
frame on a virtual clock. It captures every frame, and the game logs every sound
event, which is then rendered offline with the same synth code, so the
soundtrack is frame-accurate. `scripts/video/assemble.py` adds the captions and
the title and end cards.

## Code map

```
src/game/      pure logic: types, beam tracer, level generator, campaign, music, progress
src/render/    procedural visuals: board, pieces, beams (shader tubes), sparkles
src/audio/     Web Audio synth (FM bells, pads, ticks) with offline rendering
src/input/     hand tracker (pinch, twist), persistent table anchor
src/ui/hud.ts  UIKitML HUD wrapper (public/ui/hud.uikitml)
src/game-system.ts  the ECS system that ties it all together
```

## License

MIT. Scaffolding from `@iwsdk/create` is MIT-licensed by Meta Platforms, Inc.
