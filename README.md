# Devpost: hackathon elegido y proyecto

## 1. Investigación (8 oct 2026)

Descargué todos los hackathons abiertos o próximos de Devpost (135, API
`devpost.com/api/hackathons`, páginas 1–15) y los ordené por **premio en
efectivo**. Los candidatos realistas (online y con premio en efectivo
verificable):

| Hackathon | Efectivo | Nº premios | Cierre | Inscritos | Comentario |
| --- | ---: | ---: | --- | ---: | --- |
| **Meta VR Start Developer Competition 2026** | **$1.000.000** | **20** ($20k–$100k) | **18 nov** | 2.624 | Acepta WebXR (IWSDK) alojado en GitHub Pages; ~650 envíos el año pasado |
| Amazon Developer Hackathon | $138.000 | 12 | 23 oct | 51.940 | Exige Fire TV / Alexa+ / Bee / Ring; competencia enorme |
| PayPal AI Hackathon | $67.500 | 8 | 12 nov | 9.797 | Abierto, pero pocos premios para muchos inscritos |
| Nebius x NVIDIA Global AI | $50.000 | 6 | 30 oct | 19.994 | Exige créditos de Nebius Cloud |
| GitLab "Life After Code" | $45.000 | 9 | 27 oct | 1.298 | Exige GitLab Duo Agent Platform |
| AWS CDS Agentic AI | $40.000 | 4 | 28 oct | 805 | Orientado a partners de AWS |
| ForgeHacks Online | "$1.38M" | — | 10 oct | 2.918 | Casi todo son créditos o licencias; el efectivo real es mínimo y solo para estudiantes |

**Elegido: Meta VR Start Developer Competition 2026.** Tiene la mayor bolsa
en efectivo con diferencia, el mayor número de premios (20) y pocos envíos por
premio (~650 el año pasado, unos 30 por premio). Quedan 6 semanas de plazo, y
permite proyectos WebXR (Immersive Web SDK), que se pueden construir y probar
por completo en un emulador. Valor esperado estimado: un orden de magnitud por
encima de cualquier otra opción.

Reglas clave (de https://start-developer-competition-26.devpost.com/rules):

- Hay que ser **miembro del programa Meta VR Start** y tener una cuenta Meta con
  *Developer Access* cuando se envía. España no está excluida.
- Tracks: Entertainment, **Gaming** o Productivity. Divisiones: **New
  Experience** (creado desde el 24 sep 2026) o Adapted.
- Debe ser **"hands-first"**: jugable entero sin mando. Pensado para jugar sentado y
  con sesiones cortas.
- Hay que entregar el enlace jugable (GitHub Pages para IWSDK), un **vídeo de
  menos de 3 minutos** (vale grabado en emulador) y el formulario.
- Criterios (25 % cada uno): innovación, diseño de la experiencia, implementación
  técnica, pulido y presentación.

## 2. Proyecto: **Prism Song** (`prism-song/`)

Puzzle de mesa en **realidad mixta**, manos primero: pellizcas espejos, prismas,
semiespejos y filtros, los colocas y los giras con la muñeca para llevar haces de
luz de colores a cristales. Cada cristal es una nota y cada puzzle resuelto suena
como un acorde. Lo presento en **Gaming / New Experience** y también opta a los
premios especiales (First Five Minutes, Reason to Come Back, Accessibility,
Boldest Original Concept).

Detalles en [`prism-song/README.md`](prism-song/README.md) y el texto del
formulario en [`prism-song/SUBMISSION.md`](prism-song/SUBMISSION.md).

Estado:

- 24 puzzles en tres movimientos, más un **Daily Chord** diario con racha.
- Pellizcar y girar, toque con el dedo, rayo, mirada, mover la mesa con ancla
  espacial persistente, y audio espacial 100 % sintetizado.
- 31 tests unitarios y tests end-to-end con manos emuladas, todos en verde.
  Build de producción sin errores.
- Workflow de GitHub Pages en `.github/workflows/prism-song-pages.yml`.
- Vídeo de demo generado en el emulador. El script de grabación está en
  `prism-song/scripts/video/`.

## 3. Lo que tienes que hacer tú (antes del **18 nov 2026, 12:00 PST = 21:00 hora peninsular**)

1. **Únete al programa Meta VR Start** (unos 5 minutos) y activa *Developer Access*
   en tu cuenta Meta. Sin esto no puedes enviar.
2. Pulsa **Join hackathon** en la página de Devpost.
3. **Publica el juego**: haz merge de esta rama a `main` y activa *Settings → Pages
   → Source: GitHub Actions*. Si el repositorio es privado, GitHub Pages necesita
   un plan de pago; si no lo tienes, hazlo público o usa Vercel
   (`npx vercel deploy --prod` en `prism-song/`).
4. Si tienes unas Quest, abre la URL en el navegador de Quest y prueba (Enter XR).
5. **Sube el vídeo** (`prism-song-demo.mp4`) a YouTube como público.
6. Rellena el formulario con [`prism-song/SUBMISSION.md`](prism-song/SUBMISSION.md):
   faltan la URL, el enlace del vídeo, el equipo y la fecha de lanzamiento.
