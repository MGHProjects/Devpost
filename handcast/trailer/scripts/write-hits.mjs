// Exports src/hits.ts as out/trailer/hits.json (in the handcast folder) for the motion-reel SFX synth.
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const beats = JSON.parse(fs.readFileSync(path.join(here, '../src/beats.json'), 'utf8'));
const src = fs.readFileSync(path.join(here, '../src/hits.ts'), 'utf8');
const body = src.slice(src.indexOf('HITS: Hit[] = [') + 14, src.lastIndexOf('];') + 1).replace(/\(_, i\): Hit =>/g, '(_, i) =>');
const HITS = eval(body);
const out = HITS.map(([beat, label, sfx, opts]) => ({ beat, t: +(beats.offset + beat * beats.period).toFixed(4), label, sfx, ...(opts ? { opts } : {}) }));
const dir = path.join(here, '../../out/trailer');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'hits.json'), JSON.stringify(out, null, 1));
console.log(`${out.length} hits -> out/trailer/hits.json`);
