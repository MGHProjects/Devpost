/**
 * Campaign: three "movements" of eight puzzles each. The first movement
 * opens with hand-authored lessons (one new idea per puzzle); everything
 * else comes from the seeded generator so it is identical on every device.
 */

import { GenOptions, generateLevel } from './generator.js';
import { daySeed } from './rng.js';
import { Color, LevelDef } from './types.js';

const { R, G, B, Y, M, C, W } = Color;

const lessons: LevelDef[] = [
  {
    id: 'dawn-1',
    name: 'First Light',
    size: 5,
    hint: 'Pinch the mirror and twist your wrist to turn it.',
    board: [
      { kind: 'emitter', x: 0, y: 2, rot: 0, color: C },
      { kind: 'mirror', x: 2, y: 2, rot: 0, lock: 'rotate' },
      { kind: 'target', x: 2, y: 4, color: C },
    ],
    tray: [],
    solution: { tray: [], rotations: { 1: 2 } },
  },
  {
    id: 'dawn-2',
    name: 'Placing',
    size: 5,
    hint: 'Pinch a mirror from the tray and set it down in the light.',
    board: [
      { kind: 'emitter', x: 0, y: 1, rot: 0, color: R },
      { kind: 'target', x: 3, y: 4, color: R },
    ],
    tray: [{ kind: 'mirror' }],
    solution: { tray: [{ x: 3, y: 1, rot: 2 }] },
  },
  {
    id: 'dawn-3',
    name: 'Two Turns',
    size: 5,
    hint: 'Stones swallow light. Find the way around them.',
    board: [
      { kind: 'emitter', x: 0, y: 0, rot: 0, color: B },
      { kind: 'target', x: 4, y: 3, color: B },
      { kind: 'wall', x: 3, y: 2 },
      { kind: 'wall', x: 4, y: 1 },
    ],
    tray: [{ kind: 'mirror' }, { kind: 'mirror' }],
    solution: {
      tray: [
        { x: 2, y: 0, rot: 2 },
        { x: 2, y: 3, rot: 2 },
      ],
    },
  },
  {
    id: 'dawn-4',
    name: 'Unweaving',
    size: 5,
    hint: 'A prism unweaves white light into red, green and blue.',
    board: [
      { kind: 'emitter', x: 0, y: 2, rot: 0, color: W },
      { kind: 'target', x: 4, y: 4, color: R },
      { kind: 'target', x: 4, y: 2, color: G },
      { kind: 'target', x: 4, y: 0, color: B },
    ],
    tray: [{ kind: 'prism' }],
    solution: { tray: [{ x: 2, y: 2, rot: 0 }] },
  },
  {
    id: 'dawn-5',
    name: 'Harmony',
    size: 5,
    hint: 'Crystals can drink from two beams. Red and green make yellow.',
    board: [
      { kind: 'emitter', x: 4, y: 0, rot: 2, color: R },
      { kind: 'emitter', x: 2, y: 4, rot: 6, color: G },
      { kind: 'target', x: 4, y: 2, color: Y },
    ],
    tray: [{ kind: 'mirror' }],
    solution: { tray: [{ x: 2, y: 2, rot: 6 }] },
  },
  {
    id: 'dawn-6',
    name: 'Sieves',
    size: 5,
    hint: 'Half-mirrors split a beam; filters keep only their colour.',
    board: [
      { kind: 'emitter', x: 0, y: 2, rot: 0, color: M },
      { kind: 'splitter', x: 2, y: 2, rot: 0, lock: 'rotate' },
      { kind: 'target', x: 2, y: 0, color: R },
      { kind: 'target', x: 4, y: 2, color: B },
    ],
    tray: [
      { kind: 'filter', color: R },
      { kind: 'filter', color: B },
    ],
    solution: {
      tray: [
        { x: 2, y: 1, rot: 0 },
        { x: 3, y: 2, rot: 0 },
      ],
      rotations: { 1: 6 },
    },
  },
];

interface Tier {
  prefix: string;
  names: string[];
  seed: number;
  opts: (i: number) => GenOptions;
}

