#!/usr/bin/env python3
"""HANDCAST brand marks: emblem, wordmark lockup and the video title / end cards.

The emblem is drawn from measured geometry, not traced: an open right hand as
the 25 joints WebXR hand tracking reports (wrist, 4 thumb joints, 5 per
finger), a glass body with one clean edge, fibre-optic cores that gather white
light from a pool under the wrist and carry it to each fingertip, and five
beams that leave the fingertips in additive colours and stop on crystals that
sit on one shared arc.

Each mark is written as SVG inside a small HTML page, then rendered by
Playwright's Chromium at 2x device scale (scripts/brand/render.mjs).

    python3 scripts/brand/make_logo.py            # writes media/brand/*.png
"""
import math
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'media' / 'brand'
FONTS = Path(os.environ.get('CANVAS_FONTS', '/root/.claude/skills/synced/b983ad40-0faa-49fd-8786-a7d8b811cfd2_f3283a96-2de3-4b72-b084-1381ef4ebed7/canvas-design/canvas-fonts'))

BG = '#06080d'
# Game palette (src/render/bench/props.ts): red, yellow, white, cyan, blue.
COLORS = {'thumb': '#ff4d4d', 'index': '#ffe14d', 'middle': '#fff6e8', 'ring': '#4dfff3', 'pinky': '#4d8dff'}
WARM = '#fff1d6'


def d(theta):
    """Unit vector for a heading in degrees from straight up, clockwise positive (SVG y down)."""
    t = math.radians(theta)
    return (math.sin(t), -math.cos(t))


def add(p, v, s=1.0):
    return (p[0] + v[0] * s, p[1] + v[1] * s)


def f(x):
    return f'{x:.2f}'


# ------------------------------------------------------------------ geometry (1000 x 1000 emblem space)

TILT = 7.0              # lean of the hand (deg, clockwise)
C = (500.0, 606.0)      # palm centre
WRIST = (500.0, 742.0)  # wrist joint
POOL = (500.0, 806.0)   # pool of light under the wrist
ARC_R = 438.0           # crystals sit on this circle around C

FINGERS = [
    # name, MCP (knuckle), heading (deg), phalanx lengths, width at knuckle -> tip
    ('index', (449.0, 506.0), -12.0, (100, 60, 41), (31.0, 31.0)),
    ('middle', (495.0, 495.0), -2.5, (111, 66, 43), (32.0, 32.0)),
    ('ring', (539.0, 503.0), 7.0, (104, 62, 41), (30.0, 30.0)),
    ('pinky', (577.0, 522.0), 17.0, (82, 49, 35), (26.5, 26.5)),
]
FAN = {'index': -1.6, 'middle': -0.4, 'ring': 0.8, 'pinky': 1.8}  # extra heading per joint (open, relaxed fan)
THUMB_CMC = (452.0, 690.0)
THUMB = ('thumb', THUMB_CMC, -55.0, (68, 52, 40), (33.0, 33.0))


def chain(start, heading, lengths, fan):
    pts = [start]
    h = heading
    for L in lengths:
        h += fan
        pts.append(add(pts[-1], d(h), L))
    return pts, h


def finger_geometry():
    out = []
    for name, mcp, heading, lengths, widths in FINGERS:
        pts, h = chain(mcp, heading, lengths, FAN[name])
        meta = (WRIST[0] + (mcp[0] - WRIST[0]) * 0.22, WRIST[1] + (mcp[1] - WRIST[1]) * 0.22)
        out.append({'name': name, 'meta': meta, 'joints': pts, 'heading': h, 'widths': widths})
    name, cmc, heading, lengths, widths = THUMB
    pts, h = chain(cmc, heading, lengths, 6.0)
    out.insert(0, {'name': name, 'meta': None, 'joints': pts, 'heading': h, 'widths': widths})
    return out


def ray_circle(p, v, c, r):
    """Smallest t > 0 with |p + t v - c| = r."""
    ox, oy = p[0] - c[0], p[1] - c[1]
    b = ox * v[0] + oy * v[1]
    cc = ox * ox + oy * oy - r * r
    disc = b * b - cc
    return -b + math.sqrt(max(0.0, disc))


