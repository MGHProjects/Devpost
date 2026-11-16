/**
 * Glass-hand material: one single-pass ShaderMaterial (no transmission or
 * refraction render passes) shared by the cast meshes, the molten coat on the
 * live hand (skinned: three's skinning chunks switch on automatically for a
 * SkinnedMesh) and the shatter shards.
 *
 * Look ('glass'): clear soda-lime glass with a Schlick fresnel rim, a faint
 * thin-film iridescence (hue drifting with the view angle), reflections of a
 * procedural studio (dark floor, horizon glow, two softboxes, a strip light),
 * a faint green-blue body tint at grazing angles, and INNER LIGHT: a finger
 * carrying light glows from inside in its colour with pulses flowing palm ->
 * fingertip along aAlong and a bright bead at the fingertip (the output port).
 * 'silver' is polished chrome (no inner light), opaque. 'ghost' is a faint
 * blue hologram for hints and strangers' hands.
 *
 * Molten casting (uMolten = front position along aAlong, uHeat = glow):
 * behind the front the fresh glass cools from white-hot -> amber -> clear over
 * ~0.3 of aAlong; at the front a bright white-orange band bulges slightly;
 * ahead of the front the surface is discarded so the real hand shows.
 * Everything molten scales with uHeat: ramp it to 0 to let the cast cool.
 *
 * Output is premultiplied alpha (reflections and glow add light; the alpha
 * only darkens what is behind), so the glass reads over passthrough.
 */
import {
  Color, CustomBlending, DoubleSide, FrontSide, NormalBlending,
  OneFactor, OneMinusSrcAlphaFactor, ShaderMaterial, type IUniform, type Side,
} from '@iwsdk/core';

export type GlassKind = 'glass' | 'silver' | 'ghost';

export interface GlassUniforms {
  [name: string]: IUniform;
  uTime: IUniform<number>;
  /** Light colour carried by each finger (thumb..pinky), linear RGB; black = dark. */
  uFingerLight: IUniform<Color[]>;
  /** Light colour carried in the palm. */
  uPalmLight: IUniform<Color>;
  /** Molten front along aAlong (0 wrist .. 1 fingertips; >= 1 fully set). */
  uMolten: IUniform<number>;
  /** 0..1 overall molten glow. */
  uHeat: IUniform<number>;
  uOpacity: IUniform<number>;
  /** Inner-light pulse speed (pulses travel palm -> tip). */
  uFlowSpeed: IUniform<number>;
  /** 0..1 selection highlight. */
  uSelected: IUniform<number>;
  /** 0..1 dissolve. */
  uShatter: IUniform<number>;
  /** Shell offset along the normal in metres (used by the live-hand coat). */
  uInflate: IUniform<number>;
}

export type GlassMaterial = ShaderMaterial & { uniforms: GlassUniforms; kind: GlassKind };

export interface GlassMaterialOptions {
  side?: Side;
  /** Share another material's uniforms (e.g. the BackSide pass of a cast). */
  uniforms?: GlassUniforms;
  /** Take noise coordinates from an `aRest` vec3 attribute instead of `position`. */
  restAttribute?: boolean;
}

export function createGlassUniforms(): GlassUniforms {
  return {
    uTime: { value: 0 },
    uFingerLight: { value: [new Color(0), new Color(0), new Color(0), new Color(0), new Color(0)] },
    uPalmLight: { value: new Color(0) },
    uMolten: { value: 1 },
    uHeat: { value: 0 },
    uOpacity: { value: 1 },
    uFlowSpeed: { value: 1.1 },
    uSelected: { value: 0 },
    uShatter: { value: 0 },
    uInflate: { value: 0 },
  };
}

export const GLASS_VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
attribute float aAlong;
attribute vec2 aVein;
#ifdef USE_REST
attribute vec3 aRest; // stable noise coordinates for moving geometry (shards)
#endif
uniform vec3 uFingerLight[5];
uniform vec3 uPalmLight;
uniform float uMolten;
uniform float uHeat;
uniform float uInflate;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vLocal;
varying vec3 vLight;
varying float vAlong;

vec3 fingerLight(float f) {
  return uFingerLight[0] * (1.0 - step(0.5, abs(f)))
       + uFingerLight[1] * (1.0 - step(0.5, abs(f - 1.0)))
       + uFingerLight[2] * (1.0 - step(0.5, abs(f - 2.0)))
       + uFingerLight[3] * (1.0 - step(0.5, abs(f - 3.0)))
       + uFingerLight[4] * (1.0 - step(0.5, abs(f - 4.0)));
}

