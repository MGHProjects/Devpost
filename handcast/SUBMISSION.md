# Devpost submission draft: Meta VR Start Developer Competition 2026

Copy these into the submission form. Items marked **TODO** need your input.
Every feature named here exists in the code in this folder, and every number is
the value the code uses.

## Submission name

HANDCAST

## Tagline (140 characters max)

> Your own hand is the only optic: shape it in the light, hold still, and it freezes into glass that steers beams into singing crystals.

(134 characters)

## Track / Division

- **Track:** Gaming
- **Division:** New Experience. The project was conceived and built inside the
  competition window, after 24 Sep 2026, starting from the IWSDK project
  template. No earlier codebase or shipped title was reused.

## Project link

https://mghprojects.github.io/Devpost/

Judges open it in the Meta Quest Browser and tap **Enter XR**. Play seated at
a table with hand tracking on and the controllers put down. On first launch
the game asks you to rest one hand flat on the table and hold still; that is
how it finds the table.

## Demo video

**TODO:** upload `media/handcast-demo.mp4` to YouTube (public) and paste the
link here. It must be under 3 minutes. It is captured in the IWER Meta Quest 3
emulator, which the rules allow ("via XR Simulator, or another equivalent
emulator").

## Description (about 550 words; the form suggests 500 or fewer)

**Inspiration.** Most hand-tracking games treat the hand as a controller
without buttons. We wanted the shape of the hand to be the game. In HANDCAST
your own hand is the only optic.

**What it does.** A small glass bench appears on your real table through
passthrough, with lamps, pools of light, crystals that each want one exact
colour, and hush stones that must stay dark. Shape your hand in the
light and hold still: molten glass flows from wrist to fingertips and freezes
into a glass copy of that exact pose, all 25 joints. Slide your hand out and
the glass stays. Light that enters one open end of a glass hand (the wrist, a
palm resting in a pool, or an extended fingertip) leaves through every other
open fingertip. An open hand fans light out, a flat hand on its edge is a
mirror, a fist is a stone. Colours add: red and green make yellow. Pinch a
glass hand's foot to slide and twist it, knock it over with a fist to get the
glass back, or strum its fingers.

There are 49 boards in seven chapters, a Daily board that is the same for
everyone, the Kiln for endless generated boards, and a Studio for building
boards with your hands. Published boards go to the Hall of Hands; after you
solve one, other players' glass hands fade in beside yours. Every crystal is a
note and every board a chord, synthesised live.

**Why it is new.** Tabletop light-routing puzzles already ship: Lumen Lab VR
on the Horizon Store (September 2026: "A table. A beam. Mirrors you pick up
with your hands"), LaserBlaze, Labyrinth deLux, Carpe Lucem. Our first concept
was the same kind of game, so we dropped it. We found no shipped game that freezes the
player's own tracked hand pose into a persistent optic that is the puzzle
piece. The loop cannot work with controllers, which have no fingers to open or
curl.

**How we built it.** Immersive Web SDK (WebXR, three.js, ECS) in the Quest
Browser. A 2D light tracer runs every frame with your live hands for display
and with the glass hands alone for the solve check. A single-pass glass shader
lights each finger from inside with the colour it carries. All sound is Web
Audio synthesis with HRTF panning. Every campaign board comes from a
solution-first generator and passes a validator: solvable, robust to hand
wobble, and (after the first board) not solvable by a lazy open hand. 307 unit tests run on every
build, and 20 end-to-end checks drive emulated hands.

**Hands-first design.** You find the table by resting a flat
hand on it; everything is seated and within reach. Looking at a crystal makes
it sing and names the colour it needs.

**Challenges.** Making "hold still" dependable on jittery tracking, stopping
fingers from flickering between open and closed, and making a twist precise
enough to aim a beam.

**Accomplishments.** A complete game loop with no controller anywhere.
Published hands are retargeted to
standard bone lengths, so hand size never leaves the headset; names are
generated, the middle-finger gesture is rejected, and the optional server
re-traces every solution.

**What's next.** Testing with more real hands, more chapters, ink pots that
tint a finger, and a Horizon Store release.

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
  lit (a fan hand receiving light, or a blade or fist touched by a beam) and
  still fills a casting meter in 0.7 s, or 1.2 s in Steady mode; moving drains
  it twice as fast. When it fills, the pose is the average of the last 8 raw
  frames, which removes jitter without filter lag. That hand must then move
  7 cm before it can cast again.
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
- **Table calibration.** Palm facing down, at least three long fingers
  straight, held still for 0.8 s. The table height is taken from the
  fingertips minus their joint radii, and the bench turns to face you.
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
- **Best First Five Minutes:** calibration is one gesture (rest a flat hand),
  the first board is "rest your open hand in the pool", and the five prologue
  boards each teach one idea.
- **Best Reason to Come Back:** the Daily board with a streak, the Kiln, and
  the Hall of Hands, where (with the online backend) you see how other players
shaped their hands.
- **Best Accessibility Forward Experience:** seated, one-handed gestures,
  Steady mode, colour names in the status line and colour-blind glyphs on every
  crystal.

For the judging criteria: Technical Implementation names hand tracking, gaze,
passthrough and spatial anchoring, and HANDCAST uses all four. Polish names
sound design, and every sound is synthesised live, with sounds on the bench
placed in 3D (HRTF).

## Target launch date

**TODO:** for example, Q1 2027 on the Meta Horizon Store as a PWA.

## Team

**TODO:** name, email and role for each member.
