/** Short evocative board names for generated boards (Daily, Kiln). Deterministic per RNG. */

import type { Rng } from '../core/board-gen.js';

const FIRST = [
  'Amber', 'Quiet', 'Glass', 'Ember', 'Pale', 'Hollow', 'Still', 'Bright', 'Low', 'Slow', 'Silver', 'Warm',
  'Late', 'Small', 'Open', 'Folded', 'Bent', 'Clear', 'Deep', 'First', 'Last', 'Soft', 'Thin', 'Wide',
];
const SECOND = [
  'Lantern', 'Fan', 'Prism', 'Shoal', 'Chord', 'Kiln', 'Thread', 'Spark', 'Pool', 'Signal', 'Reed', 'Mirror',
  'Harbor', 'Comet', 'Tide', 'Echo', 'Gate', 'Wick', 'Hand', 'Bell', 'Glow', 'Arc', 'Knot', 'Ray',
];

export function boardName(rng: Rng): string {
  return `${rng.pick(FIRST)} ${rng.pick(SECOND)}`;
}