void main() {
  #include <skinbase_vertex>
  #include <beginnormal_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  // Molten front bulges a little as it flows.
  float d = (aAlong - uMolten) / 0.035;
  float bulge = exp(-d * d) * uHeat * step(uMolten, 1.02);
  transformed += normal * (uInflate + bulge * 0.0012);
  #include <skinning_vertex>
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
  #ifdef USE_REST
  vLocal = aRest;
  #else
  vLocal = position;
  #endif
  vAlong = aAlong;
  // The palm carries its light more softly than the fingers (they are the ports).
  vLight = mix(uPalmLight * 0.45, fingerLight(aVein.x), aVein.y);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const GLASS_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uMolten;
uniform float uHeat;
uniform float uOpacity;
uniform float uFlowSpeed;
uniform float uSelected;
uniform float uShatter;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vLocal;
varying vec3 vLight;
varying float vAlong;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

float softbox(vec3 r, vec3 dir, vec3 u, vec3 v, vec2 size) {
  float facing = dot(r, dir);
  vec2 q = abs(vec2(dot(r, u), dot(r, v))) / max(facing, 1e-3);
  vec2 e = smoothstep(size, size * 0.8, q);
  return e.x * e.y * step(0.0, facing);
}

// Procedural photo studio around the bench (world space, +Y up).
vec3 studio(vec3 r) {
  float y = r.y;
  vec3 c = mix(vec3(0.012, 0.012, 0.016), vec3(0.06, 0.065, 0.08), smoothstep(-0.5, 0.0, y));
  c += vec3(0.30, 0.31, 0.34) * exp(-abs(y - 0.06) * 9.0);                 // horizon glow
  c += vec3(0.10, 0.11, 0.14) * smoothstep(0.1, 1.0, y);                  // ceiling
  c += vec3(3.2, 3.1, 2.9) * softbox(r, normalize(vec3(-0.45, 0.85, 0.30)), vec3(0.88, 0.47, 0.0), vec3(-0.12, 0.3, -0.95), vec2(0.42, 0.26));
  c += vec3(1.6, 1.75, 2.1) * softbox(r, normalize(vec3(0.55, 0.65, -0.52)), vec3(0.68, 0.0, 0.72), vec3(-0.45, 0.78, 0.43), vec2(0.30, 0.20));
  c += vec3(2.2, 2.0, 1.7) * softbox(r, normalize(vec3(0.95, 0.12, 0.25)), vec3(-0.25, 0.0, 0.97), vec3(0.1, 0.99, 0.0), vec2(0.05, 0.7)); // strip
  c += vec3(0.9, 0.55, 0.3) * softbox(r, normalize(vec3(-0.2, 0.15, -0.97)), vec3(0.98, 0.0, -0.2), vec3(0.0, 1.0, 0.15), vec2(0.6, 0.08)); // warm rim
  return c;
}

vec3 blackbody(float t) {
  // 0 = clear, 0.3 deep amber, 0.6 orange, 1 yellow-white hot.
  vec3 c = vec3(smoothstep(0.0, 0.35, t), smoothstep(0.25, 0.95, t) * 0.75, smoothstep(0.75, 1.0, t) * 0.4);
  return c * (0.25 * t + 1.1 * t * t);
}

void main() {
  float ahead = vAlong - uMolten;
  if (ahead > 0.006) discard;
  float n0 = 1.0;
  if (uShatter > 0.0) {
    n0 = vnoise(vLocal * 260.0);
    if (n0 < uShatter * 1.05) discard;
  }

  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 N = normalize(vWorldNormal);
  bool back = !gl_FrontFacing;
  if (back) N = -N;

  float age = clamp(-ahead / 0.3, 0.0, 1.0);
  float temp = (1.0 - age) * uHeat;
  // Hot glass ripples.
  if (temp > 0.01) {
    vec3 q = vLocal * 180.0 + vec3(0.0, uTime * 1.7, 0.0);
    N = normalize(N + temp * 0.3 * (vec3(vnoise(q), vnoise(q + 17.0), vnoise(q + 41.0)) - 0.5));
  }
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float fr = pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, N);

  vec3 col;
  float alpha;

#if defined(KIND_SILVER)
  vec3 env = studio(R) + vec3(0.06, 0.065, 0.075);
  float F = mix(0.88, 1.0, fr);
  col = env * vec3(0.95, 0.97, 1.0) * F * 1.15;
  alpha = 1.0;
#else
  vec3 env = studio(R);
  // Thin-film iridescence: hue drifts with the view angle and along the hand.
  vec3 film = 0.5 + 0.5 * cos(6.2832 * (NdV * 1.4 + vAlong * 0.35 + vec3(0.0, 0.33, 0.67)));
  float F = 0.04 + 0.96 * fr;
  vec3 refl = env * mix(vec3(1.0), film * 1.5, back ? 0.0 : 0.3 * fr);
  // Fake refraction: a faint, bent look through the body at the studio.
  vec3 T = refract(-V, N, back ? 1.5 : 0.667);
  vec3 through = studio(T) * 0.012;
  vec3 body = vec3(0.20, 0.42, 0.40) * 0.05 * pow(1.0 - NdV, 1.5);
  if (back) refl *= 0.35;
  col = refl * F + through + body;
  alpha = 0.02 + F * 0.92;

  // INNER LIGHT: pulses running through veins of glass, palm -> fingertip;
  // edge-lit like acrylic (light escapes at grazing rims) with a bright tip.
  float lum = max(vLight.r, max(vLight.g, vLight.b));
  if (lum > 0.001) {
    float s = vAlong * 4.0 - uTime * uFlowSpeed;
    float f = fract(s);
    float pulse = smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.06, 0.45, f));
    float vn = vnoise(vLocal * 110.0 + vec3(0.0, -uTime * 0.35, uTime * 0.2));
    float veins = 1.0 - smoothstep(0.0, 0.1, abs(vn - 0.5));
    float edgeLit = pow(1.0 - NdV, 2.0);
    vec3 inner = vLight * (0.04 + 0.45 * edgeLit);
    inner += vLight * pulse * (0.12 + 0.85 * veins);
    inner += vLight * veins * 0.06;
    inner += mix(vLight, vec3(1.0), 0.3) * smoothstep(0.88, 0.99, vAlong) * 0.9; // fingertip port
    #if defined(KIND_GHOST)
    inner *= 0.4;
    #endif
    if (back) inner *= 0.5;
    col += inner;
    alpha += min(lum, 1.0) * 0.06;
  }

  #if defined(KIND_GHOST)
  vec3 ghost = vec3(0.10, 0.32, 1.0);
  float scan = smoothstep(0.85, 1.0, sin(vAlong * 50.0 - uTime * 3.0));
  col = ghost * (0.015 + 0.55 * fr + 0.05 * scan) + col * 0.25;
  alpha = 0.015 + 0.3 * fr + 0.03 * scan;
  #endif
