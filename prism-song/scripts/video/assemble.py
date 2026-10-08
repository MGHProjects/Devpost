#!/usr/bin/env python3
"""Assemble the demo video: title card + captured footage (+captions) + end card,
with the offline-rendered soundtrack. Usage: python3 assemble.py <videoDir> [url]
"""
import json
import math
import struct
import subprocess
import sys
import wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

D = Path(sys.argv[1] if len(sys.argv) > 1 else 'artifacts/video')
URL = sys.argv[2] if len(sys.argv) > 2 else ''
W, H = 1280, 720
FONT = '/usr/share/fonts/opentype/inter/Inter-{}.otf'
TITLE_SEC = 4.0
END_SEC = 6.0
meta = json.loads((D / 'captions.json').read_text())
FPS = meta['fps']


def font(weight, size):
    return ImageFont.truetype(FONT.format(weight), size)


def card(lines, path, beams=True):
    """Dark card with the game's own motif: a grid, a beam turned by a mirror, a crystal."""
    img = Image.new('RGB', (W, H), (9, 11, 18))
    d0 = ImageDraw.Draw(img)
    cell, gx, gy, n = 46, W // 2 - 46 * 4, 70, 6
    for i in range(n + 1):
        d0.line([(gx + i * cell, gy), (gx + i * cell, gy + n * cell)], fill=(32, 38, 56), width=1)
        d0.line([(gx, gy + i * cell), (gx + n * cell * 1.33, gy + i * cell)], fill=(32, 38, 56), width=1)
    glow = Image.new('RGB', (W, H), (0, 0, 0))
    g = ImageDraw.Draw(glow)
    if beams:
        y0 = gy + 4 * cell
        mx = gx + 3 * cell
        cyan = (77, 255, 243)
        g.line([(gx - 120, y0), (mx, y0)], fill=cyan, width=6)
        g.line([(mx, y0), (mx, gy + 1 * cell)], fill=cyan, width=6)
        # Mirror at the bend.
        g.line([(mx - 22, y0 + 22), (mx + 22, y0 - 22)], fill=(230, 238, 255), width=5)
        # Crystal (octahedron outline) where the beam ends.
        cx, cy = mx, gy + 1 * cell - 8
        g.polygon([(cx, cy - 34), (cx + 18, cy), (cx, cy + 22), (cx - 18, cy)], fill=(40, 120, 115), outline=cyan)
        g.line([(cx - 18, cy), (cx + 18, cy)], fill=cyan, width=2)
        # A second, warm beam for colour.
        y1 = gy + 2 * cell
        g.line([(mx + 4 * cell, y1 + 2 * cell), (mx + 2 * cell, y1)], fill=(255, 225, 77), width=5)
    blur = glow.filter(ImageFilter.GaussianBlur(12))
    img = Image.blend(img, blur, 0.85)
    img.paste(Image.composite(glow, img, glow.convert('L')))
    d = ImageDraw.Draw(img)
    y = 420 if beams else 250
    for text, weight, size, color in lines:
        f = font(weight, size)
        w = d.textlength(text, font=f)
        d.text(((W - w) / 2, y), text, font=f, fill=color)
        y += int(size * 1.45)
    img.save(path, quality=95)


card(
    [
        ('Prism Song', 'Bold', 72, (245, 245, 250)),
        ('Light puzzles that sing. Hands-first mixed reality.', 'Medium', 30, (200, 205, 220)),
        ('Captured in the IWER Meta Quest 3 emulator', 'Regular', 20, (130, 136, 150)),
    ],
    D / 'title.jpg',
)
end_lines = [
    ('Prism Song', 'Bold', 64, (245, 245, 250)),
    ('Seated  -  Hands-first  -  Passthrough  -  Spatial audio', 'Medium', 26, (200, 205, 220)),
    ('24 puzzles + a Daily Chord  -  Built with the Immersive Web SDK', 'Regular', 24, (170, 176, 190)),
]
if URL:
    end_lines.append(('Play on Meta Quest: ' + URL, 'SemiBold', 24, (143, 166, 255)))
card(end_lines, D / 'end.jpg')

# Captions as ASS so libass handles wrapping and the translucent box.
def ts(t):
    t = max(0.0, t)
    return f'{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}'


ass = [
    '[Script Info]', 'ScriptType: v4.00+', f'PlayResX: {W}', f'PlayResY: {H}', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, '
    'Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Cap,Inter Display SemiBold,34,&H00FFFFFF,&H00FFFFFF,&H00000000,&H90100C08,0,0,0,0,100,100,0,0,3,14,0,2,80,80,40,1',
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
]
caps = sorted(meta['captions'], key=lambda c: c['start'])
for i, c in enumerate(caps):
    end = c['end']
    if i + 1 < len(caps):
        end = min(end, caps[i + 1]['start'])
    s = c['start'] + TITLE_SEC
    e = end + TITLE_SEC
    ass.append(f'Dialogue: 0,{ts(s)},{ts(e)},Cap,,0,0,0,,{{\\fad(180,180)}}{c["text"]}')
(D / 'captions.ass').write_text('\n'.join(ass) + '\n')


def run(cmd):
    print('+', ' '.join(str(c) for c in cmd))
    subprocess.run(cmd, check=True)


# Silent-padded soundtrack: title silence + footage audio + end tail.
src = wave.open(str(D / 'audio.wav'))
rate, ch = src.getframerate(), src.getnchannels()
frames = src.readframes(src.getnframes())
src.close()
footage = meta['seconds']
pad = lambda sec: b'\x00\x00' * ch * int(rate * sec)
body = frames[: int(rate * footage) * ch * 2]
with wave.open(str(D / 'soundtrack.wav'), 'wb') as out:
    out.setnchannels(ch)
    out.setsampwidth(2)
    out.setframerate(rate)
    out.writeframes(pad(TITLE_SEC) + body + pad(END_SEC))

run([
    'ffmpeg', '-y', '-loglevel', 'error',
    '-loop', '1', '-t', str(TITLE_SEC), '-framerate', str(FPS), '-i', str(D / 'title.jpg'),
    '-framerate', str(FPS), '-i', str(D / 'frames' / '%05d.jpg'),
    '-loop', '1', '-t', str(END_SEC), '-framerate', str(FPS), '-i', str(D / 'end.jpg'),
    '-i', str(D / 'soundtrack.wav'),
    '-filter_complex',
    f'[0:v]fade=t=in:st=0:d=0.8,fade=t=out:st={TITLE_SEC - 0.6}:d=0.6,setsar=1[t];'
    f'[1:v]fade=t=in:st=0:d=0.5,setsar=1[f];'
    f'[2:v]fade=t=in:st=0:d=0.8,setsar=1[e];'
    f'[t][f][e]concat=n=3:v=1:a=0[cat];'
    f'[cat]ass={D / "captions.ass"}[v]',
    '-map', '[v]', '-map', '3:a',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', str(FPS),
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart',
    str(D / 'prism-song-demo.mp4'),
])
dur = subprocess.run(
    ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(D / 'prism-song-demo.mp4')],
    capture_output=True, text=True,
).stdout.strip()
print('video duration', dur)
