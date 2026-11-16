#!/usr/bin/env python3
"""Cuts each shot of src/shots.json out of the Quest 3 capture into public/clips/<id>.mp4
(H.264, 30 fps, with game audio), padded by PAD seconds on both sides for transitions.
Usage: python3 scripts/cut-clips.py CAPTURE.mp4"""
import json, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
PAD = 1.0
beats = json.loads((ROOT / 'src/beats.json').read_text())
period = beats['period']
for s in json.loads((ROOT / 'src/shots.json').read_text()):
    dur = (s['b1'] - s['b0']) * period + 2 * PAD
    out = ROOT / 'public/clips' / f"{s['id']}.mp4"
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f"{s['src'] - PAD:.3f}", '-t', f'{dur:.3f}', '-i', sys.argv[1],
                    '-vf', 'fps=30,scale=1920:1080,setsar=1', '-c:v', 'libx264', '-crf', '16', '-preset', 'fast',
                    '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', str(out)], check=True)
    print(out.name, f'{dur:.2f}s')
