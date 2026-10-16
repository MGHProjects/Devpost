# Devpost submission draft: Meta VR Start Developer Competition 2026

Copy these into the submission form. Items marked **TODO** need your input.
Every feature named here exists in the code in this folder, and every number is
the value the code uses.

## Submission name

HANDCAST

## Tagline (140 characters max)

> Hold still and your hand turns to glass. Your frozen pose is the puzzle piece: it bends light on your real table.

(113 characters)

## Track / Division

- **Track:** Gaming
- **Division:** New Experience. The project was conceived and built inside the
  competition window, after 24 Sep 2026, starting from the IWSDK project
  template. No earlier codebase or shipped title was reused.

## Project link

https://mghprojects.github.io/Devpost/

**Testing instructions** (also in the description): open the link in the
Meta Quest Browser, turn hand tracking on and put the controllers down, sit at
a table and tap **Enter XR** (allow the Spatial permission if asked, so the
headset can see the table). Rest a flat hand on the table: the bench pours out
from under your palm. Menu > **TOUR** plays six boards that show the range in
about ten minutes.

## Demo video

**TODO:** re-cut on footage captured on a Meta Quest 3 (owner capture
sessions, see `PRUEBA-QUEST3.md` and the video plan), under 3 minutes, every
shot labelled "Captured on Meta Quest 3" or "Emulator". Upload to YouTube
(public) and paste the link here. The current `media/handcast-demo.mp4` is
emulator-only and is a fallback.

## Thumbnail and gallery

- Thumbnail (3:2): `media/brand/handcast-thumbnail.png`.
- Logo: `media/brand/handcast-logo.png` (transparent: `handcast-logo-transparent.png`),
  emblem: `media/brand/handcast-emblem.png`.
- Gallery: stills from the demo video (`media/stills/`).

## Description (under 500 words)

Rest your hand in a pool of light on your real table and hold still. Molten
glass flows over your fingers and freezes into an exact copy of your pose. Slide your hand out: the glass stays, and its shape decides what it
does to light. An open hand fans it, a flat hand on its edge mirrors it, a fist
stops it. Light every crystal in its exact colour, keep the hush stones dark,
and the board plays its chord. There are no mirrors to pick up. Your hand is
the piece.

**Testing instructions.** Meta Quest Browser, hand tracking on, controllers
down, seated at a table. Tap Enter XR and allow Spatial if asked. Rest a flat
hand on the table. Menu > TOUR plays six boards that show the range.

**Hands-first, end to end.** No controller anywhere: cast by holding still,
pinch a glass hand's foot to slide and twist it, knock it over with a fist to
get the glass back, strum its fingers. Controllers have no fingers to open or
curl, so the game cannot exist on them.

**Your real table is the play surface.** The headset's view of the room
(planes or depth hit-test) puts a ghost hand on your table before you do
anything; your resting hand confirms it and the bench pours out from under your
palm, flush with the tabletop and anchored for next time. Your real hand is
drawn in front of the light, not under the bench.

**Built for Quest 3 and the coming VR Glasses.** Essential UI sits in a narrow
field of view; menus answer gaze plus pinch; 90 Hz, falling back to a steady
72 when needed.

**Intent and tracking loss.** Hold-still tolerances (7 mm palm, 10 mm
fingertips, 4 degrees), open/curled hysteresis, a 0.25 s gap tolerance, Steady
mode, a hand that must lift off before it casts again, and a pause while the
system menu is up. In the prologue a dead-end cast is knocked over by a ghost
fist and refunded, so a newcomer never gets stuck.

**Content and coming back.** 49 boards in seven chapters, a Daily with a
streak, endless Kiln boards, and a Studio where you build a board by casting
its answer and share it to the Hall of Hands. Hint shows the light path first,
the hand only second. Every board is a chord, synthesised live.

**How we built it.** Immersive Web SDK (WebXR, three.js, ECS) and a 2D light
tracer. Boards come from a solution-first generator and validator (solvable,
wobble-robust, every hand needed); an end-to-end suite casts all 49 through
emulated hand tracking.

**Design insight.** Hand-shadow puzzles make you hold one hand still while the
other works. Freezing the pose removes that strain and turns your hand into an
object you can move, knock over, play and share.

**What's next.** Ink that stains a finger, two hands touching to fuse glass,
and a Meta Horizon Store release as a PWA (target Q1 2027).

## How hand interactions are implemented (optional field)

- **Joints.** Each frame reads all 25 WebXR hand joints of both hands
  (`fillPoses` and `fillJointRadii`, falling back to `getJointPose`) and moves
  them into bench space. Positions go through a One-Euro filter (1.2 Hz
  minimum cutoff, beta 12); joint orientations are slerp-smoothed with a
  cutoff that rises with the error.
