#!/usr/bin/env python3
"""Builds audio/mix.wav: the score, the game's own sound placed under each shot, and the SFX,
mastered to -14 LUFS integrated / -1 dBTP. Run after cut-clips.py and the SFX synth."""
import json, subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
beats = json.loads((ROOT / 'src/beats.json').read_text())
T = lambda b: beats['offset'] + b * beats['period']
GAME_GAIN = 1.0
inputs, chains = [], []
for i, s in enumerate(json.loads((ROOT / 'src/shots.json').read_text())):
    dur = (s['b1'] - s['b0']) * beats['period']
    inputs += ['-i', str(ROOT / 'public/clips' / f"{s['id']}.mp4")]
    chains.append(f"[{i}:a]atrim=start=1:duration={dur:.3f},asetpts=PTS-STARTPTS,"
                  f"afade=t=in:d=0.06,afade=t=out:st={dur - 0.12:.3f}:d=0.12,"
                  f"adelay={T(s['b0']) * 1000:.0f}|{T(s['b0']) * 1000:.0f}[g{i}]")
n = len(chains)
score, sfx = n, n + 1
inputs += ['-i', str(ROOT / 'public/audio/score.wav'), '-i', str(ROOT / 'audio/sfx.wav')]
graph = ';'.join(chains) + ';' + ''.join(f'[g{i}]' for i in range(n)) + \
    f'amix=inputs={n}:normalize=0,volume={GAME_GAIN}[game];' \
    f'[{score}:a]volume=0.85[m];[game]asplit[ga][gk];[m][gk]sidechaincompress=threshold=0.06:ratio=3:attack=20:release=300[md];' \
    f'[md][ga][{sfx}:a]amix=inputs=3:normalize=0,atrim=0:75,' \
    'loudnorm=I=-14:TP=-1.2:LRA=11,aresample=48000[out]'
out = ROOT / 'audio/mix.wav'
subprocess.run(['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', graph, '-map', '[out]', '-ac', '2', str(out)], check=True)
print(out)
