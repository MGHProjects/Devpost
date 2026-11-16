// HANDCAST: pure function of time. window.seek(t) paints frame t (see lib/motion.js).
// Timing is in beats (u) on the measured grid; docs/shotlist.md is the plan this file follows.
// Every gameplay image is a real frame of the Quest 3 capture, played at 1x.
import * as M from './lib/motion.js';

const { W, H, E, prog, lerp, clamp, springU, SPRING, font, layout, glyph, text, fill, cover, shake, hash01, TS, U } = M;

const C = { night: '#06080d', ink: '#0a0e16', warm: '#f4efe6', dim: 'rgba(244,239,230,0.62)', accent: '#8fd0ff' };
const DISPLAY = 'Display', UI = 'UI';
const FPS_CLIP = 30;

// Real capture shots. src = source second where the shot starts (= first extracted frame).
const SHOTS = {
  hook:   { b0: 0,   b1: 9,   n: 129, zoom: [1.0, 1.06], fx: [0.55, 0.6], fy: [0.55, 0.6] },
  pour:   { b0: 9,   b1: 16,  n: 103, zoom: [1.04, 1.16], fx: [0.5, 0.52], fy: [0.62, 0.66] },
  point:  { b0: 24,  b1: 38,  n: 202, zoom: [1.06, 1.12], fx: [0.62, 0.6], fy: [0.62, 0.6] },
  mirror: { b0: 38,  b1: 53,  n: 214, zoom: [1.08, 1.12], fx: [0.4, 0.6], fy: [0.62, 0.62] },
  relay:  { b0: 53,  b1: 72,  n: 274, zoom: [1.06, 1.1], fx: [0.5, 0.55], fy: [0.62, 0.62], punch: [56, 64] },
  colour: { b0: 72,  b1: 89,  n: 244, zoom: [1.06, 1.12], fx: [0.62, 0.6], fy: [0.6, 0.6] },
  two:    { b0: 89,  b1: 110, n: 298, zoom: [1.02, 1.14], fx: [0.45, 0.5], fy: [0.64, 0.62] },
  ten:    { b0: 110, b1: 134, n: 340, zoom: [1.04, 1.1], fx: [0.6, 0.58], fy: [0.58, 0.6] },
  daily:  { b0: 134, b1: 144, n: 145, zoom: [1.06, 1.14], fx: [0.4, 0.42], fy: [0.66, 0.66] },
};

// Every accent: [beat, label, sfx, opts]. sfx.mjs voices them from this list.
const HITS = [
  [0, 'open on the hand', 'swell', { len: 1.2 }],
  [4, 'HOLD STILL', 'impact'],
  [7, '= GLASS', 'bell', { pitch: 'A5' }],
  [9, 'reveal: the pour', 'whoosh', { len: 0.5 }],
  [12, 'ANY TABLE', 'click'],
  [16, 'title drop', 'riser', { len: 1.6 }],
  [16, 'title drop', 'impact'],
  [20, 'YOUR', 'pop', { pitch: 'D5' }],
  [20.5, 'HAND', 'pop', { pitch: 'F5' }],
  [21, 'IS THE', 'pop', { pitch: 'A5' }],
  [21.5, 'PUZZLE PIECE', 'pop', { pitch: 'D6' }],
  [24, 'beam sweep: POINT', 'whoosh', { len: 0.4, from: 700, to: 2600 }],
  [24, 'POINT', 'tick'],
  [30, 'FREEZE', 'bell', { pitch: 'D6' }],
  [35, 'KNOCK', 'impact'],
  [38, 'cut to mirror', 'thud'],
  [40, 'MIRROR', 'blip', { pitch: 'A5' }],
  [53, 'whip pan', 'whoosh', { len: 0.45, from: 2400, to: 500, pan: 0.4 }],
  [56, 'PASS THE LIGHT', 'thud'],
  [64, 'punch-in', 'whoosh', { len: 0.3 }],
  [70, 'pass lands', 'pop', { pitch: 'A5' }],
  [72, 'match cut', 'click'],
  [74, 'chip R', 'blip', { pitch: 'D5' }],
  [75, 'chip G', 'blip', { pitch: 'F5' }],
  [76, 'chip B', 'blip', { pitch: 'A5' }],
  [89, 'light streak', 'whoosh', { len: 0.4, from: 900, to: 3000 }],
  [92, 'TWO HANDS', 'thud'],
  [96, 'lift', 'impact'],
  [110, 'COUNT TO TEN', 'sub', { len: 0.8 }],
  [112, 'COUNT TO TEN', 'click'],
  ...Array.from({ length: 10 }, (_, i) => [120 + i, `mark ${i + 1}`, 'tick']),
  [130, 'all ten lit', 'bell', { pitch: 'D6' }],
  [133, 'flash', 'swell', { len: 1 }],
  [134, 'A NEW BOARD EVERY DAY', 'tick'],
  [139, 'BUILD YOUR OWN', 'tick'],
  [143, 'collapse', 'whoosh', { len: 0.5, from: 3000, to: 400 }],
  [144, 'end card', 'impact'],
  [145, 'logo', 'bell', { pitch: 'D6' }],
];

