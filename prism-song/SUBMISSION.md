# Devpost submission draft: Meta VR Start Developer Competition 2026

Copy these into the submission form. Items marked **TODO** need your input.

## Submission name

Prism Song

## Tagline (140 characters max)

> Pinch, place and twist mirrors to steer light into singing crystals. A seated, hands-first MR puzzle where every solve plays a chord.

(133 characters)

## Track / Division

- **Track:** Gaming
- **Division:** New Experience. The project was conceived and built inside the
  competition window, starting from an empty repository after 24 Sep 2026.

## Project link

**TODO:** the GitHub Pages URL once Pages is enabled, e.g.
`https://mghprojects.github.io/Devpost/`.
Judges open it in the Meta Quest Browser and tap **Enter XR**.

## Demo video

**TODO:** upload `prism-song-demo.mp4` to YouTube (public) and paste the link.
It's under 3 minutes and was captured in the IWER Meta Quest 3 emulator, which the rules allow.

## Description (about 450 words)

**Inspiration.** We wanted a puzzle that feels like handling real objects on a
table, not like operating a menu. Light is perfect for that: you can see it,
and with a little synthesis you can *hear* it. Prism Song turns light into
music. Each crystal is a note, each solved board is a chord, and the eight
puzzles of a movement add up to a song you composed by solving them.

**What it does.** A small glass table appears in your room through passthrough,
at seated height. Beams of coloured light cross it. You pinch mirrors, prisms,
half-mirrors and colour filters from a tray, set them down, and twist your wrist
to turn them, steering beams into crystals. A prism unweaves white light into
red, green and blue. Crystals add up the light they receive, so red and green
make yellow, and each one wants one exact colour. While you hold a piece, the
beams re-trace live and the crystals ring as light reaches them, so the board
behaves like an instrument. There are 24 puzzles across three movements (Dawn,
Noon, Dusk), plus a Daily Chord puzzle that's the same for everyone and keeps
a streak.

**How we built it.** Prism Song uses the Immersive Web SDK (WebXR, three.js,
ECS) and runs in the Quest browser. All geometry is procedural. All audio is
synthesised live with Web Audio: FM glass bells, sustained pads and HRTF
spatialisation, with no sound files. A deterministic beam tracer drives both
the visuals and the music. The puzzles come from a seeded generator that builds
a solution first and then validates every level: solvable, not already solved,
and no spare pieces. Unit tests check the tracer, all 24 levels and a year of
daily puzzles. End-to-end tests drive emulated hands through pinch, twist, poke
and moving the table.

**Hands-first design.** Pinch to pick up, twist to turn, release to place. A
fingertip poke also works for everything, so the whole game is playable with
one hand or one finger. Looking at a crystal plays its note and says which
colour it needs. The table sits within a two-foot radius, needs no
locomotion, and stays anchored in your room between sessions. Colour-blind
glyphs mark every crystal and filter.

**Challenges.** Making wrist twist feel precise: we decompose the wrist
rotation into a twist around the table's up axis and snap it to 22.5° steps
with a tactile tick on each one. Also, keeping a poke and a pinch on the same
piece from fighting each other.

**What's next.** A puzzle editor with shareable seeds, a co-located two-player
mode where each player holds half the optics, more optics (portals, colour
shifters), and a Horizon Store release as a PWA.

## How hand interactions are implemented (optional field)

Hand tracking reads the WebXR joints directly. A pinch is the thumb-to-index
distance, with hysteresis. The pinch point picks up the nearest piece within
4.5 cm. Twist is a swing-twist decomposition of the wrist quaternion around the
table's up axis, scaled by 1.5 and snapped to 22.5°. Poke uses IWSDK's
`PokeInteractable` touch pointer, and taps are timed with the game clock. Gaze
uses the IWSDK gaze source, falling back to head direction. Ray plus pinch,
controllers and mouse go through the same pointer-event path. The table handle
is a pinch target that carries the board and re-anchors it with a persistent
WebXR spatial anchor.

## Target launch date

**TODO:** for example, Q1 2027 on the Meta Horizon Store as a PWA.

## Team

**TODO:** name, email and role for each member.