- **Hand optics.** A finger is open when its tip-to-knuckle distance is more
  than 0.88 of its bone length (it closes again below 0.82, so it does not
  flicker). Palm facing up or down with fingers open = fan. Hand on its edge
  with all four long fingers open and together = blade, a two-sided mirror
  from wrist to middle fingertip. No finger open = stone, which absorbs.
- **Pinch.** Thumb-tip to index-tip distance with hysteresis: on below 18 mm,
  off above 32 mm. The pinch point is the midpoint of the two tips.
- **Stillness.** Over a 0.6 s window the palm centre must stay within 7 mm of
  its mean, every fingertip within 10 mm and the palm normal within 4 degrees;
  one bad sample is forgiven.
- **Casting.** A hand over the bench (palm less than 11 cm above it) that is
  lit (a fan hand receiving light, or a blade or fist touched by a beam
  anywhere along it) and
  still fills a casting meter in 0.7 s, or 1.2 s in Steady mode; moving drains
  it twice as fast. When it fills, the pose is the average of the last 8 raw
  frames, which removes jitter without filter lag. That hand must then move
  7 cm before it can cast again (also after a grab, a Studio placement or an
  erase). A tracking gap under 0.25 s keeps the hold, the grab and the
  stillness window, so a palm flickering on the table does not start over.
- **Slide and twist.** A pinch that starts within 4 cm of a glass hand's foot
  grabs it. The glass follows the pinch point. Twist is a swing-twist
  decomposition of the wrist rotation about the bench's up axis, unwrapped past
  180 degrees and snapped to 3 degree detents. Releasing off the bench
  shatters the glass.
- **Knock.** All four long fingers curled and knuckles moving faster than
  0.6 m/s, within 7.5 cm of a glass hand: it shatters and the glass is
  refunded.
- **Pluck.** An index fingertip crossing an open glass finger (a 9 mm tine)
  faster than 0.15 m/s plays a plucked glass note, louder with speed.
- **Table calibration.** While it waits, plane detection (from Space Setup)
  or a hit-test along the head's forward ray finds a horizontal surface at
  table height and a ghost glass hand presses flat on it. A real hand palm
  down, at least three long fingers straight, held still for 0.8 s confirms it:
  the hand glows with the molten coat while the hold builds, and the bench
  takes the detected plane's height (or the fingertips minus their joint radii
  when there is no plane). The bench pours out from under the palm and turns
  to face you; that hand must lift off before it can cast. With no hand after
  9 s the bench pours onto the detected table; with neither feature granted it
  appears in front of you at 15 s. The table is saved as a persistent anchor.
- **Your hand in front of the light.** IWSDK's depth-writing hand mesh is drawn
  before the bench and grown 1.5 mm outside the skin, so in passthrough your
  real hand covers the slab, beams and crystals behind it.
- **System menu.** While the Quest menu is open, a held glass hand is set
  down, a pour in progress drains and sound is ducked; tracking restarts fresh
  when you come back.
- **Gaze.** Head direction: a crystal within 6 degrees of where you look, for
  half a second, rings its note and the status line names its colour.
- **Panels.** The menu panel takes a hand-ray pinch or a fingertip poke. Panel
  presses are ignored while a hand is holding glass or casting.

**What excites us about the future of VR.** Hand tracking is now precise
enough that a pose can be saved, shared and replayed. That makes the body
itself a material for games and tools, not just a pointer.

## Fit with the special awards

Plain statements of fit with the special awards on the competition page:

- **Boldest Original Concept:** the puzzle pieces are frozen copies of the
  player's own hand poses.
- **Best First Five Minutes:** a ghost hand shows the one gesture on your real
  table, the bench pours out of your palm, board 1 shows its verb before any
  words, Hint is progressive, and a dead-end cast in the prologue is knocked
  over and refunded by a ghost fist (which also teaches the knock).
- **Best Reason to Come Back:** the Daily board with a streak, the Kiln, and
  the Hall of Hands, where (with the online backend) you see how other players
shaped their hands.
- (Not pitched, but present: seated play, one-handed gestures, Steady mode,
  a large-text high-contrast HUD, colour letters on every crystal chip and
  colour glyphs on every crystal.)

For the judging criteria: Technical Implementation names hand tracking, gaze,
passthrough, spatial anchoring and FoV-aware design; HANDCAST uses all five,
plus plane detection and depth hit-test to find the table (all optional, with
a hand-rest fallback for rooms the headset has not scanned). Polish names
sound design, and every sound is synthesised live, with sounds on the bench
placed in 3D (HRTF).

## Target launch date

**TODO:** for example, Q1 2027 on the Meta Horizon Store as a PWA.

## Team

**TODO:** name, email and role for each member.
