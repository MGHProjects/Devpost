import React from 'react';
import { AbsoluteFill, Img, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from 'remotion';
import {
  B, BOUNCY, F, FPS, GENTLE, H, PAD_S, SNAPPY, W, clamp, ease, lerp, prog, shake, shot, springB,
} from './timing';

// "Held Light": warm-white type on night-dark scrims, one accent (beam blue).
const C = { night: '#06080d', warm: '#f4efe6', dim: 'rgba(244,239,230,0.74)', accent: '#8fd0ff' };
const DISPLAY = 'InterDisplay';
const UI = 'InterUI';

// ---------------------------------------------------------------- footage

/** One real capture shot, frame-locked so its source time at beat b0 is shot.src. */
const Clip: React.FC<{ id: string; u: number; zoom?: [number, number]; focus?: [number, number]; extra?: number; punch?: number[] }> = ({
  id, u, zoom = [1.02, 1.08], focus = [0.5, 0.6], extra = 1, punch = [],
}) => {
  const s = shot(id);
  const p = clamp((u - s.b0) / (s.b1 - s.b0));
  // log-space push: a constant-rate dolly
  let z = zoom[0] * (zoom[1] / zoom[0]) ** p * extra;
  for (const b of punch) z *= 1 + 0.05 * springB(u, b, ...SNAPPY) * Math.exp(-Math.max(0, u - b) * 0.25);
  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: C.night }}>
      <Sequence from={F(s.b0) - PAD_S * FPS} layout="none">
        <OffthreadVideo
          src={staticFile(`clips/${id}.mp4`)}
          muted
          style={{
            position: 'absolute', inset: 0, width: W, height: H,
            transform: `scale(${z})`, transformOrigin: `${focus[0] * 100}% ${focus[1] * 100}%`,
            filter: 'contrast(1.08) saturate(1.1) brightness(1.02)',
          }}
        />
      </Sequence>
    </AbsoluteFill>
  );
};

/** Vignette plus a lower-left scrim so type always has dark ground on the bright wood. */
const Grade: React.FC<{ strength?: number }> = ({ strength = 1 }) => (
  <AbsoluteFill style={{ pointerEvents: 'none' }}>
    <AbsoluteFill style={{ background: `radial-gradient(ellipse 75% 70% at 55% 48%, rgba(6,8,13,0) 60%, rgba(6,8,13,${0.42 * strength}) 100%)` }} />
    <AbsoluteFill style={{ background: `linear-gradient(180deg, rgba(6,8,13,0) 58%, rgba(6,8,13,${0.5 * strength}) 80%, rgba(6,8,13,${0.82 * strength}) 100%)` }} />
    <AbsoluteFill style={{ background: `linear-gradient(90deg, rgba(6,8,13,${0.3 * strength}) 0%, rgba(6,8,13,0) 40%)` }} />
  </AbsoluteFill>
);

// ---------------------------------------------------------------- type