def palm_path():
    """Rounded palm: wrist -> thumb web -> knuckles -> pinky edge -> wrist."""
    pts = [(458, 744), (440, 690), (430, 600), (433, 522), (452, 506), (495, 497), (539, 505), (577, 523), (594, 541),
           (594, 605), (580, 682), (546, 744)]
    s = f'M {f(pts[0][0])} {f(pts[0][1])} '
    for p in pts[1:]:
        s += f'L {f(p[0])} {f(p[1])} '
    return s + 'Z'


def emblem_svg(size=1000, *, uid='e', background=True, arc=True, glow=1.0, margin=70):
    """The emblem as an <svg> element (viewBox 0..1000)."""
    fingers = finger_geometry()
    parts = []
    defs = []

    # --- body (union of palm + phalanges), used as a mask and as the edge source
    body = [f'<path d="{palm_path()}" fill="#fff" stroke="#fff" stroke-width="30" stroke-linejoin="round"/>']
    for fg in fingers:
        poly = ' '.join(f'{f(p[0])},{f(p[1])}' for p in fg['joints'])
        body.append(f'<polyline points="{poly}" fill="none" stroke="#fff" stroke-width="{f(fg["widths"][0])}" stroke-linecap="round" stroke-linejoin="round"/>')
    defs.append(f'<g id="{uid}-body">{"".join(body)}</g>')
    # Blur-and-threshold union: one smooth glass body with rounded webs between
    # the fingers (SVG morphology would square them off).
    goo = '''<feGaussianBlur in="SourceAlpha" stdDeviation="6.5" result="b"/>
      <feComponentTransfer in="b" result="goo"><feFuncA type="linear" slope="16" intercept="-7.2"/></feComponentTransfer>'''
    defs.append(f'''<filter id="{uid}-close" x="-10%" y="-10%" width="120%" height="120%">
      {goo}
      <feFlood flood-color="#fff"/><feComposite in2="goo" operator="in"/>
    </filter>''')
    defs.append(f'<mask id="{uid}-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="1000"><use href="#{uid}-body" filter="url(#{uid}-close)"/></mask>')
    # Glass edge: the closed body's outline (alpha minus its erosion), crisp + a whisper of glow.
    defs.append(f'''<filter id="{uid}-edge" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
      {goo}
      <feMorphology in="goo" operator="erode" radius="1.6" result="er"/>
      <feComposite in="goo" in2="er" operator="out" result="ring"/>
      <feFlood flood-color="#eaf3ff" flood-opacity="0.92"/>
      <feComposite in2="ring" operator="in" result="line"/>
      <feGaussianBlur in="line" stdDeviation="{f(3.2 * glow)}" result="soft"/>
      <feMerge><feMergeNode in="soft"/><feMergeNode in="soft"/><feMergeNode in="line"/></feMerge>
    </filter>''')
    defs.append(f'''<linearGradient id="{uid}-glass" x1="430" y1="300" x2="580" y2="760" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#cfe2ff" stop-opacity="0.16"/>
      <stop offset="0.55" stop-color="#9fb8e6" stop-opacity="0.07"/>
      <stop offset="1" stop-color="#ffe9c4" stop-opacity="0.20"/>
    </linearGradient>''')
    defs.append(f'''<radialGradient id="{uid}-heart" cx="500" cy="640" r="150" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff6e8" stop-opacity="0.42"/>
      <stop offset="0.45" stop-color="#fff1d6" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#fff1d6" stop-opacity="0"/>
    </radialGradient>''')
    defs.append(f'<filter id="{uid}-blur6" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="{f(6 * glow)}"/></filter>')
    defs.append(f'<filter id="{uid}-blur14" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="{f(14 * glow)}"/></filter>')
    defs.append(f'<filter id="{uid}-blur3" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="{f(2.4 * glow)}"/></filter>')

    if background:
        defs.append(f'''<radialGradient id="{uid}-bg" cx="500" cy="560" r="640" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#101626"/><stop offset="0.6" stop-color="#080b13"/><stop offset="1" stop-color="{BG}"/>
        </radialGradient>''')
        parts.append(f'<rect width="1000" height="1000" fill="url(#{uid}-bg)"/>')

    # --- crystals on the shared arc
    crystals = []
    for fg in fingers:
        tip = fg['joints'][-1]
        v = d(fg['heading'])
        t = ray_circle(tip, v, C, ARC_R)
        crystals.append((fg, tip, v, add(tip, v, t)))

    # --- reference arc and ticks (an instrument's scale, very quiet)
    if arc:
        angs = [math.degrees(math.atan2(p[0] - C[0], -(p[1] - C[1]))) for _, _, _, p in crystals]
        a0, a1 = min(angs) - 9, max(angs) + 9
        p0 = add(C, d(a0), ARC_R)
        p1 = add(C, d(a1), ARC_R)
        parts.append(f'<path d="M {f(p0[0])} {f(p0[1])} A {ARC_R} {ARC_R} 0 0 1 {f(p1[0])} {f(p1[1])}" fill="none" stroke="#c9d6f2" stroke-opacity="0.16" stroke-width="1.1" stroke-dasharray="1.5 7" stroke-linecap="round"/>')
        for a in [a0, a1]:
            q0 = add(C, d(a), ARC_R - 7)
            q1 = add(C, d(a), ARC_R + 7)
            parts.append(f'<line x1="{f(q0[0])}" y1="{f(q0[1])}" x2="{f(q1[0])}" y2="{f(q1[1])}" stroke="#c9d6f2" stroke-opacity="0.28" stroke-width="1.1"/>')

    # --- pool of light under the wrist
    defs.append(f'''<radialGradient id="{uid}-pool" cx="{POOL[0]}" cy="{POOL[1]}" r="140" gradientTransform="translate(0 {POOL[1]}) scale(1 0.3) translate(0 {-POOL[1]})" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{WARM}" stop-opacity="0.95"/>
      <stop offset="0.35" stop-color="#ffd9a0" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#ffd9a0" stop-opacity="0"/>
    </radialGradient>''')
    defs.append(f'''<linearGradient id="{uid}-shaft" x1="0" y1="{POOL[1]}" x2="0" y2="{WRIST[1] - 40}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{WARM}" stop-opacity="0.55"/><stop offset="1" stop-color="{WARM}" stop-opacity="0"/>
    </linearGradient>''')
    parts.append(f'<ellipse cx="{POOL[0]}" cy="{POOL[1]}" rx="150" ry="45" fill="url(#{uid}-pool)"/>')
    for rx, op in [(118, 0.30), (84, 0.48), (52, 0.75)]:
        parts.append(f'<ellipse cx="{POOL[0]}" cy="{POOL[1]}" rx="{rx}" ry="{f(rx * 0.27)}" fill="none" stroke="{WARM}" stroke-opacity="{op}" stroke-width="1.4"/>')
    parts.append(f'<rect x="{POOL[0] - 26}" y="{WRIST[1] - 40}" width="52" height="{POOL[1] - WRIST[1] + 40}" fill="url(#{uid}-shaft)" filter="url(#{uid}-blur6)"/>')

    hand_start = len(parts)
    # --- beams (glow + core), drawn under the glass
    for fg, tip, v, cp in crystals:
        col = COLORS[fg['name']]
        start = add(tip, v, 6)
        end = add(cp, v, -16)
        gid = f'{uid}-beam-{fg["name"]}'
        defs.append(f'''<linearGradient id="{gid}" x1="{f(start[0])}" y1="{f(start[1])}" x2="{f(end[0])}" y2="{f(end[1])}" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#ffffff" stop-opacity="0.95"/><stop offset="0.18" stop-color="{col}" stop-opacity="1"/><stop offset="1" stop-color="{col}" stop-opacity="0.9"/>
        </linearGradient>''')
        parts.append(f'<line x1="{f(start[0])}" y1="{f(start[1])}" x2="{f(end[0])}" y2="{f(end[1])}" stroke="{col}" stroke-opacity="0.55" stroke-width="9" stroke-linecap="round" filter="url(#{uid}-blur6)"/>')
        parts.append(f'<line x1="{f(start[0])}" y1="{f(start[1])}" x2="{f(end[0])}" y2="{f(end[1])}" stroke="url(#{gid})" stroke-width="2.2" stroke-linecap="round"/>')

    # --- glass body (its wrist dissolves into the column of light)
    defs.append(f'''<linearGradient id="{uid}-fadeg" x1="0" y1="{WRIST[1] - 70}" x2="0" y2="{WRIST[1] + 6}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/>
    </linearGradient>''')
    defs.append(f'<mask id="{uid}-fade" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="1000"><rect width="1000" height="1000" fill="url(#{uid}-fadeg)"/></mask>')
    parts.append(f'<g mask="url(#{uid}-fade)"><rect width="1000" height="1000" fill="url(#{uid}-glass)" mask="url(#{uid}-mask)"/>'
                 f'<rect width="1000" height="1000" fill="url(#{uid}-heart)" mask="url(#{uid}-mask)"/></g>')

    # --- fibre cores: white light from the wrist, coloured toward each tip
    for fg in fingers:
        col = COLORS[fg['name']]
        js = fg['joints']
        pts = [WRIST] + ([fg['meta']] if fg['meta'] else []) + js
        poly = ' '.join(f'{f(p[0])},{f(p[1])}' for p in pts)
        gid = f'{uid}-core-{fg["name"]}'
        tip = js[-1]
        defs.append(f'''<linearGradient id="{gid}" x1="{f(WRIST[0])}" y1="{f(WRIST[1])}" x2="{f(tip[0])}" y2="{f(tip[1])}" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#fff6e8" stop-opacity="0.85"/><stop offset="0.45" stop-color="#fff6e8" stop-opacity="0.75"/><stop offset="1" stop-color="{col}" stop-opacity="1"/>
        </linearGradient>''')
        parts.append(f'<polyline points="{poly}" fill="none" stroke="{col}" stroke-opacity="0.32" stroke-width="7" stroke-linejoin="round" stroke-linecap="round" filter="url(#{uid}-blur3)"/>')
        parts.append(f'<polyline points="{poly}" fill="none" stroke="url(#{gid})" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>')

    # --- glass edge on top
    parts.append(f'<g mask="url(#{uid}-fade)"><use href="#{uid}-body" filter="url(#{uid}-edge)"/></g>')
    # --- the 25 joints
    nodes = [(WRIST, 5.0, '#eaf3ff')]
    for fg in fingers:
        col = COLORS[fg['name']]
        if fg['meta']:
            nodes.append((fg['meta'], 3.0, '#eaf3ff'))
        for i, p in enumerate(fg['joints']):
            last = i == len(fg['joints']) - 1
            nodes.append((p, 4.4 if last else 3.4, col if last else '#eaf3ff'))
    assert len(nodes) == 25, len(nodes)
    for p, r, col in nodes:
        parts.append(f'<circle cx="{f(p[0])}" cy="{f(p[1])}" r="{f(r)}" fill="#0b0f19" fill-opacity="0.9" stroke="{col}" stroke-opacity="0.95" stroke-width="1.3"/>')

    # --- crystals
    for fg, tip, v, cp in crystals:
        col = COLORS[fg['name']]
        u = v
        n = (-u[1], u[0])
        apex = add(cp, u, 24)
        back = add(cp, u, -15)
        left = add(cp, n, 11)
        right = add(cp, n, -11)
        parts.append(f'<circle cx="{f(cp[0])}" cy="{f(cp[1])}" r="30" fill="{col}" fill-opacity="0.38" filter="url(#{uid}-blur14)"/>')
        poly = ' '.join(f'{f(p[0])},{f(p[1])}' for p in (apex, left, back, right))
        parts.append(f'<polygon points="{poly}" fill="{col}" fill-opacity="0.9" stroke="#ffffff" stroke-opacity="0.85" stroke-width="1.1" stroke-linejoin="round"/>')
        # facets: a lighter face and the ridge
        face = ' '.join(f'{f(p[0])},{f(p[1])}' for p in (apex, left, cp))
        parts.append(f'<polygon points="{face}" fill="#ffffff" fill-opacity="0.45"/>')
        parts.append(f'<line x1="{f(apex[0])}" y1="{f(apex[1])}" x2="{f(back[0])}" y2="{f(back[1])}" stroke="#ffffff" stroke-opacity="0.7" stroke-width="0.9"/>')
        parts.append(f'<line x1="{f(left[0])}" y1="{f(left[1])}" x2="{f(right[0])}" y2="{f(right[1])}" stroke="#ffffff" stroke-opacity="0.35" stroke-width="0.8"/>')
        if arc:
            q0 = add(cp, (cp[0] - C[0], cp[1] - C[1]), 34 / ARC_R)
            q1 = add(cp, (cp[0] - C[0], cp[1] - C[1]), 46 / ARC_R)
            parts.append(f'<line x1="{f(q0[0])}" y1="{f(q0[1])}" x2="{f(q1[0])}" y2="{f(q1[1])}" stroke="{col}" stroke-opacity="0.7" stroke-width="1.3" stroke-linecap="round"/>')

    # The hand, its beams and crystals lean TILT degrees about the wrist; the pool stays level.
    hand = parts[hand_start:]
    del parts[hand_start:]
    parts.append(f'<g transform="rotate({TILT} {WRIST[0]} {WRIST[1]})">{"".join(hand)}</g>')
    arc_parts = [p for p in parts[:hand_start] if 'stroke-dasharray' in p or 'stroke-opacity="0.28"' in p]
    for a in arc_parts:
        parts.remove(a)
    parts.insert(1 if background else 0, f'<g transform="rotate({TILT} {WRIST[0]} {WRIST[1]})">{"".join(arc_parts)}</g>')

    def tilt(p):
        a = math.radians(TILT)
        x, y = p[0] - WRIST[0], p[1] - WRIST[1]
        return (WRIST[0] + x * math.cos(a) - y * math.sin(a), WRIST[1] + x * math.sin(a) + y * math.cos(a))

    # Fit: bounds of crystals (with halos), the hand and the pool, centred with a margin.
    cps = [tilt(cp) for *_, cp in crystals]
    xs = [p[0] for p in cps] + [tilt((430, 600))[0], tilt((594, 540))[0], POOL[0] - 150, POOL[0] + 150]
    ys = [p[1] for p in cps] + [POOL[1] + 45]
    x0, x1 = min(xs) - 40, max(xs) + 40
    y0, y1 = min(ys) - 52, max(ys)
    k = min(1.0, (1000 - 2 * margin) / max(x1 - x0, y1 - y0))
    tx = 500 - k * (x0 + x1) / 2
    ty = 500 - k * (y0 + y1) / 2
    bg = parts.pop(0) if background else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="{size}" height="{size}">'
            f'<defs>{"".join(defs)}</defs>{bg}<g transform="translate({f(tx)} {f(ty)}) scale({k:.4f})">{"".join(parts)}</g></svg>')


