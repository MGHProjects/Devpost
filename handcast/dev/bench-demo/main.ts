/**
 * Visual harness for the bench props, beams and ambience. A fake
 * "passthrough" room (wooden desk, warm wall) stands in for the real world.
 * URL params: ?view=seat|top|close|low  ?solved  ?t=<seconds to settle>
 */

import {
  CanvasTexture,
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { BeamSeg, LevelDef } from '../../src/core/types.js';
import { Ambience } from '../../src/render/bench/ambience.js';
import { BeamRenderer2D } from '../../src/render/bench/beams2d.js';
import { BenchView } from '../../src/render/bench/bench-view.js';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'seat';
const solved = params.has('solved');

const level: LevelDef = {
  v: 1,
  id: 'demo-1',
  name: 'Bench demo',
  bench: { w: 0.44, d: 0.3 },
  budget: 2,
  lamps: [
    { p: [-0.205, -0.075], a: 0, color: 1 },
    { p: [0.05, 0.135], a: -Math.PI / 2, color: 2 },
  ],
  wells: [{ p: [-0.15, 0.085], r: 0.026, color: 4 }],
  crystals: [
    { p: [0.135, -0.075], color: 1 }, // lit (red)
    { p: [-0.075, -0.035], color: 3 }, // partial (yellow, has green)
    { p: [0.175, 0.07], color: 4 }, // wrong (blue, gets green)
    { p: [-0.02, 0.08], color: 5 }, // off (magenta)
  ],
  hush: [{ p: [0.02, -0.125] }, { p: [0.09, 0.0] }],
  walls: [{ a: [-0.04, 0.0], b: [0.0, 0.035] }],
  mirrors: [{ a: [0.03, 0.09], b: [0.07, 0.05] }],
};

const beams: BeamSeg[] = [
  // red lamp -> lit crystal
  { a: [-0.205, -0.075], b: [0.135, -0.075], color: 1, d0: 0, live: false },
  // green lamp -> mirror -> blue crystal (wrong colour)
  { a: [0.05, 0.135], b: [0.05, 0.07], color: 2, d0: 0, live: false },
  { a: [0.05, 0.07], b: [0.175, 0.07], color: 2, d0: 0.065, live: false },
  // a live hand above the well throws blue and (assisted) green
  { a: [-0.15, 0.085], b: [-0.105, 0.02], color: 4, d0: 0, live: true },
  { a: [-0.105, 0.02], b: [0.02, -0.125], color: 4, d0: 0.08, live: true },
  { a: [-0.12, 0.05], b: [-0.075, -0.035], color: 2, d0: 0.05, live: false, assisted: true },
];

const W = 1280;
const H = 800;
const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x5d554c);

// --- fake passthrough room
function woodTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  const g = c.getContext('2d')!;
  const planks = 6;
  for (let p = 0; p < planks; p++) {
    const y0 = (p * 1024) / planks;
    const hue = 26 + (p % 3) * 3;
    g.fillStyle = `hsl(${hue}, 32%, ${34 + (p % 2) * 4}%)`;
    g.fillRect(0, y0, 1024, 1024 / planks);
    for (let k = 0; k < 70; k++) {
      g.strokeStyle = `hsla(${hue - 4}, 35%, ${20 + Math.random() * 20}%, ${0.08 + Math.random() * 0.12})`;
      g.lineWidth = 1 + Math.random() * 2;
      g.beginPath();
      const yy = y0 + Math.random() * (1024 / planks);
      g.moveTo(0, yy);
      for (let x = 0; x <= 1024; x += 64) g.lineTo(x, yy + Math.sin(x * 0.01 + k) * 3);
      g.stroke();
    }
    g.fillStyle = 'rgba(20,10,5,0.6)';
    g.fillRect(0, y0, 1024, 3);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
const table = new Mesh(new PlaneGeometry(1.6, 0.9), new MeshBasicMaterial({ map: woodTexture(), color: 0xcfc4b8 }));
table.rotation.x = -Math.PI / 2;
table.position.set(0, 0.749, -0.05);
scene.add(table);
const wall = new Mesh(new PlaneGeometry(6, 3), new MeshBasicMaterial({ color: 0x8a8174 }));
wall.position.set(0, 1.5, -1.6);
scene.add(wall);
const floor = new Mesh(new PlaneGeometry(6, 6), new MeshBasicMaterial({ color: 0x4a443d }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
// a window-ish bright patch and a lamp on the wall, to show the dimming
const windowPane = new Mesh(new PlaneGeometry(0.9, 0.7), new MeshBasicMaterial({ color: 0xd8e2ee }));
windowPane.position.set(0.9, 1.6, -1.59);
scene.add(windowPane);
// passthrough has no depth: the fake room must not occlude the ambience dome
[floor, wall, windowPane, table].forEach((m, i) => {
  (m.material as MeshBasicMaterial).depthWrite = false;
  m.renderOrder = -2010 + i;
});

// --- the bench
const bench = new BenchView(level);
bench.root.position.set(0, 0.75, 0);
bench.root.rotation.y = 0;
scene.add(bench.root);
const beamsR = new BeamRenderer2D();
bench.root.add(beamsR.group);
beamsR.setSegments(beams);

bench.setCrystal(0, 'lit', 1);
bench.setCrystal(1, 'partial', 2);
bench.setCrystal(2, 'wrong', 2);
bench.setCrystal(3, 'off', 0);
bench.setHush(0, true);
bench.setHush(1, false);
bench.highlightCrystal(3, true);
if (solved) {
  bench.setCrystal(1, 'lit', 3);
  bench.setCrystal(2, 'lit', 4);
  bench.setCrystal(3, 'lit', 5);
  bench.setHush(0, false);
  bench.highlightCrystal(3, false);
}

const ambience = new Ambience();
scene.add(ambience.group);
ambience.setBenchCenter(new Vector3(0, 0.75, 0));

// --- camera
const camera = new PerspectiveCamera(60, W / H, 0.01, 20);
const target = new Vector3(0, 0.75, -0.015);
const views: Record<string, [number, number, number]> = {
  seat: [0.45, 35, 0], // distance, elevation deg, azimuth deg
  top: [0.55, 80, 0],
  close: [0.24, 28, -25],
  low: [0.32, 14, 30],
  wide: [1.1, 30, 0],
  hush: [0.16, 40, 10],
  eye: [0.09, 38, 0],
};
const [dist, elev, az] = views[view] ?? views.seat;
if (view === 'hush') target.set(0.05, 0.755, -0.07);
if (view === 'eye') target.set(0.02, 0.755, -0.125);
const e = (elev * Math.PI) / 180;
const a = (az * Math.PI) / 180;
camera.position.set(target.x + Math.sin(a) * Math.cos(e) * dist, target.y + Math.sin(e) * dist, target.z + Math.cos(a) * Math.cos(e) * dist);
if (view === 'close') target.set(0.06, 0.76, -0.03);
camera.lookAt(target);

let last = performance.now();
let time = 0;
let pulsed = false;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += dt;
  (window as unknown as { benchTime: number }).benchTime = time;
  if (solved && !pulsed && time > 1.6) {
    pulsed = true;
    bench.pulseSolved();
  }
  bench.update(dt, time);
  beamsR.setBoost(solved && pulsed ? Math.max(0, 1 - (time - 1.6) / 2) : 0);
  beamsR.update(dt, time);
  ambience.update(dt, time);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
(window as unknown as { benchReady: boolean }).benchReady = true;
