# HANDCAST: kit de entrega (Devpost + YouTube + Meta)

Todo listo para pegar. Los textos van en inglés (idioma de la competición). Devpost deja editar
el proyecto hasta el cierre (18 nov 2026, 12:00 PST), así que **guárdalo y envíalo ya**: se
puede seguir editando después de enviarlo hasta la fecha límite.

Archivos:
- Vídeo: `media/handcast-trailer-remotion.mp4` (75 s, 1080p).
- Miniatura (3:2): `media/brand/handcast-thumbnail.png`.
- Galería (3:2, 1500×1000, capturas reales del Quest 3): `media/gallery/01.jpg` … `09.jpg`.
- Logo: `media/brand/handcast-logo.png`.

---

## 1. YouTube (primero, porque Devpost pide el enlace)

1. studio.youtube.com > **Crear > Subir vídeos** > `handcast-trailer-remotion.mp4`.
2. **Título:**
   `HANDCAST: your hand is the puzzle piece (Meta Quest 3, hand tracking, WebXR)`
3. **Descripción:**

```
Hold still and your hand turns to glass. Your frozen pose is the puzzle piece: it bends light on your real table.

HANDCAST is a mixed-reality puzzle game for Meta Quest, played with your hands only, in the Meta Quest Browser. Rest your hand in a pool of light, hold still, and molten glass sets into an exact copy of your pose. Slide your hand out: the glass stays. An open hand fans the light, a hand on its edge mirrors it, a fist stops it. Light every crystal in its exact colour and the board plays its song.

Play: https://mghprojects.github.io/Devpost/ (Meta Quest Browser, hand tracking on, seated at a table)

Real gameplay, captured on Meta Quest 3. No controllers.
Entry for the Meta VR Start Developer Competition 2026.
```

4. **Miniatura:** `media/brand/handcast-thumbnail.png`.
5. Audiencia: "No, no es contenido para niños".
6. Visibilidad: **Pública**. Copia el enlace.

## 2. Devpost: campos del proyecto

### Project name
```
HANDCAST
```

### Elevator pitch / tagline
```
Hold still and your hand turns to glass. Your frozen pose is the puzzle piece: it bends light on your real table.
```

### Thumbnail
`media/brand/handcast-thumbnail.png`

### About the project (Markdown)

```markdown
## Inspiration
Hand-shadow puzzles make you hold one hand perfectly still while the other does the work. We wanted the opposite: freeze the pose, and the pose becomes an object you can move, knock over, play and share. With hand tracking precise enough to save a pose, the body itself becomes the game piece.

## What it does
Rest your hand in a pool of light on your real table and hold still. Molten glass flows over your fingers and freezes into an exact copy of your pose. Slide your hand out: the glass stays, and its shape decides what it does to light. An open hand fans it, a flat hand on its edge mirrors it, a fist stops it. Light every crystal in its exact colour and keep the hush stones dark. Each crystal your glass holds lit adds its own voice to a beat-locked song in the board's key; a solved board plays the whole arrangement. There are no mirrors to pick up. Your hand is the piece.

- **Hands-first, end to end.** No controller anywhere: cast by holding still, pinch a glass hand's foot to slide and twist it, knock it over with a fist to get the glass back, strum its fingers.
- **Your real table is the play surface.** Plane detection or a depth hit-test puts a ghost hand on your table; your resting hand confirms it and the bench pours out from under your palm, flush with the tabletop and anchored for next time. Your real hand is drawn in front of the light.
- **Content and coming back.** 49 boards in seven chapters, a Daily with a streak, endless Kiln boards, and a Studio where you build a board by casting its answer and share it to the Hall of Hands. Hint shows the light path first, the hand only second.
- **Accessible.** Seated, one hand is enough, Steady mode, large-text high-contrast HUD, colour letters on every crystal.

## How we built it
Immersive Web SDK (WebXR, three.js, ECS) with a 2D light tracer. Boards come from a solution-first generator and validator (solvable, wobble-robust, every hand needed); an end-to-end suite casts all 49 boards through emulated hand tracking. Every sound is synthesised live with Web Audio and placed on the bench in 3D; the score is adaptive.

## Challenges we ran into
Reading intent from tracked hands: a fingertip hidden behind another finger is only the tracker's guess, so it must read clearly straight to count; only light-carrying fingers must hold still (7 mm palm, 12 mm tips); short tracking gaps keep the hold. Making the real hand cover the virtual bench in passthrough, and holding a steady 72 Hz on Quest 3.

## Accomplishments that we're proud of
A puzzle mechanic that only exists with hands: controllers have no fingers to open or curl. The first five minutes teach the one gesture without words: a ghost hand on your real table, the bench pouring out of your palm, a ghost fist that knocks over a dead-end cast and refunds it.

## What we learned
Players trust a pose they can see. Freezing exactly the fingers the live hand showed, and giving the glass back with a knock, made experimentation free.

## What's next for HANDCAST
Ink that stains a finger, two hands touching to fuse glass, and a Meta Horizon Store release as a PWA (target Q1 2027).
```

### Built with (etiquetas)
```
webxr, immersive-web-sdk, three.js, typescript, vite, web-audio-api, hand-tracking, mixed-reality, passthrough, meta-quest, github-pages, remotion
```

### Try it out (enlaces)
- `https://mghprojects.github.io/Devpost/`
- `https://github.com/MGHProjects/Devpost`

### Video demo link
El enlace de YouTube del paso 1.

### Image gallery
Sube `media/gallery/01.jpg` … `09.jpg` en ese orden (la 01, rayos amarillos, es la mejor portada).

## 3. Devpost: preguntas de la competición

**Track:** Gaming · **Division:** New Experience.

**Testing instructions:**
```
Open https://mghprojects.github.io/Devpost/ in the Meta Quest Browser, turn hand tracking on and put the controllers down, sit at a table and tap Enter XR (allow the Spatial permission if asked, so the headset can see the table). Rest a flat hand on the table: the bench pours out from under your palm. Menu > TOUR plays six boards that show the range in about ten minutes.
```

**How hand interactions are implemented (campo opcional):** copia la sección
"How hand interactions are implemented" de `SUBMISSION.md` tal cual.

**What excites you about the future of VR:**
```
Hand tracking is now precise enough that a pose can be saved, shared and replayed. That makes the body itself a material for games and tools, not just a pointer.
```

**Special awards (si hay campo):** copia "Fit with the special awards" de `SUBMISSION.md`.

**Target launch date:**
```
Q1 2027, Meta Horizon Store (as a PWA)
```

**Team:** tu nombre, email y rol (p. ej. "Solo developer: design, code, audio, video").

## 4. Meta

1. **Meta VR Start:** comprueba que tu membresía y el "Developer Access" están activos (la
   competición los exige). Si falta algo, el propio panel lo indica.
2. **developers.meta.com:** si te piden la organización/app, crea una app tipo
   "Web/PWA" llamada HANDCAST con la URL `https://mghprojects.github.io/Devpost/`
   y la miniatura y el logo de `media/brand/`. No hace falta publicarla en la tienda para la competición.

## 5. Antes de pulsar Submit

- [ ] El vídeo de YouTube es público y se reproduce sin sesión iniciada.
- [ ] La web abre en el Quest Browser (si vuelves a desplegar la música nueva, pruébala con `PRUEBA-QUEST3-3.md` y vuelve a poner `HANDCAST_FROZEN=1`).
- [ ] Thumbnail, galería, enlaces y Built with rellenos.
- [ ] Team y fecha de lanzamiento completados.
- [ ] Submit. Se puede seguir editando hasta el 18 nov, 12:00 PST.
