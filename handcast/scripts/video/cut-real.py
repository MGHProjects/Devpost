#!/usr/bin/env python3
"""
Cuts the trailer from footage recorded on a Meta Quest 3 (passthrough, real
hands, game audio). Each shot is a time range of the source with one caption;
every shot is labelled "Captured on Meta Quest 3". Brand cards open and close.

Usage: python3 scripts/video/cut-real.py SOURCE.mp4 OUT.mp4 [--shots shots.json] [--safe 1.0]

Shot times are for the first capture (capture-1, 6:40, 848x478); a new
recording needs its own shot list (--shots, a JSON list of [start, end, caption]).
Shots avoid frames where a screen in the room shows other people (the rules
allow no identifiable person other than entrants).
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / 'media' / 'brand'
FONT = '/usr/share/fonts/opentype/inter/Inter-{}.otf'
W, H, FPS = 1920, 1080, 30
LABEL = 'Captured on Meta Quest 3'
SAFE = 0.82

SHOTS = [
    (324.0, 335.4, 'Hold still. Your hand turns to glass.'),
    (28.4, 34.6, 'The bench pours out of your palm, onto your real table.'),
    ('card', 'card-title.png', 2.8),
    (125.6, 130.8, 'An open hand fans the light.'),
    (258.4, 262.6, 'On its edge, a mirror.'),
    (131.0, 133.6, 'A fist knocks glass down. The glass comes back.'),
    (136.6, 140.6, 'Every open finger is a port.'),
    (295.0, 304.8, 'Glass hands pass the light to each other.'),
    (340.0, 346.0, 'Light every crystal in its exact colour.'),
    (380.4, 391.4, 'Two hands, frozen. One chord.'),
    ('card', 'card-end.png', 4.5),
]


def esc(text: str) -> str:
    return text.replace('\\', '\\\\').replace(':', '\\:').replace("'", "’").replace(',', '\\,')


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def shot(src: str, start: float, end: float, caption: str, out: Path) -> None:
    dur = end - start
    fade = 0.25
    # Safe framing: a 16:9 window of 82 % anchored bottom-right keeps the bench
    # and hands and leaves out the top-left corner of the room, where a screen
    # showing other people sat during capture-1.
    vf = (
        f'crop=iw*{SAFE}:ih*{SAFE}:iw*(1-{SAFE}):ih*(1-{SAFE}),'
        f'scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={FPS},'
        f"drawtext=fontfile={FONT.format('SemiBold')}:text='{esc(caption)}':fontsize=48:fontcolor=white:"
        f'x=(w-text_w)/2:y=h-136:box=1:boxcolor=0x070a10@0.62:boxborderw=26,'
        f"drawtext=fontfile={FONT.format('Medium')}:text='{esc(LABEL)}':fontsize=26:fontcolor=white@0.85:"
        f'x=w-text_w-36:y=32:box=1:boxcolor=0x070a10@0.5:boxborderw=12,'
        f'fade=t=in:st=0:d={fade},fade=t=out:st={dur - fade:.3f}:d={fade}'
    )
    af = f'afade=t=in:st=0:d={fade},afade=t=out:st={dur - fade:.3f}:d={fade},aresample=48000'
    run(['ffmpeg', '-y', '-ss', f'{start}', '-t', f'{dur}', '-i', src, '-vf', vf, '-af', af,
         '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
         '-c:a', 'aac', '-b:a', '192k', '-ac', '2', str(out)])


def card(name: str, dur: float, out: Path) -> None:
    fade = 0.4
    run(['ffmpeg', '-y', '-loop', '1', '-t', f'{dur}', '-i', str(BRAND / name),
         '-f', 'lavfi', '-t', f'{dur}', '-i', 'anullsrc=r=48000:cl=stereo',
         '-vf', f'scale={W}:{H},setsar=1,fps={FPS},fade=t=in:st=0:d={fade},fade=t=out:st={dur - fade:.3f}:d={fade}',
         '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
         '-c:a', 'aac', '-b:a', '192k', '-shortest', str(out)])


def main() -> None:
    args = sys.argv[1:]
    if len(args) < 2:
        sys.exit(__doc__)
    src, dst = args[0], Path(args[1])
    shots = SHOTS
    global SAFE
    if '--safe' in args:
        SAFE = float(args[args.index('--safe') + 1])
    if '--shots' in args:
        shots = [tuple(s) for s in json.loads(Path(args[args.index('--shots') + 1]).read_text())]
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        for i, s in enumerate(shots):
            part = Path(tmp) / f'{i:02d}.mp4'
            if s[0] == 'card':
                card(s[1], s[2], part)
            else:
                shot(src, s[0], s[1], s[2], part)
            parts.append(part)
        lst = Path(tmp) / 'list.txt'
        lst.write_text(''.join(f"file '{p}'\n" for p in parts))
        run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy', '-movflags', '+faststart', str(dst)])
    total = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(dst)],
                                 capture_output=True, text=True).stdout)
    print(f'{dst} {total:.1f} s')


if __name__ == '__main__':
    main()
