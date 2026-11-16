/**
 * Glass-hand visual harness: casts on a dark bench under a studio-ish light.
 * URL params: view=wide|close|molten|shatter|silver|ghost|coat, t=<seconds> freezes the clock.
 * Screenshots: node dev/glass-demo/shoot.mjs artifacts wide@2 close@2.3 ... (server on :5175).
 */
import {
  BoxGeometry, Clock, Color, DirectionalLight, HemisphereLight, Mesh, MeshStandardMaterial,
  PerspectiveCamera, Scene, Vector3, WebGLRenderer,
} from '@iwsdk/core';
import { canonicalPose } from '../../src/core/pose-library';
import { CastView } from '../../src/render/glass/cast-view';
import { loadHandTemplates } from '../../src/render/glass/hand-model';
import type { Shatter } from '../../src/render/glass/shatter';
import { createCoatMesh } from '../../src/render/glass/coat-material';
import type { SkinnedMesh } from '@iwsdk/core';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'wide';
const frozen = params.has('t') ? Number(params.get('t')) : null;

const renderer = new WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000, 0);
document.body.appendChild(renderer.domElement);

const scene = new Scene();
const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.01, 10);

// Bench: a dark slate slab with its top at y = 0.
const bench = new Mesh(
  new BoxGeometry(0.62, 0.03, 0.42),
  new MeshStandardMaterial({ color: new Color(0x23262d), roughness: 0.82, metalness: 0.05 }),
);
bench.position.y = -0.015;
scene.add(bench);
scene.add(new HemisphereLight(0xc8d4ff, 0x1a1410, 0.9));
const key = new DirectionalLight(0xffffff, 1.4);
key.position.set(-0.4, 1, 0.5);
scene.add(key);

const RED = new Color(1, 0.08, 0.05);
const BLUE = new Color(0.1, 0.35, 1);
const GREEN = new Color(0.15, 1, 0.3);

const templates = await loadHandTemplates();

const casts: CastView[] = [];
function add(c: CastView): CastView {
  scene.add(c.root);
  casts.push(c);
  return c;
}

const lit = add(new CastView(templates, canonicalPose('spread', 'right', [0.0, -0.01]), 'glass'));
lit.setFingerLight(1, RED);
lit.setFingerLight(3, BLUE);
const molten = add(new CastView(templates, canonicalPose('peace', 'left', [-0.2, 0.0], -Math.PI / 2 + 0.25), 'glass'));
const silver = add(new CastView(templates, canonicalPose('blade', 'right', [0.19, -0.02], -Math.PI / 2 - 0.2), 'silver'));
const ghost = add(new CastView(templates, canonicalPose('point', 'right', [0.03, -0.17], -Math.PI / 2 + 0.5), 'ghost'));
ghost.setOpacity(0.9);

// A "live" hand (the template's own skinned mesh, posed by its bones) wearing the molten coat.
const livePose = canonicalPose('relaxed', 'right', [0.13, 0.11], -Math.PI / 2 - 0.35);
const liveScene = templates.right.scene;
templates.right.bones.forEach((b, j) => {
  b.position.fromArray(livePose.pos as number[], j * 3);
  b.quaternion.fromArray(livePose.rot as number[], j * 4);
});
const liveMesh = templates.right.mesh as SkinnedMesh;
liveMesh.material = new MeshStandardMaterial({ color: new Color(0xb98f78), roughness: 0.55 });
liveMesh.frustumCulled = false;
scene.add(liveScene);
const coat = createCoatMesh(liveMesh);
coat.setVisible(true);

const looks: Record<string, [Vector3, Vector3]> = {
  wide: [new Vector3(0, 0.36, 0.38), new Vector3(0, 0.0, -0.05)],
  close: [new Vector3(0.05, 0.17, 0.17), new Vector3(0.0, 0.03, -0.04)],
  molten: [new Vector3(-0.2, 0.28, 0.13), new Vector3(-0.2, 0.02, -0.05)],
  shatter: [new Vector3(0.03, 0.2, 0.22), new Vector3(0.0, 0.03, -0.04)],
  silver: [new Vector3(0.12, 0.15, 0.17), new Vector3(0.19, 0.04, -0.03)],
  ghost: [new Vector3(0.08, 0.17, 0.08), new Vector3(0.03, 0.03, -0.17)],
  coat: [new Vector3(0.2, 0.2, 0.3), new Vector3(0.12, 0.03, 0.1)],
};
const [eye, target] = looks[view] ?? looks.wide;
camera.position.copy(eye);
camera.lookAt(target);

let shards: Shatter | null = null;
const clock = new Clock();
let time = 0;

/** Advances the demo to time `t` (fixed steps so frozen screenshots are deterministic). */
function advance(t: number): void {
  const step = 1 / 60;
  while (time < t) {
    time += step;
    // Molten demo: the front sweeps wrist -> tips in 2.2 s, cools for 1.5 s, holds, repeats.
    const cycle = view === 'molten' && frozen !== null ? time : time % 5;
    const front = Math.min(1.05, cycle / 2.2);
    const heat = cycle < 2.2 ? 1 : Math.max(0, 1 - (cycle - 2.2) / 1.5);
    molten.setMolten(front, heat);
    coat.setMolten(front, heat);
    coat.update(time);
    molten.setFingerLight(2, cycle > 3.7 ? GREEN : null);
    for (const c of casts) c.update(step, time);
    if (view === 'shatter' && !shards && time > 0.6) shards = lit.shatter();
    if (shards && !shards.update(step)) { shards.dispose(); shards = null; }
  }
}

const w = window as unknown as { __ready?: boolean; __advance?: (t: number) => void };
w.__advance = (t) => { advance(t); renderer.render(scene, camera); };

function frame(): void {
  if (frozen === null) advance(time + clock.getDelta());
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
if (frozen !== null) advance(frozen);
frame();
w.__ready = true;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
