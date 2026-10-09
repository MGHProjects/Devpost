/**
 * Campaign recipes: one BoardSpec per board (pose, how each hand drinks
 * light, colours, extra rules). scripts/gen-campaign.ts turns them into the
 * shipped levels/*.json with the solution-first generator; the runtime only
 * loads the JSON (see campaign.ts). Chapter order, names and hints live here.
 *
 * Hands: the prologue is right-handed; single-hand chapters alternate
 * right / left; multi-cast boards pick each hand by the side it rests on.
 * Thumbs feed light in (tip in a pool) rather than aiming it: a thumb's ray
 * swings too much with small curls to land on a crystal reliably.
 */

import type { BoardSpec } from '../core/board-gen.js';
import { Color } from '../core/types.js';

export interface ChapterSpec {
  id: string;
  title: string;
  /** Index into MOVEMENT_MUSIC (core/music.ts). */
  music: number;
  /** Ship the boards easiest-first (by measured difficulty) instead of in spec order. */
  reorder?: boolean;
  /** Spec ids that keep their slot when reordering (a chapter's capstone). */
  pin?: string[];
  boards: BoardSpec[];
}

const { R, G, B, Y, M, C, W } = Color;
const LEFT_HALF: [number, number, number, number] = [-0.17, 0.0, -0.03, 0.13];
const RIGHT_HALF: [number, number, number, number] = [0.0, 0.17, -0.03, 0.13];