# ------------------------------------------------------------------ pages

def font_face(family, file):
    return f"@font-face {{ font-family: '{family}'; src: url('file://{FONTS / file}'); }}"


FONT_CSS = '\n'.join([
    font_face('Outfit', 'Outfit-Regular.ttf'),
    font_face('Jura', 'Jura-Light.ttf'),
    font_face('GeistMono', 'GeistMono-Regular.ttf'),
])


def page(body, w, h, bg=BG):
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>
{FONT_CSS}
html, body {{ margin: 0; width: {w}px; height: {h}px; background: {bg}; overflow: hidden; }}
.word {{ font-family: 'Outfit'; color: #f3f5fa; letter-spacing: 0.30em; font-weight: 400; line-height: 1; white-space: nowrap; }}
.mono {{ font-family: 'GeistMono'; color: #9aa6bf; letter-spacing: 0.32em; text-transform: uppercase; white-space: nowrap; line-height: 1; }}
.dim {{ color: #69728a; }}
.rule {{ height: 1px; background: linear-gradient(90deg, rgba(201,214,242,0), rgba(201,214,242,0.35), rgba(201,214,242,0)); }}
</style></head><body>{body}</body></html>'''


def wordmark(size):
    """HANDCAST with the tracking compensated, so the word stays optically centred."""
    return f'<span class="word" style="font-size:{size}px; margin-right:-0.30em">HANDCAST</span>'


def emblem_page(size=1024, background=True):
    bg = BG if background else 'transparent'
    return page(f'<div style="width:{size}px;height:{size}px">{emblem_svg(size, uid="m", background=background)}</div>', size, size, bg)


def lockup_page(w=1600, h=560, background=True):
    bg = BG if background else 'transparent'
    em = emblem_svg(520, uid='l', background=False)
    body = f'''<div style="position:absolute;left:40px;top:20px;width:520px;height:520px">{em}</div>
    <div style="position:absolute;left:600px;top:0;height:{h}px;display:flex;flex-direction:column;justify-content:center;gap:34px">
      {wordmark(118)}
      <div class="rule" style="width:860px"></div>
      <span class="mono" style="font-size:22px">Your hand is the optic</span>
    </div>'''
    return page(body, w, h, bg)


def card_page(kind, url=''):
    w, h = 1280, 720
    if kind == 'title':
        body = f'''<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%, #121a2c 0%, #090c15 55%, {BG} 100%)"></div>
        <div style="position:absolute;left:{(w - 500) // 2}px;top:24px;width:500px;height:500px">{emblem_svg(500, uid="t", background=False, margin=40)}</div>
        <div style="position:absolute;left:0;right:0;top:486px;display:flex;flex-direction:column;align-items:center;gap:20px">
          {wordmark(74)}
          <div class="rule" style="width:520px"></div>
          <span class="mono" style="font-size:16px;margin-right:-0.32em">Your hand, frozen into glass, is the only optic</span>
        </div>
        <div style="position:absolute;left:0;right:0;bottom:30px;display:flex;justify-content:center">
          <span class="mono dim" style="font-size:11px;margin-right:-0.32em">Hands-first mixed reality &middot; captured in the IWER Meta Quest 3 emulator</span>
        </div>'''
    else:
        link = f'<span class="mono" style="font-size:17px;color:#b9c7ff;margin-right:-0.32em">Play on Meta Quest &middot; {url}</span>' if url else ''
        body = f'''<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%, #111827 0%, #090c15 55%, {BG} 100%)"></div>
        <div style="position:absolute;left:{(w - 380) // 2}px;top:18px;width:380px;height:380px">{emblem_svg(380, uid="n", background=False, margin=40)}</div>
        <div style="position:absolute;left:0;right:0;top:405px;display:flex;flex-direction:column;align-items:center;gap:20px">
          {wordmark(66)}
          <div class="rule" style="width:560px"></div>
          <span class="mono" style="font-size:15px;margin-right:-0.32em">Seated &middot; Hands only &middot; Passthrough &middot; Every crystal is a note</span>
          <span class="mono dim" style="font-size:13px;margin-right:-0.32em">49 boards &middot; Daily &middot; Kiln &middot; Studio &middot; Hall of Hands</span>
          <div style="height:10px"></div>
          {link}
        </div>'''
    return page(body, w, h)


def thumbnail_page(w=1500, h=1000):
    """Devpost thumbnail (3:2): emblem over the wordmark, centred."""
    body = f'''<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 42%, #121a2c 0%, #090c15 55%, {BG} 100%)"></div>
    <div style="position:absolute;left:{(w - 700) // 2}px;top:34px;width:700px;height:700px">{emblem_svg(700, uid="b", background=False, margin=40)}</div>
    <div style="position:absolute;left:0;right:0;top:700px;display:flex;flex-direction:column;align-items:center;gap:26px">
      {wordmark(104)}
      <div class="rule" style="width:640px"></div>
      <span class="mono" style="font-size:22px;margin-right:-0.32em">Your hand is the optic</span>
    </div>'''
    return page(body, w, h)


def render(html, out_png, w, h, transparent=False):
    tmp = OUT / f'.{out_png.stem}.html'
    tmp.write_text(html)
    # Playwright gives an exact viewport (headless Chromium's --window-size includes browser chrome).
    subprocess.run(['node', str(Path(__file__).with_name('render.mjs')), str(tmp), str(out_png), str(w), str(h), '1' if transparent else '0'],
                   check=True, cwd=ROOT)
    tmp.unlink()
    print('wrote', out_png.relative_to(ROOT))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    url = sys.argv[1] if len(sys.argv) > 1 else 'mghprojects.github.io/Devpost'
    render(emblem_page(1024, True), OUT / 'handcast-emblem.png', 1024, 1024)
    render(emblem_page(1024, False), OUT / 'handcast-emblem-transparent.png', 1024, 1024, transparent=True)
    render(lockup_page(1600, 560, True), OUT / 'handcast-logo.png', 1600, 560)
    render(lockup_page(1600, 560, False), OUT / 'handcast-logo-transparent.png', 1600, 560, transparent=True)
    render(thumbnail_page(), OUT / 'handcast-thumbnail.png', 1500, 1000)
    render(card_page('title'), OUT / 'card-title.png', 1280, 720)
    render(card_page('end', url), OUT / 'card-end.png', 1280, 720)


if __name__ == '__main__':
    main()