type Part = [string, string];
/** Kinetic label, lower-left: glyphs spring up through a baseline mask, then leave upward. */
const Label: React.FC<{ u: number; u0: number; u1: number; parts: Part[]; size?: number; num?: string; x?: number; y?: number; stagger?: number }> = ({
  u, u0, u1, parts, size = 96, num, x = 120, y = H - 158, stagger = 0.022,
}) => {
  if (u < u0 - 0.05 || u > u1 + 0.6) return null;
  const out = ease.inCubic(prog(u, u1, u1 + 0.45));
  let gi = 0;
  const tick = ease.outCubic(prog(u, u0 - 0.1, u0 + 0.5)) * (1 - out);
  return (
    <>
      {num && (
        <div style={{ position: 'absolute', left: 120, top: y - size * 1.2, display: 'flex', alignItems: 'center', gap: 14, opacity: tick }}>
          <div style={{ width: 46 * tick, height: 4, background: C.accent }} />
          <div style={{ font: `600 26px ${UI}`, letterSpacing: 3, color: C.accent }}>{num}</div>
        </div>
      )}
      <div style={{
        position: 'absolute', left: x, top: y - size * 0.98, height: size * 1.22, overflow: 'hidden',
        display: 'flex', gap: size * 0.3, whiteSpace: 'pre',
      }}>
        {parts.map(([str, col], pi) => (
          <div key={pi} style={{ display: 'flex' }}>
            {[...str].map((ch, j) => {
              const k = springB(u, u0 + gi++ * stagger, ...SNAPPY);
              const dy = (1 - k) * size * 1.1 - out * size * 1.3;
              return (
                <span key={j} style={{
                  display: 'inline-block', transform: `translateY(${dy}px)`,
                  font: `700 ${size}px ${DISPLAY}`, letterSpacing: size * 0.035, color: col, lineHeight: 1.1,
                  textShadow: '0 2px 24px rgba(0,0,0,0.35)',
                }}>{ch}</span>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
};

/** Secondary caption under a label. */
const Sub: React.FC<{ u: number; u0: number; u1: number; text: string; y?: number }> = ({ u, u0, u1, text, y = H - 118 }) => {
  const a = ease.outCubic(prog(u, u0, u0 + 0.6)) * (1 - ease.inCubic(prog(u, u1, u1 + 0.4)));
  if (a <= 0) return null;
  return (
    <div style={{
      position: 'absolute', left: 120 - (1 - a) * 24, top: y, opacity: a,
      font: `500 40px ${UI}`, letterSpacing: 0.5, color: C.dim, textShadow: '0 1px 12px rgba(0,0,0,0.5)',
    }}>{text}</div>
  );
};

// ---------------------------------------------------------------- scenes

const Hook: React.FC<{ u: number }> = ({ u }) => (
  <AbsoluteFill>
    <Clip id="hook" u={u} zoom={[1.0, 1.08]} focus={[0.55, 0.7]} />
    <Grade />
    <Label u={u} u0={4} u1={8.6} parts={[['HOLD STILL', C.warm]]} size={118} num="01" />
    <Label u={u} u0={7} u1={8.6} parts={[['= GLASS', C.accent]]} size={118} stagger={0.035} x={890} />
  </AbsoluteFill>
);

const Table: React.FC<{ u: number }> = ({ u }) => {
  const rush = ease.inExpo(prog(u, 14.6, 16));
  const ring = ease.inCubic(prog(u, 14.6, 16));
  return (
    <AbsoluteFill>
      <Clip id="table" u={u} zoom={[1.04, 1.14]} focus={[0.5, 0.75]} extra={1 + 0.5 * rush} />
      <Grade />
      <Label u={u} u0={12} u1={15.3} parts={[['ANY', C.warm], ['TABLE', C.accent]]} num="02" />
      <Sub u={u} u0={12.6} u1={15.3} text="Rest a hand flat: the bench pours out onto your real table." />
      {u > 14.6 && (
        <svg width={W} height={H} style={{ position: 'absolute', inset: 0 }}>
          <circle cx={W / 2} cy={H * 0.62} r={40 + ring * W * 0.7} fill="none" stroke={C.accent} strokeWidth={3 + 10 * ring} opacity={0.9} />
        </svg>
      )}
    </AbsoluteFill>
  );
};

const Title: React.FC<{ u: number }> = ({ u }) => {
  const [sx, sy] = shake(u, 16, 16);
  const k = springB(u, 16, ...BOUNCY);
  const sz = 430 * (1.25 - 0.25 * k);
  const r = ease.outCubic(prog(u, 16, 17.2));
  const words: [string, number][] = [['YOUR', 20], ['HAND', 20.5], ['IS THE', 21], ['PUZZLE PIECE', 21.5]];
  const word = 'HANDCAST';
  return (
    <AbsoluteFill style={{ backgroundColor: C.night }}>
      <AbsoluteFill style={{ background: 'radial-gradient(circle at 50% 40%, rgba(143,208,255,0.17) 0%, rgba(143,208,255,0) 34%)' }} />
      <AbsoluteFill style={{ transform: `translate(${sx}px, ${sy}px)` }}>
        <Img src={staticFile('emblem.png')} style={{ position: 'absolute', left: W / 2 - sz / 2, top: H * 0.4 - sz / 2, width: sz, height: sz }} />
        {r < 1 && (
          <svg width={W} height={H} style={{ position: 'absolute', inset: 0 }}>
            <circle cx={W / 2} cy={H * 0.4} r={200 + r * 520} fill="none" stroke={C.accent} strokeWidth={10 * (1 - r) + 1} opacity={1 - r} />
          </svg>
        )}
        <div style={{ position: 'absolute', top: H * 0.4 + 200, left: 0, width: W, boxSizing: 'border-box', height: 170, overflow: 'hidden', display: 'flex', justifyContent: 'center', paddingLeft: 18 }}>
          {[...word].map((ch, j) => {
            const q = springB(u, 15.9 + j * 0.05, ...SNAPPY);
            return (
              <span key={j} style={{
                display: 'inline-block', transform: `translateY(${(1 - q) * 160}px)`,
                font: `700 150px ${DISPLAY}`, letterSpacing: 18, color: C.warm, lineHeight: 1.1,
              }}>{ch}</span>
            );
          })}
        </div>
        <div style={{ position: 'absolute', top: H * 0.4 + 392, width: W, display: 'flex', justifyContent: 'center', gap: 26 }}>
          {words.map(([w, b], i) => {
            const q = springB(u, b, ...BOUNCY);
            return (
              <span key={i} style={{
                opacity: clamp(q), transform: `translateY(${(1 - q) * 24}px)`,
                font: `600 40px ${UI}`, letterSpacing: 10, color: i === 3 ? C.accent : C.warm,
              }}>{w}</span>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Point: React.FC<{ u: number }> = ({ u }) => {
  const [sx, sy] = shake(u, 36, 26, 0.18);
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transform: `translate(${sx}px, ${sy}px)` }}>
        <Clip id="point" u={u} zoom={[1.08, 1.16]} focus={[0.5, 0.72]} />
      </AbsoluteFill>
      <Grade />
      <Label u={u} u0={24} u1={30.5} parts={[['POINT', C.warm]]} num="03" />
      <Sub u={u} u0={24.6} u1={30.5} text="Light enters through an open fingertip." />
      <Label u={u} u0={31} u1={35.6} parts={[['FREEZE', C.accent]]} num="04" />
      <Sub u={u} u0={31.6} u1={35.6} text="Hold the pose and it sets as glass." />
      <Label u={u} u0={36} u1={37.5} parts={[['KNOCK', C.warm]]} num="05" />
      <Sub u={u} u0={36.4} u1={37.5} text="A fist breaks it. The glass comes back." />
    </AbsoluteFill>
  );
};

const Mirror: React.FC<{ u: number }> = ({ u }) => (
  <AbsoluteFill>
    <Clip id="mirror" u={u} zoom={[1.06, 1.12]} focus={[0.45, 0.72]} />
    <Grade />
    <Label u={u} u0={40} u1={51.6} parts={[['ON ITS EDGE:', C.warm], ['A MIRROR', C.accent]]} num="06" />
    <Sub u={u} u0={40.8} u1={51.6} text="Stand your hand on its edge and the beam bends." />
  </AbsoluteFill>
);

const Pass: React.FC<{ u: number }> = ({ u }) => (
  <AbsoluteFill>
    <Clip id="pass" u={u} zoom={[1.04, 1.1]} focus={[0.45, 0.72]} punch={[56, 64]} />
    <Grade />
    <Label u={u} u0={56} u1={70.6} parts={[['GLASS HANDS', C.warm], ['PASS THE LIGHT', C.accent]]} size={86} num="07" />
    <Sub u={u} u0={57} u1={70.6} text="Freeze one pose, then the next: the light runs through both." />
  </AbsoluteFill>
);

const CHIPS: [string, number][] = [['#ff6b6b', 74], ['#6be38a', 75], ['#6aa8ff', 76]];
const Colour: React.FC<{ u: number }> = ({ u }) => {
  const punch = u < 73 ? 1 + 0.04 * Math.exp(-(u - 72) * 3) : 1;
  const out = ease.inCubic(prog(u, 87.6, 88.1));
  return (
    <AbsoluteFill>
      <Clip id="colour" u={u} zoom={[1.04, 1.1]} focus={[0.55, 0.72]} extra={punch} />
      <Grade />
      {CHIPS.map(([col, b], i) => {
        const k = springB(u, b, ...BOUNCY) * (1 - out);
        return k > 0 ? (
          <div key={i} style={{
            position: 'absolute', left: 126 + i * 74, top: H - 316, width: 48, height: 48, borderRadius: 24,
            background: col, transform: `scale(${k})`, boxShadow: `0 0 24px ${col}88`,
          }} />
        ) : null;
      })}
      <Label u={u} u0={76} u1={87.6} parts={[['EVERY CRYSTAL,', C.warm], ['ITS OWN COLOUR', C.accent]]} size={84} />
      <Sub u={u} u0={77} u1={87.6} text="Pools tint the light. Mix them on the way to each crystal." />
    </AbsoluteFill>
  );
};

const Two: React.FC<{ u: number }> = ({ u }) => {
  const [sx, sy] = shake(u, 96, 10);
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transform: `translate(${sx}px, ${sy}px)` }}>
        <Clip id="two" u={u} zoom={[1.02, 1.12]} focus={[0.45, 0.72]} />
      </AbsoluteFill>
      <Grade />
      <Label u={u} u0={103} u1={108.6} parts={[['TWO HANDS.', C.warm], ['ONE BEAM.', C.accent]]} num="08" />
      <Sub u={u} u0={103.8} u1={108.6} text="Freeze both hands and they work as one piece." />
    </AbsoluteFill>
  );
};

const Ten: React.FC<{ u: number }> = ({ u }) => {
  const out = ease.inCubic(prog(u, 132.6, 133.2));
  const n = clamp(Math.floor(u - 120) + 1, 1, 10);
  return (
    <AbsoluteFill>
      <Clip id="ten" u={u} zoom={[1.04, 1.1]} focus={[0.5, 0.7]} />
      <Grade />
      <Label u={u} u0={112} u1={132.6} parts={[['COUNT TO TEN', C.warm]]} size={108} num="09" />
      {Array.from({ length: 10 }, (_, i) => {
        const appear = ease.outCubic(prog(u, 112.5 + i * 0.08, 113.3 + i * 0.08)) * (1 - out);
        const lit = springB(u, 120 + i, ...SNAPPY);
        return appear > 0 ? (
          <div key={i} style={{ position: 'absolute', left: 120 + i * 78, top: H - 96, width: 64, height: 8, opacity: appear, background: 'rgba(244,239,230,0.28)' }}>
            {lit > 0 && <div style={{ position: 'absolute', left: 0, top: -4 * lit, width: 64 * clamp(lit), height: 8 + 4 * lit, background: C.accent, boxShadow: `0 0 16px ${C.accent}` }} />}
          </div>
        ) : null;
      })}
      {u > 120 && (
        <div style={{ position: 'absolute', left: 120 + 10 * 78 + 14, top: H - 112, opacity: 1 - out, font: `600 36px ${UI}`, letterSpacing: 2, color: n === 10 ? C.accent : C.dim }}>
          {n} / 10
        </div>
      )}
    </AbsoluteFill>
  );
};

const Glance: React.FC<{ u: number }> = ({ u }) => (
  <AbsoluteFill>
    <Clip id="glance" u={u} zoom={[1.06, 1.14]} focus={[0.45, 0.7]} />
    <Grade />
    <Label u={u} u0={134} u1={138.6} parts={[['49 BOARDS.', C.warm], ['SEVEN CHAPTERS.', C.accent]]} size={86} num="10" />
  </AbsoluteFill>
);

const Menu: React.FC<{ u: number }> = ({ u }) => (
  <AbsoluteFill>
    <Clip id="menu" u={u} zoom={[1.04, 1.1]} focus={[0.4, 0.45]} />
    <Grade />
    <Label u={u} u0={139} u1={142.8} parts={[['A NEW BOARD', C.warm], ['EVERY DAY', C.accent]]} size={86} num="11" />
    <Sub u={u} u0={139.6} u1={142.8} text="And a Studio to build and share your own." />
  </AbsoluteFill>
);

const End: React.FC<{ u: number }> = ({ u }) => {
  const k = springB(u, 144, ...GENTLE);
  const sz = 300 * (1.2 - 0.2 * k);
  const a1 = ease.outCubic(prog(u, 146, 147));
  const a2 = ease.outCubic(prog(u, 147, 148));
  const a3 = ease.outCubic(prog(u, 149, 150.5));
  const fade = ease.inCubic(prog(u, 158.6, 160));
  return (
    <AbsoluteFill style={{ backgroundColor: C.night }}>
      <AbsoluteFill style={{ background: 'radial-gradient(circle at 50% 30%, rgba(143,208,255,0.14) 0%, rgba(143,208,255,0) 30%)' }} />
      <Img src={staticFile('emblem.png')} style={{ position: 'absolute', left: W / 2 - sz / 2, top: H * 0.3 - sz / 2, width: sz, height: sz }} />
      <div style={{ position: 'absolute', top: H * 0.3 + 160, width: W, display: 'flex', justifyContent: 'center', paddingLeft: 13, boxSizing: 'border-box' }}>
        {[...'HANDCAST'].map((ch, j) => {
          const q = springB(u, 143.9 + j * 0.04, ...SNAPPY);
          return (
            <span key={j} style={{ display: 'inline-block', opacity: clamp(q), transform: `translateY(${(1 - q) * 40}px)`, font: `700 112px ${DISPLAY}`, letterSpacing: 13, color: C.warm }}>{ch}</span>
          );
        })}
      </div>
      <div style={{ position: 'absolute', top: H * 0.3 + 318 + (1 - a1) * 16, width: W, textAlign: 'center', opacity: a1, font: `600 44px ${UI}`, letterSpacing: 8, color: C.accent }}>
        PLAY IN META QUEST BROWSER
      </div>
      <div style={{ position: 'absolute', top: H * 0.3 + 386 + (1 - a2) * 16, width: W, textAlign: 'center', opacity: a2, font: `500 42px ${UI}`, color: C.warm }}>
        mghprojects.github.io/Devpost
      </div>
      <div style={{ position: 'absolute', top: H - 98, width: W, textAlign: 'center', opacity: a3 * 0.72, font: `500 28px ${UI}`, color: C.warm }}>
        Real gameplay, captured on Meta Quest 3. Hands only.
      </div>
      <AbsoluteFill style={{ backgroundColor: C.night, opacity: fade }} />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- transitions

/** A bright beam line crosses the frame; the next shot is revealed behind it. */
const BeamSweep: React.FC<{ u: number; a: number; b: number; slope?: number; children: React.ReactNode }> = ({ u, a, b, slope = 0.18, children }) => {
  const p = ease.inOutCubic(prog(u, a, b));
  const x = lerp(-W * 0.25, W * 1.25, p);
  const top = x - slope * H;
  return (
    <>
      <AbsoluteFill style={{ clipPath: `polygon(-10px 0, ${top}px 0, ${x}px ${H}px, -10px ${H}px)` }}>{children}</AbsoluteFill>
      <AbsoluteFill style={{
        clipPath: `polygon(${top - 110}px 0, ${top + 6}px 0, ${x + 6}px ${H}px, ${x - 110}px ${H}px)`,
        background: `linear-gradient(90deg, rgba(143,208,255,0) ${x - 120}px, rgba(143,208,255,0.55) ${x - 20}px, rgba(255,255,255,0.95) ${x + 6}px)`,
      }} />
    </>
  );
};

// ---------------------------------------------------------------- the edit

export const Trailer: React.FC = () => {
  const frame = useCurrentFrame();
  // sample half a frame late so the frame nearest a beat is the first frame of that beat's hit
  const u = B(frame + 0.5);
  const layers: React.ReactNode[] = [];

  if (u < 9) {
    layers.push(<Hook key="hook" u={u} />);
    if (u > 8.3) {
      const p = ease.inCubic(prog(u, 8.3, 9));
      const r = 30 + p * W * 0.75;
      layers.push(
        <AbsoluteFill key="reveal" style={{ clipPath: `circle(${r}px at ${W * 0.55}px ${H * 0.62}px)` }}><Table u={u} /></AbsoluteFill>,
        <svg key="ring" width={W} height={H} style={{ position: 'absolute', inset: 0 }}>
          <circle cx={W * 0.55} cy={H * 0.62} r={r} fill="none" stroke={C.warm} strokeWidth={6} opacity={1 - p * 0.5} />
        </svg>,
      );
    }
  } else if (u < 16) {
    layers.push(<Table key="table" u={u} />);
  } else if (u < 24) {
    layers.push(<Title key="title" u={u} />);
    if (u > 23.2) layers.push(<BeamSweep key="sweep" u={u} a={23.2} b={24}><Point u={u} /></BeamSweep>);
  } else if (u < 38) {
    layers.push(<Point key="point" u={u} />);
  } else if (u < 52.6) {
    const z = u < 39 ? 1 + 0.06 * Math.exp(-(u - 38) * 4) : 1;
    layers.push(<AbsoluteFill key="mirror" style={{ transform: `scale(${z})` }}><Mirror u={u} /></AbsoluteFill>);
  } else if (u < 53.4) {
    const p = ease.inOutCubic(prog(u, 52.6, 53.4));
    const blur = Math.sin(Math.PI * p) * 14;
    layers.push(
      <AbsoluteFill key="m" style={{ transform: `translateX(${-p * W}px)`, filter: `blur(${blur}px)` }}><Mirror u={u} /></AbsoluteFill>,
      <AbsoluteFill key="p" style={{ transform: `translateX(${(1 - p) * W}px)`, filter: `blur(${blur}px)` }}><Pass u={u} /></AbsoluteFill>,
    );
  } else if (u < 72) {
    layers.push(<Pass key="pass" u={u} />);
  } else if (u < 88.4) {
    layers.push(<Colour key="colour" u={u} />);
  } else if (u < 89.2) {
    layers.push(<Colour key="colour" u={u} />, <BeamSweep key="streak" u={u} a={88.4} b={89.2} slope={-0.35}><Two u={u} /></BeamSweep>);
  } else if (u < 110) {
    layers.push(<Two key="two" u={u} />);
  } else if (u < 134) {
    layers.push(<Ten key="ten" u={u} />,
      <AbsoluteFill key="flash" style={{ backgroundColor: C.warm, opacity: ease.inCubic(prog(u, 132.9, 134)) * 0.92 }} />);
  } else if (u < 139) {
    layers.push(<Glance key="glance" u={u} />,
      <AbsoluteFill key="flash" style={{ backgroundColor: C.warm, opacity: 0.5 * Math.exp(-(u - 134) * 2.6) }} />);
  } else if (u < 143) {
    layers.push(<Menu key="menu" u={u} />);
  } else if (u < 144) {
    const p = prog(u, 143, 144);
    const sy = Math.max(0.004, 1 - ease.inExpo(Math.min(1, p * 1.6)));
    const sx = p < 0.62 ? 1 : Math.max(0.002, 1 - ease.inCubic((p - 0.62) / 0.38));
    layers.push(<AbsoluteFill key="menu" style={{ transform: `scale(${sx}, ${sy})` }}><Menu u={u} /></AbsoluteFill>);
    if (sy < 0.05) {
      const lw = W * Math.max(sx, 0.003);
      layers.push(<div key="line" style={{ position: 'absolute', left: W / 2 - lw / 2, top: H / 2 - 2, width: lw, height: 4, background: C.accent, boxShadow: `0 0 20px ${C.accent}` }} />);
    }
  } else {
    layers.push(<End key="end" u={u} />);
  }

  return <AbsoluteFill style={{ backgroundColor: C.night }}>{layers}</AbsoluteFill>;
};