export const CHAPTER_SPECS: ChapterSpec[] = [
  {
    id: 'prologue',
    title: 'First Light',
    music: 0,
    boards: [
      {
        id: 'prologue-1', name: 'First Light', hint: 'Rest your open hand in the pool.',
        intent: 'Right palm in the white pool, fingers open: the four long fingers each light a crystal.',
        tags: ['allowAnySpread'], rivals: 'none',
        casts: [{ pose: 'spread', hand: 'right', yaw: [-35, 35], overrides: { spread: 0.6 }, feeds: [{ kind: 'well-palm', color: W }] }],
      },
      {
        id: 'prologue-2', name: 'One', hint: 'Only one finger may shine.',
        intent: "Palm in the pool, 'point': only the index glows, the hush stones stay dark.",
        casts: [{ pose: 'point', hand: 'right', yaw: [-35, 35], feeds: [{ kind: 'well-palm', color: W }] }],
      },
      {
        id: 'prologue-3', name: 'Peace', hint: 'Two fingers, two notes.',
        intent: "Palm in the pool, peace sign: index and middle light their crystals.",
        casts: [{ pose: 'peace', hand: 'right', yaw: [-35, 35], feeds: [{ kind: 'well-palm', color: W }] }],
      },
      {
        id: 'prologue-4', name: 'Tuck', hint: 'Hide your thumb from the stone.',
        intent: "Palm in the pool, four fingers out, thumb curled under so its hush stays dark.",
        casts: [{ pose: 'four', hand: 'right', yaw: [-35, 35], feeds: [{ kind: 'well-palm', color: W }] }],
      },
      {
        id: 'prologue-5', name: 'Open Chord', hint: 'Wider.',
        intent: "Palm in the pool, hand spread wide: four crystals; a flat hand's rays would wake the hush.",
        tags: ['spreadSolution'],
        casts: [{ pose: 'spread', hand: 'right', yaw: [-35, 35], feeds: [{ kind: 'well-palm', color: W }] }],
      },
    ],
  },
  {
    id: 'fingers',
    title: 'Fingers',
    music: 1,
    reorder: true, pin: ['fingers-8'],
    boards: [
      {
        id: 'fingers-1', name: 'Hook', hint: 'Dip your thumb; let the index speak.',
        intent: "Left hand 'L': thumb tip in the red pool, the index carries red to its crystal.",
        casts: [{ pose: 'L', hand: 'left', feeds: [{ kind: 'well-tip', finger: 0, color: R }] }],
      },
      {
        id: 'fingers-2', name: 'Three', hint: 'Count to three.',
        intent: "Right palm in the green pool, 'three' (index, middle, ring).",
        casts: [{ pose: 'three', hand: 'right', feeds: [{ kind: 'well-palm', color: G }] }],
      },
      {
        id: 'fingers-3', name: 'Shaka', hint: 'Thumb in, little finger out.',
        intent: "Left hand shaka: thumb tip in the blue pool, the pinky lights the crystal.",
        casts: [{ pose: 'shaka', hand: 'left', feeds: [{ kind: 'well-tip', finger: 0, color: B }] }],
      },
      {
        id: 'fingers-4', name: 'Horns', hint: 'Outer fingers only.',
        intent: "Right palm in the white pool, 'rock' (index and pinky).",
        casts: [{ pose: 'rock', hand: 'right', feeds: [{ kind: 'well-palm', color: W }] }],
      },
      {
        id: 'fingers-5', name: 'Four', hint: 'All but one.',
        intent: "Left palm in the yellow pool, four fingers out, thumb tucked.",
        casts: [{ pose: 'four', hand: 'left', feeds: [{ kind: 'well-palm', color: Y }] }],
      },
      {
        id: 'fingers-6', name: 'Dip', hint: 'Light can enter through a fingertip too.',
        intent: "Right peace sign with the index tip in the pool: light leaves through the middle finger.",
        casts: [{ pose: 'peace', hand: 'right', feeds: [{ kind: 'well-tip', finger: 1, color: W }] }],
      },
      {
        id: 'fingers-7', name: 'Little', hint: 'The smallest finger.',
        intent: "Left palm in the magenta pool, only the pinky out.",
        casts: [{ pose: 'pinky', hand: 'left', feeds: [{ kind: 'well-palm', color: M }] }],
      },
      {
        id: 'fingers-8', name: 'Count', hint: 'Not every two is a V.',
        intent: "Right palm in the cyan pool, index and middle held together (no V): a wide V wakes the hush.",
        casts: [{ pose: 'peace', hand: 'right', overrides: { spread: 0 }, feeds: [{ kind: 'well-palm', color: C }] }],
      },
    ],
  },
  {
    id: 'catch',
    title: 'Catch',
    music: 2,
    boards: [
      {
        id: 'catch-1', name: 'Beckon', hint: 'Point at the lamp.',
        intent: 'Right peace sign, index pointing into the lamp beam: the middle finger passes it on.',
        casts: [{ pose: 'peace', hand: 'right', feeds: [{ kind: 'lamp-tip', finger: 1, color: W }] }],
      },
      {
        id: 'catch-2', name: 'Signal', hint: 'Catch it on one finger, give it to two.',
        intent: "Left 'three', index catching the lamp: middle and ring light their crystals.",
        casts: [{ pose: 'three', hand: 'left', feeds: [{ kind: 'lamp-tip', finger: 1, color: G }] }],
      },
      {
        id: 'catch-3', name: 'Side Light', hint: 'The lamp is beside you.',
        intent: "Right 'four' turned toward the side lamp, index catching it.",
        casts: [{ pose: 'four', hand: 'right', feeds: [{ kind: 'lamp-tip', finger: 1, color: W, edges: ['right', 'far'] }] }],
      },
      {
        id: 'catch-4', name: 'Wrist', hint: 'Let the beam run up your arm.',
        intent: "Left 'rock' with the lamp beam entering the wrist: index and pinky shine.",
        casts: [{ pose: 'rock', hand: 'left', feeds: [{ kind: 'lamp-wrist', color: W }] }],
      },
      {
        id: 'catch-5', name: 'Little Catch', hint: 'Catch with the small one.',
        intent: "Right 'rock', the pinky pointing into the lamp: the index carries it on.",
        casts: [{ pose: 'rock', hand: 'right', feeds: [{ kind: 'lamp-tip', finger: 4, color: B }] }],
      },
      {
        id: 'catch-6', name: 'Yellow', hint: 'Two lamps, one hand.',
        intent: 'Left peace sign: index catches the red lamp, the wrist the green one; the middle finger glows yellow.',
        casts: [{ pose: 'peace', hand: 'left', feeds: [{ kind: 'lamp-tip', finger: 1, color: R }, { kind: 'lamp-wrist', color: G }] }],
      },
      {
        id: 'catch-7', name: 'Cyan', hint: 'Mix them in your palm.',
        intent: "Right 'three': index catches green, wrist catches blue; middle and ring glow cyan.",
        casts: [{ pose: 'three', hand: 'right', feeds: [{ kind: 'lamp-tip', finger: 1, color: G }, { kind: 'lamp-wrist', color: B }] }],
      },
      {
        id: 'catch-8', name: 'Magenta', hint: 'Red meets blue.',
        intent: "Left 'four': pinky catches red, wrist catches blue; index, middle and ring glow magenta.",
        casts: [{ pose: 'four', hand: 'left', feeds: [{ kind: 'lamp-tip', finger: 4, color: R }, { kind: 'lamp-wrist', color: B }] }],
      },
    ],
  },
  {
    id: 'mirror',
    title: 'Mirror Palm',
    music: 3,
    boards: [
      {
        id: 'mirror-1', name: 'Mirror', hint: 'Stand your hand on its edge.',
        intent: 'Right blade hand (on the pinky edge, fingers together) bounces the lamp onto the crystal.',
        casts: [{ pose: 'blade', hand: 'right', feeds: [{ kind: 'lamp-blade', color: W }] }],
      },
      {
        id: 'mirror-2', name: 'Glance', hint: 'Angle the mirror.',
        intent: 'Left blade turned so the red beam glances onto its crystal.',
        casts: [{ pose: 'blade', hand: 'left', feeds: [{ kind: 'lamp-blade', color: R }] }],
      },
      {
        id: 'mirror-3', name: 'Bounce', hint: 'Back toward the light.',
        intent: 'Right blade reflecting the blue lamp.',
        casts: [{ pose: 'blade', hand: 'right', feeds: [{ kind: 'lamp-blade', color: B, edges: ['left', 'right'] }] }],
      },
      {
        id: 'mirror-4', name: 'Two Faces', hint: 'Your palm and the back of your hand both shine.',
        intent: 'Left blade struck by two lamps: each face sends one beam to its crystal.',
        casts: [{ pose: 'blade', hand: 'left', feeds: [{ kind: 'lamp-blade', color: G }, { kind: 'lamp-blade', color: R }] }],
      },
      {
        id: 'mirror-5', name: 'Silver', hint: 'One mirror, two colours.',
        intent: 'Right blade reflecting a yellow and a blue lamp onto two crystals.',
        casts: [{ pose: 'blade', hand: 'right', feeds: [{ kind: 'lamp-blade', color: Y }, { kind: 'lamp-blade', color: B }] }],
      },
      {
        id: 'mirror-6', name: 'Mirror Guide', hint: 'Mirror first, then catch.',
        intent: 'Blade bounces the lamp into a peace sign\'s index tip; the middle finger lights the crystal.',
        casts: [
          { pose: 'blade', feeds: [{ kind: 'lamp-blade', color: W }] },
          { pose: 'peace', feeds: [{ kind: 'relay-tip', finger: 1, slack: 40 }] },
        ],
      },
      {
        id: 'mirror-7', name: 'Fan Mirror', hint: 'Point at your own mirror.',
        intent: "Palm in the pool, 'point' at a blade hand that turns the beam onto the crystal.",
        casts: [
          { pose: 'point', feeds: [{ kind: 'well-palm', color: M }] },
          { pose: 'blade', feeds: [{ kind: 'relay-blade', fromFinger: 1 }] },
        ],
      },
      {
        id: 'mirror-8', name: 'Periscope', hint: 'Mirror into the wrist.',
        intent: 'Blade bounces the cyan lamp into a second hand\'s wrist; its open fingers light the crystals.',
        casts: [
          { pose: 'blade', feeds: [{ kind: 'lamp-blade', color: C }] },
          { pose: 'rock', feeds: [{ kind: 'relay-wrist', slack: 70 }] },
        ],
      },
    ],
  },
  {
    id: 'relay',
    title: 'Relay',
    music: 4,
    boards: [
      {
        id: 'relay-1', name: 'Pass', hint: 'One hand points, the other catches.',
        intent: "Left 'point' in the pool aims at the right peace sign's index; its middle finger lights the crystal.",
        casts: [
          { pose: 'point', hand: 'left', region: LEFT_HALF, yaw: [20, 66], feeds: [{ kind: 'well-palm', color: W }] },
          { pose: 'peace', hand: 'right', feeds: [{ kind: 'relay-tip', finger: 1, slack: 62 }] },
        ],
      },
      {
        id: 'relay-2', name: 'Hand Off', hint: 'Fingertip to wrist.',
        intent: "Left 'rock' in the pool: its pinky lights a crystal, its index feeds the right hand's wrist.",
        casts: [
          { pose: 'rock', hand: 'left', feeds: [{ kind: 'well-palm', color: Y }] },
          { pose: 'point', hand: 'right', feeds: [{ kind: 'relay-wrist', slack: 72 }] },
        ],
      },
      {
        id: 'relay-3', name: 'Baton', hint: 'Pass it along.',
        intent: "Right peace sign in the pool; its index feeds a left 'three' through the index tip.",
        casts: [
          { pose: 'peace', hand: 'right', region: RIGHT_HALF, yaw: [-66, -15], feeds: [{ kind: 'well-palm', color: G }] },
          { pose: 'three', hand: 'left', feeds: [{ kind: 'relay-tip', finger: 1, slack: 62 }] },
        ],
      },
      {
        id: 'relay-4', name: 'Across', hint: 'Catch with the wrist, throw with a finger.',
        intent: "A left 'point' takes the red lamp into its wrist and points it into the index of a right 'rock'; its pinky lights the crystal.",
        casts: [
          { pose: 'point', hand: 'left', region: LEFT_HALF, yaw: [25, 66], feeds: [{ kind: 'lamp-wrist', color: R, edges: ['left', 'near'] }] },
          { pose: 'rock', hand: 'right', feeds: [{ kind: 'relay-tip', finger: 1, slack: 60 }] },
        ],
      },
      {
        id: 'relay-5', name: 'Walls', hint: 'No straight path.',
        intent: 'A pointing hand in the pool feeds a second hand around the walls.',
        blockShortcuts: true, minWalls: 2,
        casts: [
          { pose: 'point', hand: 'right', region: RIGHT_HALF, yaw: [-66, -25], feeds: [{ kind: 'well-palm', color: B }] },
          { pose: 'three', hand: 'left', feeds: [{ kind: 'relay-tip', finger: 1, slack: 62 }] },
        ],
      },
      {
        id: 'relay-6', name: 'Wrist Relay', hint: 'One for the crystal, one for the wrist.',
        intent: "Left peace sign in the cyan pool: one finger lights a crystal, the other shines into a right 'point' hand's wrist.",
        casts: [
          { pose: 'peace', hand: 'left', feeds: [{ kind: 'well-palm', color: C }] },
          { pose: 'point', hand: 'right', feeds: [{ kind: 'relay-wrist', slack: 72 }] },
        ],
      },
      {
        id: 'relay-7', name: 'Three Hands', hint: 'Every hand you need is yours.',
        intent: "Pool -> left 'point' -> right peace sign (index in, middle out) -> a third hand's wrist -> crystal.",
        blockShortcuts: true,
        casts: [
          { pose: 'point', hand: 'left', region: LEFT_HALF, yaw: [25, 66], feeds: [{ kind: 'well-palm', color: W }] },
          { pose: 'peace', hand: 'right', feeds: [{ kind: 'relay-tip', finger: 1, slack: 62 }], crystals: 0 },
          { pose: 'point', feeds: [{ kind: 'relay-wrist', slack: 72 }] },
        ],
      },
      {
        id: 'relay-8', name: 'Creation', hint: 'Almost touching.',
        intent: "Left 'point' in the pool and right peace sign, index fingertips almost touching; the right middle finger lights the crystal.",
        casts: [
          { pose: 'point', hand: 'left', region: LEFT_HALF, yaw: [25, 66], feeds: [{ kind: 'well-palm', color: W }] },
          { pose: 'peace', hand: 'right', feeds: [{ kind: 'relay-tip', finger: 1, slack: 65, dist: [0.03, 0.05] }] },
        ],
      },
    ],
  },
  {
    id: 'colour',
    title: 'Colour',
    music: 5,
    boards: [
      {
        id: 'colour-1', name: 'Warm', hint: 'Red and green make yellow.',
        intent: "Right 'three': palm in the red pool, index tip in the green one; middle and ring glow yellow.",
        casts: [{ pose: 'three', hand: 'right', feeds: [{ kind: 'well-palm', color: R }, { kind: 'well-tip', finger: 1, color: G }] }],
      },
      {
        id: 'colour-2', name: 'Sea', hint: 'Green and blue.',
        intent: "Left 'four': palm in green, pinky tip in blue; the other three glow cyan.",
        casts: [{ pose: 'four', hand: 'left', feeds: [{ kind: 'well-palm', color: G }, { kind: 'well-tip', finger: 4, color: B }] }],
      },
      {
        id: 'colour-3', name: 'Dusk', hint: 'A lamp and a pool.',
        intent: 'Right peace sign: index catches the red lamp, palm rests in blue; the middle finger glows magenta.',
        casts: [{ pose: 'peace', hand: 'right', feeds: [{ kind: 'well-palm', color: B }, { kind: 'lamp-tip', finger: 1, color: R }] }],
        decoyWells: [G],
      },
      {
        id: 'colour-4', name: 'Decoy', hint: 'Not every pool is yours.',
        intent: "Left 'rock' in the yellow pool; the red and blue pools are decoys.",
        casts: [{ pose: 'rock', hand: 'left', feeds: [{ kind: 'well-palm', color: Y }] }],
        decoyWells: [R, B],
      },
      {
        id: 'colour-5', name: 'White', hint: 'All three.',
        intent: "Right 'four': palm in red, index tip in green, pinky tip in blue; middle and ring glow white.",
        casts: [{ pose: 'four', hand: 'right', feeds: [{ kind: 'well-palm', color: R }, { kind: 'well-tip', finger: 1, color: G }, { kind: 'well-tip', finger: 4, color: B }] }],
      },
      {
        id: 'colour-6', name: 'Blend', hint: 'Pass red into blue.',
        intent: "A 'point' hand in the red pool shines into an 'L' hand's wrist; its thumb tip rests in blue, so the index glows magenta.",
        casts: [
          { pose: 'point', hand: 'left', feeds: [{ kind: 'well-palm', color: R }] },
          { pose: 'L', hand: 'right', feeds: [{ kind: 'relay-wrist', slack: 72 }, { kind: 'well-tip', finger: 0, color: B }] },
        ],
      },
      {
        id: 'colour-7', name: 'Prism', hint: 'Choose your pools.',
        intent: "A hand in the green pool points into a peace sign's index while a red lamp fills its wrist: the middle finger glows yellow.",
        casts: [
          { pose: 'point', hand: 'left', region: LEFT_HALF, yaw: [25, 66], feeds: [{ kind: 'well-palm', color: G }] },
          { pose: 'peace', hand: 'right', feeds: [{ kind: 'relay-tip', finger: 1, slack: 62 }, { kind: 'lamp-wrist', color: R }] },
        ],
        decoyWells: [B],
      },
      {
        id: 'colour-8', name: 'Rainbow', hint: 'Every colour has a place.',
        intent: "A left peace sign in the blue pool lights a blue crystal and points into a right 'rock'; a red lamp fills that hand's wrist, so its pinky glows magenta.",
        casts: [
          { pose: 'peace', hand: 'left', region: LEFT_HALF, yaw: [25, 66], feeds: [{ kind: 'well-palm', color: B }] },
          { pose: 'rock', hand: 'right', feeds: [{ kind: 'relay-tip', finger: 1, slack: 60 }, { kind: 'lamp-wrist', color: R }] },
        ],
        decoyWells: [G],
      },
    ],
  },
  {
    id: 'finale',
    title: 'Count to Ten',
    music: 6,
    boards: [
      {
        id: 'finale-1', name: 'Together', hint: 'Both hands.',
        intent: 'Left and right peace signs, each palm in its own pool: four crystals.',
        casts: [
          { pose: 'peace', hand: 'left', region: LEFT_HALF, feeds: [{ kind: 'well-palm', color: B }] },
          { pose: 'peace', hand: 'right', region: RIGHT_HALF, feeds: [{ kind: 'well-palm', color: R }] },
        ],
      },
      {
        id: 'finale-2', name: 'Seven', hint: 'Three and four.',
        intent: "Left 'three' and right 'four', palms in their pools: seven crystals.",
        casts: [
          { pose: 'three', hand: 'left', region: LEFT_HALF, feeds: [{ kind: 'well-palm', color: G }] },
          { pose: 'four', hand: 'right', region: RIGHT_HALF, feeds: [{ kind: 'well-palm', color: Y }] },
        ],
      },
      {
        id: 'finale-3', name: 'Duet', hint: 'Four and four.',
        intent: "Left and right 'four' hands in magenta and cyan pools: eight crystals.",
        casts: [
          { pose: 'four', hand: 'left', region: LEFT_HALF, feeds: [{ kind: 'well-palm', color: M }] },
          { pose: 'four', hand: 'right', region: RIGHT_HALF, feeds: [{ kind: 'well-palm', color: C }] },
        ],
      },
      {
        id: 'finale-4', name: 'Count to Ten', hint: 'Open everything.',
        intent: 'Both hands spread wide in the white pools: every long finger lights a crystal (eight).',
        casts: [
          { pose: 'spread', hand: 'left', region: LEFT_HALF, feeds: [{ kind: 'well-palm', color: W }] },
          { pose: 'spread', hand: 'right', region: RIGHT_HALF, feeds: [{ kind: 'well-palm', color: W }] },
        ],
      },
    ],
  },
];