#endif

  // Molten: cooling trail behind the front, bright band at the front.
  vec3 hot = vec3(0.0);
  if (temp > 0.002) {
    // Flowing brightness in the melt and glowing rims.
    float melt = vnoise(vLocal * 150.0 + vec3(0.0, 0.0, uTime * 2.0));
    hot = blackbody(temp) * (0.7 + 0.6 * melt) + blackbody(min(1.0, temp * 1.15)) * fr * 1.5;
  }
  float band = exp(-pow(ahead / 0.014, 2.0)) * uHeat * step(uMolten, 1.02);
  hot += vec3(1.0, 0.75, 0.45) * band * 2.0;
  col += hot;
  alpha = max(alpha, clamp(temp * 0.85 + band, 0.0, 1.0));
  // Soft leading edge.
  float edge = 1.0 - smoothstep(-0.004, 0.006, ahead);
  #if !defined(KIND_SILVER)
  alpha *= edge;
  col *= edge;
  #endif

  // Selection: a breathing cool rim.
  if (uSelected > 0.0) {
    float rim = pow(1.0 - NdV, 2.2) * uSelected * (0.75 + 0.25 * sin(uTime * 5.0));
    col += vec3(0.55, 0.85, 1.0) * rim * 1.6;
    alpha = max(alpha, rim * 0.6);
  }
  // Shatter: crack glow on the dissolving edge.
  if (uShatter > 0.0) {
    float crack = 1.0 - smoothstep(0.0, 0.1, n0 - uShatter * 1.05);
    col += vec3(1.0, 0.9, 0.75) * crack * 2.0;
    alpha = max(alpha, crack);
  }

  alpha = clamp(alpha, 0.0, 1.0) * uOpacity;
  col *= uOpacity;
  // Hue-preserving shoulder: bright light saturates instead of clipping to white.
  float peak = max(col.r, max(col.g, col.b));
  if (peak > 0.8) col *= (0.8 + 0.2 * (1.0 - exp(-(peak - 0.8) * 3.0))) / peak;
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;

/** Creates a glass / silver / ghost material (see the module comment). */
export function createGlassMaterial(kind: GlassKind, opts: GlassMaterialOptions = {}): GlassMaterial {
  const uniforms = opts.uniforms ?? createGlassUniforms();
  const defines: Record<string, string> = {};
  if (kind === 'silver') defines.KIND_SILVER = '';
  if (kind === 'ghost') defines.KIND_GHOST = '';
  if (opts.restAttribute) defines.USE_REST = '';
  const opaque = kind === 'silver';
  const m = new ShaderMaterial({
    name: `glass-${kind}`,
    uniforms,
    defines,
    vertexShader: GLASS_VERTEX,
    fragmentShader: GLASS_FRAGMENT,
    side: opts.side ?? (opaque ? FrontSide : DoubleSide),
    transparent: !opaque,
    depthWrite: opaque,
    premultipliedAlpha: true,
    blending: opaque ? NormalBlending : CustomBlending,
  }) as GlassMaterial;
  if (!opaque) {
    m.blendSrc = OneFactor;
    m.blendDst = OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = OneFactor;
    m.blendDstAlpha = OneMinusSrcAlphaFactor;
  }
  m.kind = kind;
  return m;
}