const tiers: Tier[] = [
  {
    prefix: 'dawn',
    names: ['Morning Bell', 'Glint'],
    seed: 1100,
    opts: (i) => ({
      size: 5,
      emitters: 1,
      tray: i === 0 ? ['mirror', 'mirror'] : ['prism', 'mirror'],
      rotateLocked: 1,
      walls: 2,
      targets: [1, 2],
      palette: i === 0 ? [R, G, B, C] : [W],
    }),
  },
  {
    prefix: 'noon',
    names: [
      'Overture',
      'Crossing',
      'Sunlit Room',
      'Refrain',
      'Two Voices',
      'Glass Garden',
      'Counterpoint',
      'High Sun',
    ],
    seed: 2200,
    opts: (i) => ({
      size: 6,
      emitters: 1 + (i % 2),
      tray: [
        ['mirror', 'splitter'],
        ['mirror', 'prism'],
        ['splitter', 'mirror'],
        ['mirror', 'filter'],
        ['prism', 'mirror', 'mirror'],
        ['splitter', 'filter'],
        ['mirror', 'mirror', 'mirror'],
        ['prism', 'splitter', 'mirror'],
      ][i] as GenOptions['tray'],
      rotateLocked: i % 3 === 0 ? 1 : 0,
      walls: 3,
      targets: [1 + (i % 2), 3],
      palette: i % 2 === 0 ? [W, Y, C, M] : [W, R, G, B],
    }),
  },
  {
    prefix: 'dusk',
    names: [
      'Evensong',
      'Lanterns',
      'Long Shadows',
      'Nocturne',
      'Fireflies',
      'Stained Glass',
      'Last Light',
      'Starfall',
    ],
    seed: 3300,
    opts: (i) => ({
      size: 7,
      emitters: 2 + (i % 2),
      tray: [
        ['mirror', 'mirror', 'prism'],
        ['splitter', 'mirror', 'mirror'],
        ['prism', 'filter', 'mirror'],
        ['mirror', 'mirror', 'mirror', 'splitter'],
        ['prism', 'prism', 'mirror'],
        ['filter', 'filter', 'splitter', 'mirror'],
        ['mirror', 'mirror', 'prism', 'splitter'],
        ['prism', 'splitter', 'mirror', 'mirror', 'filter'],
      ][i] as GenOptions['tray'],
      rotateLocked: 1,
      walls: 4,
      targets: [3, 4],
      palette: [W, W, Y, C, M],
    }),
  },
];

function buildCampaign(): LevelDef[][] {
  const movements: LevelDef[][] = [[...lessons], [], []];
  tiers.forEach((tier, t) => {
    tier.names.forEach((name, i) => {
      const id = `${tier.prefix}-${(t === 0 ? lessons.length : 0) + i + 1}`;
      movements[t].push(
        generateLevel(id, name, tier.seed + i * 17, tier.opts(i)),
      );
    });
  });
  return movements;
}

export const MOVEMENTS = [
  { id: 'dawn', title: 'I. Dawn', key: 'C' },
  { id: 'noon', title: 'II. Noon', key: 'D' },
  { id: 'dusk', title: 'III. Dusk', key: 'A' },
] as const;

export const CAMPAIGN: LevelDef[][] = buildCampaign();
export const ALL_LEVELS: LevelDef[] = CAMPAIGN.flat();

/** Today's puzzle: same for everyone on the same calendar day. */
export function dailyLevel(date = new Date()): LevelDef {
  const seed = daySeed(date);
  const trays: GenOptions['tray'][] = [
    ['mirror', 'mirror', 'prism'],
    ['splitter', 'mirror', 'filter'],
    ['prism', 'mirror', 'mirror'],
    ['mirror', 'splitter', 'mirror'],
  ];
  return generateLevel(`daily-${seed}`, 'Daily Chord', seed, {
    size: 6,
    emitters: 1 + (seed % 2),
    tray: trays[seed % trays.length],
    rotateLocked: seed % 3 === 0 ? 1 : 0,
    walls: 3,
    targets: [2, 3],
    palette: [W, Y, C, M],
  });
}