// ---------------------------------------------------------------- frame cache
// The clips are JPEG sequences; seek() loads the frames a moment needs before painting it.
const cache = new Map();
const MAX_CACHE = 14;
function frameFor(id, t) {
  const s = SHOTS[id];
  const k = Math.round((t - TS(s.b0)) * FPS_CLIP) + 1;
  return clamp(k, 1, s.n);
}
const keyOf = (id, k) => `${id}/${String(k).padStart(4, '0')}`;
async function need(id, k) {
  const key = keyOf(id, k);
  if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return; }
  const blob = await fetch(`assets/clips/${key}.jpg`).then((r) => r.blob());
  const bmp = await createImageBitmap(blob);
  cache.set(key, bmp);
  while (cache.size > MAX_CACHE) {
    const [old, v] = cache.entries().next().value;
    v.close?.(); cache.delete(old);
  }
}
// Which shots are on screen at beat u (with transition margins).
function shotsAt(u) {
  return Object.entries(SHOTS).filter(([, s]) => u >= s.b0 - 1.2 && u < s.b1 + 1.2).map(([id]) => id);
}
const bmp = (id, t) => cache.get(keyOf(id, frameFor(id, t)));

// ---------------------------------------------------------------- shared pieces
// A gameplay shot: cover-fit, log-space push across the shot, gentle drift; punch-ins on beats.
function clip(ctx, id, u, t, extra = 1) {
  const s = SHOTS[id];
  const im = bmp(id, t);
  if (!im) return;
  const p = clamp((u - s.b0) / (s.b1 - s.b0), 0, 1);
  let z = s.zoom[0] * (s.zoom[1] / s.zoom[0]) ** p;
  for (const b of s.punch || []) z *= 1 + 0.05 * springU(u, b, SPRING.snappy) * Math.exp(-Math.max(0, u - b) * 0.25);
  cover(ctx, im, 0, 0, W, H, { fx: lerp(s.fx[0], s.fx[1], p), fy: lerp(s.fy[0], s.fy[1], p), zoom: z * extra });
}
// Night grade: a vignette and a dark lower-left scrim so type always has ground.
function grade(ctx, strength = 1) {
  const v = ctx.createRadialGradient(W * 0.55, H * 0.5, H * 0.35, W * 0.55, H * 0.5, H * 1.05);
  v.addColorStop(0, 'rgba(6,8,13,0)'); v.addColorStop(1, `rgba(6,8,13,${0.7 * strength})`);
  ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, H * 0.45, 0, H);
  g.addColorStop(0, 'rgba(6,8,13,0)'); g.addColorStop(1, `rgba(6,8,13,${0.78 * strength})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

// Kinetic label, lower-left: glyphs spring up through a baseline mask, then wipe out upward.
// parts: [[string, colour], ...] on one line.
function label(ctx, u, u0, u1, parts, { size = 92, x = 120, y = H - 150, num = null, stagger = 0.025 } = {}) {
  if (u < u0 - 0.05 || u > u1 + 0.6) return;
  const f = font(size, 700, DISPLAY), track = size * 0.04;
  const out = E.inCubic(prog(u, u1, u1 + 0.45));
  ctx.save();
  ctx.beginPath(); ctx.rect(0, y - size * 1.2 - 4, W, size * 1.2 + size * 0.28); ctx.clip();
  let cx = x, gi = 0;
  for (const [str, col] of parts) {
    const L = layout(ctx, str, f, track);
    for (const g of L.glyphs) {
      const k = springU(u, u0 + gi * stagger, SPRING.snappy);
      gi++;
      if (k <= 0) continue;
      const dy = (1 - k) * size * 1.1 - out * size * 1.3;
      glyph(ctx, g.ch, cx + g.cx, y + dy, f, col);
    }
    cx += L.width + track + size * 0.28;
  }
  ctx.restore();
  // index tick: a short accent bar and number above the line, a measured instrument
  if (num) {
    const k = E.outCubic(prog(u, u0 - 0.1, u0 + 0.5)) * (1 - out);
    ctx.fillStyle = C.accent; ctx.globalAlpha = k;
    ctx.fillRect(x, y - size * 1.12, 46 * k, 4);
    text(ctx, num, x + 60, y - size * 1.12 + 9, font(26, 600, UI), C.accent, 'left', 3);
    ctx.globalAlpha = 1;
  }
}
// Small secondary caption under a label.
function sub(ctx, u, u0, u1, str, { x = 120, y = H - 84 } = {}) {
  const a = E.outCubic(prog(u, u0, u0 + 0.6)) * (1 - E.inCubic(prog(u, u1, u1 + 0.4)));
  if (a <= 0) return;
  ctx.globalAlpha = a;
  text(ctx, str, x + (1 - a) * -24, y, font(42, 500, UI), C.dim, 'left', 1);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- 1 hook (b0-9)
function sHook(ctx, u, t) {
  clip(ctx, 'hook', u, t);
  grade(ctx);
  label(ctx, u, 4, 8.6, [['HOLD STILL', C.warm]], { size: 112, num: '01' });
  label(ctx, u, 7, 8.6, [['= GLASS', C.accent]], { size: 112, x: 120 + 720, stagger: 0.035 });
}

// ---------------------------------------------------------------- 2 pour (b9-16)
function sPour(ctx, u, t) {
  // ripple push: the shot rushes forward into the drop
  const rush = E.inExpo(prog(u, 14.6, 16));
  clip(ctx, 'pour', u, t, 1 + 0.5 * rush);
  grade(ctx);
  label(ctx, u, 12, 15.3, [['ANY ', C.warm], ['TABLE', C.accent]], { num: '02' });
  sub(ctx, u, 12.6, 15.3, 'The bench pours out of your palm, onto your real table.');
  // the pour ring grows into the title's ring
  if (u > 14.6) {
    const p = E.inCubic(prog(u, 14.6, 16));
    ctx.strokeStyle = C.accent; ctx.lineWidth = 3 + 10 * p; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(W * 0.5, H * 0.6, 40 + p * W * 0.7, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- 3 title (b16-24)
function sTitle(ctx, u, IMG) {
  fill(ctx, C.night);
  // cold glow pool behind the emblem
  const gl = ctx.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.4, H * 0.6);
  gl.addColorStop(0, 'rgba(143,208,255,0.16)'); gl.addColorStop(1, 'rgba(143,208,255,0)');
  ctx.fillStyle = gl; ctx.fillRect(0, 0, W, H);
  shake(ctx, u, 16, 16);
  const em = IMG.emblem;
  if (em) {
    // lands on the downbeat already big: scale settles 1.25 -> 1
    const k = springU(u, 16, SPRING.bouncy);
    const sz = 430 * (1.25 - 0.25 * k);
    ctx.drawImage(em, W / 2 - sz / 2, H * 0.4 - sz / 2, sz, sz);
    // ring burst out of the emblem
    const r = E.outCubic(prog(u, 16, 17.2));
    if (r < 1) {
      ctx.strokeStyle = C.accent; ctx.globalAlpha = 1 - r; ctx.lineWidth = 10 * (1 - r) + 1;
      ctx.beginPath(); ctx.arc(W / 2, H * 0.4, 200 + r * 520, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
    }
  }
  // wordmark
  const size = 150, f = font(size, 700, DISPLAY), track = size * 0.12;
  const L = layout(ctx, 'HANDCAST', f, track);
  const x0 = W / 2 - L.width / 2, base = H * 0.4 + 330;
  ctx.save(); ctx.beginPath(); ctx.rect(0, base - size, W, size * 1.12); ctx.clip();
  L.glyphs.forEach((g, j) => {
    const k = springU(u, 15.9 + j * 0.05, SPRING.snappy);
    if (k <= 0) return;
    glyph(ctx, g.ch, x0 + g.cx, base + (1 - k) * size, f, C.warm);
  });
  ctx.restore();
  // tagline, word by word
  const words = [['YOUR', 20], ['HAND', 20.5], ['IS THE', 21], ['PUZZLE PIECE', 21.5]];
  const tf = font(40, 600, UI), tt = 10;
  const widths = words.map(([w]) => layout(ctx, w, tf, tt).width);
  const gap = 26, total = widths.reduce((a, b) => a + b, 0) + gap * (words.length - 1);
  let x = W / 2 - total / 2;
  words.forEach(([w, b], i) => {
    const k = springU(u, b, SPRING.bouncy);
    if (k > 0) {
      ctx.globalAlpha = clamp(k, 0, 1);
      text(ctx, w, x, base + 92 + (1 - k) * 24, tf, i === 3 ? C.accent : C.warm, 'left', tt);
      ctx.globalAlpha = 1;
    }
    x += widths[i] + gap;
  });
}

// ---------------------------------------------------------------- 4 point / freeze / knock (b24-38)
function sPoint(ctx, u, t) {
  ctx.save();
  shake(ctx, u, 35, 26, 5, 0.18);
  clip(ctx, 'point', u, t);
  ctx.restore();
  grade(ctx);
  label(ctx, u, 24, 29.5, [['POINT', C.warm]], { num: '03' });
  sub(ctx, u, 24.6, 29.5, 'Every open finger is a port of light.');
  label(ctx, u, 30, 34.6, [['FREEZE', C.accent]], { num: '04' });
  sub(ctx, u, 30.6, 34.6, 'Hold the pose and it sets as glass.');
  label(ctx, u, 35, 37.4, [['KNOCK', C.warm]], { num: '05' });
  sub(ctx, u, 35.5, 37.4, 'A fist breaks it. The glass comes back.');
}

// ---------------------------------------------------------------- 5 mirror (b38-53)
function sMirror(ctx, u, t) {
  clip(ctx, 'mirror', u, t);
  grade(ctx);
  label(ctx, u, 40, 51.6, [['ON ITS EDGE:', C.warm], ['A MIRROR', C.accent]], { num: '06' });
  sub(ctx, u, 40.8, 51.6, 'Each pose bends the beam a different way.');
}

// ---------------------------------------------------------------- 6 relay (b53-72)
function sRelay(ctx, u, t) {
  clip(ctx, 'relay', u, t);
  grade(ctx);
  label(ctx, u, 56, 70.6, [['GLASS HANDS', C.warm], ['PASS THE LIGHT', C.accent]], { size: 84, num: '07' });
  sub(ctx, u, 57, 70.6, 'Freeze one pose, then the next: the light runs through both.');
}

// ---------------------------------------------------------------- 7 colour (b72-89)
const CHIPS = [['#ff6b6b', 74], ['#6be38a', 75], ['#6aa8ff', 76]];
function sColour(ctx, u, t) {
  ctx.save();
  if (u < 73) M.zoomAbout(ctx, 1 + 0.04 * Math.exp(-(u - 72) * 3), W / 2, H / 2);
  clip(ctx, 'colour', u, t);
  ctx.restore();
  grade(ctx);
  label(ctx, u, 76, 87.6, [['EVERY CRYSTAL,', C.warm], ['ITS OWN COLOUR', C.accent]], { size: 80, num: '08' });
  // R G B chips tick in above the label
  const out = E.inCubic(prog(u, 87.6, 88.1));
  CHIPS.forEach(([col, b], i) => {
    const k = springU(u, b, SPRING.bouncy) * (1 - out);
    if (k <= 0) return;
    const cx = 120 + 30 + i * 74, cy = H - 290;
    ctx.save(); ctx.translate(cx, cy); ctx.scale(k, k);
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  });
}

// ---------------------------------------------------------------- 8 two hands (b89-110)
function sTwo(ctx, u, t) {
  ctx.save();
  shake(ctx, u, 96, 10);
  clip(ctx, 'two', u, t);
  ctx.restore();
  grade(ctx);
  label(ctx, u, 92, 108.6, [['TWO HANDS.', C.warm], ['ONE BEAM.', C.accent]], { num: '09' });
  sub(ctx, u, 97, 108.6, 'Freeze both hands, and they work as one piece.');
}

// ---------------------------------------------------------------- 9 count to ten (b110-134)
function sTen(ctx, u, t) {
  clip(ctx, 'ten', u, t);
  grade(ctx);
  label(ctx, u, 112, 132.6, [['COUNT TO TEN', C.warm]], { size: 104, num: '10' });
  // ten marks fill along the bottom, one per beat, b120-129
  const out = E.inCubic(prog(u, 132.6, 133.2));
  const x0 = 120, y = H - 70, w = 64, gap = 14;
  for (let i = 0; i < 10; i++) {
    const appear = E.outCubic(prog(u, 112.5 + i * 0.08, 113.3 + i * 0.08)) * (1 - out);
    if (appear <= 0) continue;
    const lit = springU(u, 120 + i, SPRING.snappy);
    ctx.globalAlpha = appear;
    ctx.fillStyle = 'rgba(244,239,230,0.25)';
    ctx.fillRect(x0 + i * (w + gap), y, w, 8);
    if (lit > 0) {
      ctx.fillStyle = C.accent;
      ctx.fillRect(x0 + i * (w + gap), y - 4 * lit, w * clamp(lit, 0, 1), 8 + 4 * lit);
    }
    ctx.globalAlpha = 1;
  }
  if (u > 120) {
    const n = clamp(Math.floor(u - 120) + 1, 1, 10);
    ctx.globalAlpha = (1 - out);
    text(ctx, `${n} / 10`, x0 + 10 * (w + gap) + 14, y + 12, font(34, 600, UI), n === 10 ? C.accent : C.dim, 'left', 2);
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- 10 daily (b134-144)
function sDaily(ctx, u, t) {
  clip(ctx, 'daily', u, t);
  grade(ctx);
  label(ctx, u, 134, 138.6, [['A NEW BOARD', C.warm], ['EVERY DAY', C.accent]], { num: '11' });
  label(ctx, u, 139, 142.8, [['BUILD YOUR OWN', C.warm], ['IN THE STUDIO', C.accent]], { size: 84, num: '12' });
}

// ---------------------------------------------------------------- 11 end card (b144-160)
function sEnd(ctx, u, IMG) {
  fill(ctx, C.night);
  const gl = ctx.createRadialGradient(W / 2, H * 0.34, 0, W / 2, H * 0.34, H * 0.55);
  gl.addColorStop(0, 'rgba(143,208,255,0.13)'); gl.addColorStop(1, 'rgba(143,208,255,0)');
  ctx.fillStyle = gl; ctx.fillRect(0, 0, W, H);
  const em = IMG.emblem;
  const k = springU(u, 144, SPRING.gentle);
  if (em) {
    const sz = 300 * (1.2 - 0.2 * k);
    ctx.drawImage(em, W / 2 - sz / 2, H * 0.3 - sz / 2, sz, sz);
    ctx.globalAlpha = 1;
  }
  const size = 112, f = font(size, 700, DISPLAY), track = size * 0.12;
  const L = layout(ctx, 'HANDCAST', f, track);
  const x0 = W / 2 - L.width / 2, base = H * 0.3 + 250;
  L.glyphs.forEach((g, j) => {
    const q = springU(u, 143.9 + j * 0.04, SPRING.snappy);
    if (q <= 0) return;
    ctx.globalAlpha = clamp(q, 0, 1);
    glyph(ctx, g.ch, x0 + g.cx, base + (1 - q) * 40, f, C.warm);
  });
  ctx.globalAlpha = 1;
  const a1 = E.outCubic(prog(u, 146, 147));
  ctx.globalAlpha = a1;
  text(ctx, 'PLAY IN META QUEST BROWSER', W / 2, base + 96 + (1 - a1) * 16, font(44, 600, UI), C.accent, 'center', 8);
  const a2 = E.outCubic(prog(u, 147, 148));
  ctx.globalAlpha = a2;
  text(ctx, 'mghprojects.github.io/Devpost', W / 2, base + 160 + (1 - a2) * 16, font(40, 500, UI), C.warm, 'center', 1);
  const a3 = E.outCubic(prog(u, 149, 150.5));
  ctx.globalAlpha = a3 * 0.7;
  text(ctx, 'Real gameplay, captured on Meta Quest 3. Hands only.', W / 2, H - 70, font(28, 500, UI), C.warm, 'center', 1);
  // fade to night at the very end
  ctx.globalAlpha = E.inCubic(prog(u, 158.6, 160));
  fill(ctx, C.night);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- the edit
function draw(ctx, u, t, IMG) {
  fill(ctx, C.night);

  // 1 -> 2: circular reveal of the pour from the frozen hand (b8.3-9)
  if (u < 9) {
    sHook(ctx, u, t);
    if (u > 8.3) {
      const p = E.inCubic(prog(u, 8.3, 9));
      const r = 30 + p * W * 0.75;
      ctx.save(); ctx.beginPath(); ctx.arc(W * 0.62, H * 0.58, r, 0, Math.PI * 2); ctx.clip();
      sPour(ctx, u, t); ctx.restore();
      ctx.strokeStyle = C.warm; ctx.lineWidth = 6; ctx.globalAlpha = 1 - p * 0.5;
      ctx.beginPath(); ctx.arc(W * 0.62, H * 0.58, r, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
    }
    return;
  }
  if (u < 16) return sPour(ctx, u, t);

  // 3 -> 4: a beam line sweeps across, the shot rides in behind it (b23.2-24)
  if (u < 24) {
    sTitle(ctx, u, IMG);
    if (u > 23.2) beamSweep(ctx, u, 23.2, 24, () => sPoint(ctx, u, t));
    return;
  }
  // 4 -> 5: punch cut on the beat after the game's own shatter (b38)
  if (u < 38) return sPoint(ctx, u, t);
  if (u < 39) {
    // the game's own shatter has just played: cut on the beat with a settling punch
    ctx.save(); M.zoomAbout(ctx, 1 + 0.06 * Math.exp(-(u - 38) * 4), W * 0.5, H * 0.55);
    sMirror(ctx, u, t); ctx.restore();
    return;
  }
  // 5 -> 6: whip pan, both shots on screen (b52.6-53.4)
  if (u < 52.6) return sMirror(ctx, u, t);
  if (u < 53.4) {
    const p = E.inOutCubic(prog(u, 52.6, 53.4));
    ctx.save(); ctx.translate(-p * W, 0); sMirror(ctx, u, t); ctx.restore();
    ctx.save(); ctx.translate((1 - p) * W, 0); sRelay(ctx, u, t); ctx.restore();
    return;
  }
  // 6 -> 7: match cut on the beam (b72)
  if (u < 72) return sRelay(ctx, u, t);
  // 7 -> 8: light streak wipe (b88.4-89.2)
  if (u < 88.4) return sColour(ctx, u, t);
  if (u < 89.2) {
    sColour(ctx, u, t);
    beamSweep(ctx, u, 88.4, 89.2, () => sTwo(ctx, u, t), -0.35);
    return;
  }
  if (u < 110) return sTwo(ctx, u, t);
  // 9 -> 10: flash to white (structural moment)
  if (u < 134) {
    sTen(ctx, u, t);
    ctx.fillStyle = C.warm; ctx.globalAlpha = E.inCubic(prog(u, 132.9, 134)) * 0.95; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    return;
  }
  if (u < 143) {
    sDaily(ctx, u, t);
    ctx.fillStyle = C.warm; ctx.globalAlpha = 0.5 * Math.exp(-(u - 134) * 2.6); ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    return;
  }
  // 10 -> 11: the shot closes to a line, then a point (b143-144)
  if (u < 144) {
    const p = prog(u, 143, 144);
    const sy = Math.max(0.004, 1 - E.inExpo(Math.min(1, p * 1.6)));
    const sx = p < 0.62 ? 1 : 1 - E.inCubic((p - 0.62) / 0.38);
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(Math.max(sx, 0.002), sy); ctx.translate(-W / 2, -H / 2);
    sDaily(ctx, u, t); ctx.restore();
    if (sy < 0.05) {
      ctx.fillStyle = C.accent; const lw = W * Math.max(sx, 0.003);
      ctx.fillRect(W / 2 - lw / 2, H / 2 - 2, lw, 4);
    }
    return;
  }
  sEnd(ctx, u, IMG);
}

// A bright beam line crosses the frame (angle = slope); the next shot is revealed behind it.
function beamSweep(ctx, u, a, b, drawNext, slope = 0.18) {
  const p = E.inOutCubic(prog(u, a, b));
  const x = lerp(-W * 0.25, W * 1.25, p);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x - slope * H, 0); ctx.lineTo(-W, 0); ctx.lineTo(-W, H); ctx.lineTo(x, H); ctx.closePath();
  ctx.clip(); drawNext(); ctx.restore();
  const g = ctx.createLinearGradient(x - 90, 0, x + 30, 0);
  g.addColorStop(0, 'rgba(143,208,255,0)'); g.addColorStop(0.8, 'rgba(143,208,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0.95)');
  ctx.save(); ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(x - slope * H - 90, 0); ctx.lineTo(x - slope * H + 6, 0); ctx.lineTo(x + 6, H); ctx.lineTo(x - 90, H); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------- grain (post, after blur)
let grain = null;
function makeGrain() {
  grain = document.createElement('canvas'); grain.width = 512; grain.height = 512;
  const g = grain.getContext('2d'); const im = g.createImageData(512, 512);
  const rnd = M.mulberry32(1234);
  for (let i = 0; i < im.data.length; i += 4) { const v = rnd() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
  g.putImageData(im, 0, 0);
}
function post(ctx, u, t) {
  if (!grain) makeGrain();
  const f = Math.floor(t * 24);
  ctx.save(); ctx.globalAlpha = 0.045; ctx.globalCompositeOperation = 'overlay';
  ctx.translate(-Math.floor(hash01(f, 2) * 512), -Math.floor(hash01(f, 5) * 512));
  ctx.fillStyle = ctx.createPattern(grain, 'repeat'); ctx.fillRect(0, 0, W + 512, H + 512);
  ctx.restore();
}

await M.film({
  fonts: [`700 80px ${DISPLAY}`, `600 80px ${DISPLAY}`, `500 30px ${UI}`, `600 30px ${UI}`],
  images: { emblem: 'assets/emblem.png' },
  hits: HITS,
  draw, post,
  samples: 6,
});

// Wrap seek: fetch the clip frames this moment (and its blur sub-samples) needs, then paint.
window.filmReady = false;
const paint = window.seek;
const params = new URLSearchParams(location.search);
const fps = Number(params.get('fps') || 60);
window.seek = async (t) => {
  const t0 = t + 0.5 / fps, t1 = t0 + 0.5 / fps;
  const u0 = U(t0);
  const jobs = [];
  for (const id of shotsAt(u0)) for (const tt of [t0, t1]) jobs.push(need(id, frameFor(id, tt)));
  await Promise.all(jobs);
  paint(t);
};
await window.seek(0);
window.filmReady = true;
