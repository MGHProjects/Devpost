# Devpost: HANDCAST para la Meta VR Start Developer Competition 2026

## Qué es HANDCAST

Un puzzle de realidad mixta para Meta Quest que se juega solo con las manos,
sentado a una mesa, en el navegador de las Quest (WebXR, Immersive Web SDK).
Tu propia mano es la única pieza óptica: sobre tu mesa real aparece un banco de
cristal con lámparas y charcos de luz. Pones la mano en la luz con una forma
concreta y te quedas quieto; el cristal fundido la recubre y se solidifica en
una copia de cristal de esa postura exacta (25 articulaciones). Sacas la mano y
el cristal se queda. La luz que entra por un extremo abierto de una mano de
cristal (muñeca, palma en un charco o un dedo extendido) sale por todos los
demás dedos abiertos. Hay que iluminar cristales con un color exacto (los
colores se suman) sin tocar las piedras de silencio.

Contenido: 49 tableros en 7 capítulos, un tablero diario igual para todos
("One Hand"), el Horno (tableros generados sin fin), el Estudio (creas
tableros con las manos) y el Hall of Hands (compartes tableros y ves las manos
de cristal de otros jugadores). Detalles en
[`handcast/README.md`](handcast/README.md); texto del formulario en
[`handcast/SUBMISSION.md`](handcast/SUBMISSION.md).

## Por qué este concurso y por qué este proyecto

- **Concurso.** De los hackathons abiertos en Devpost (revisados el 8 oct),
  este tiene con diferencia el mayor premio en efectivo: 1.000.000 $ en 20
  premios. Para Gaming / New Experience: 100.000 $ al ganador y 50.000 $ al
  segundo, y además seis premios especiales de 25.000 $ (Boldest Original
  Concept, Best First Five Minutes, Best Reason to Come Back, Best
  Accessibility Forward Experience, entre otros) y dos Judge's Choice de
  20.000 $. Admite proyectos WebXR publicados en GitHub Pages y vídeo grabado
  en emulador.
- **Cambio de proyecto.** La primera idea, *Prism Song* (llevar rayos de luz
  con espejos que coges con la mano), se abandonó porque ese juego ya existe:
  Lumen Lab VR salió en la Horizon Store en septiembre de 2026 con casi la misma
  propuesta, y hay otros parecidos (LaserBlaze, Labyrinth deLux, Carpe Lucem).
  No encontramos ningún juego publicado en el que la postura real de tu mano se
  congele en una pieza que es el puzzle. Además no se puede jugar con mandos,
  que encaja con el requisito "hands-first".

## Estado (16 oct 2026, tarde)

- Re-análisis para ganar (reglas 2026, campo rival, ganadores de 2025,
  capacidades de Quest Browser y una auditoría con ojos de juez):
  **mantener la idea y ampliarla** donde la mano real toca la mesa real.
  Objetivo: Best New Gaming Experience (100k / 50k). Congelar el 15 nov,
  enviar el 16.
- Hecho hoy, todo probado en el emulador:
  - **Tu mano real delante de la luz** en passthrough (antes el banco se
    pintaba encima de tu mano).
  - **Mesa real:** el visor busca la mesa (planos o hit-test) y una mano de
    cristal fantasma te enseña dónde apoyar la tuya; el banco **sale de tu
    palma** con un arpegio y queda a ras del plano detectado.
  - **Prólogo sin texto:** el tablero 1 enseña el gesto con una mano
    fantasma; la pista es progresiva (primero el camino de la luz, luego la
    mano); un cristal sin salida lo derriba un puño fantasma y te lo devuelve.
  - **HUD oscuro**, fichas de color con letra por cristal, menú compacto,
    modo **Large text** de alto contraste y fila **TOUR** (6 tableros para
    los jueces).
  - Pide **90 Hz** y baja a 72 si no llega; **pausa** con el menú del sistema.
  - `?perf=1`: panel de rendimiento en XR e informe al salir.
    `?capture`: modo de grabación (panel solo al mirarlo, `board=`/`tour=`,
    WAV con el sonido del juego).
  - La web **no se vuelve a publicar después del plazo** (o si pones la
    variable `HANDCAST_FROZEN=1`).
- Pruebas: 325 tests unitarios; end-to-end 21/21 (XR), 11/11 (Studio y
  Hall), 4/4 (mesa), 3/3 (captura) y 49/49 tableros de la campaña.
- **Aún no se ha probado en unas Quest reales.** Es lo más importante ahora:
  guion en [`PRUEBA-QUEST3.md`](PRUEBA-QUEST3.md).
- El backend del Hall está escrito y probado, pero no desplegado.
- El vídeo actual (`handcast/media/handcast-demo.mp4`) es solo del emulador;
  el plan es regrabarlo con tus Quest.

## Lo que tienes que hacer tú

Fecha límite: **18 nov 2026, 12:00 PST = 21:00 hora peninsular**.

### a) GitHub Pages (ya está activo; revísalo solo si falla un despliegue)

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Settings → Environments → github-pages → Deployment branches:** permite
   la rama `claude/clever-bell-ohs0lz`, o fusiona la rama en `main`.
3. Para volver a publicar a mano: **Actions → Deploy Handcast to GitHub
   Pages → Run workflow**.

### b) Probarlo en tus Meta Quest 3 (18–19 oct)

Sigue el guion de [`PRUEBA-QUEST3.md`](PRUEBA-QUEST3.md) (60 minutos) con
https://mghprojects.github.io/Devpost/?perf=1 y pégame el informe que sale al
terminar. Para grabar clips: https://mghprojects.github.io/Devpost/?capture
(añade `&tour=6` para abrir directamente *Count to Ten*).

### c) Opcional: backend del Hall of Hands

Sin backend el Hall funciona sin conexión: tableros destacados incluidos en el
juego, los tableros creados en ese dispositivo y enlaces para compartir
(`#l=...`). Con backend se ven tableros nuevos y populares de otros jugadores y
sus manos de cristal. Pasos (detalle en
[`handcast/community/worker/README.md`](handcast/community/worker/README.md)).
Necesitas una cuenta gratuita de Cloudflare y Node 20 o superior, y hay que
desplegar desde una copia completa del repositorio porque el Worker importa
código de `handcast/src/core`:

```bash
npm i -g wrangler
cd handcast/community/worker
wrangler login                       # abre el navegador
wrangler d1 create handcast-hall     # imprime un database_id
```

1. Copia el `database_id` en `wrangler.toml` (sustituye
   `00000000-0000-0000-0000-000000000000`).
2. Crea las tablas y despliega:

   ```bash
   wrangler d1 execute handcast-hall --remote --file=./schema.sql
   wrangler secret put HASH_SALT        # obligatorio: cualquier texto largo aleatorio (sin él, el Worker no acepta escrituras)
   wrangler deploy                      # imprime https://handcast-hall.<tu-subdominio>.workers.dev
   curl https://handcast-hall.<tu-subdominio>.workers.dev/levels?sort=new   # -> {"entries":[],"cursor":null}
   ```

3. En GitHub: **Settings → Secrets and variables → Actions → Variables → New
   repository variable**, nombre `VITE_HANDCAST_API`, valor la URL del Worker
   sin barra final. El workflow ya pasa esa variable a la build.
4. Vuelve a lanzar el workflow (apartado a, paso 3) o haz un push.

`ALLOWED_ORIGIN` en `wrangler.toml` ya es `https://mghprojects.github.io`.

### d) Meta VR Start

1. Únete al programa **Meta VR Start** (unos 5 minutos) y activa
   **Developer Access** en tu cuenta de Meta. Sin esto no puedes enviar el
   proyecto.
2. En la página del concurso en Devpost pulsa **Join hackathon**.

### e) Vídeo y formulario de Devpost

1. El vídeo se regrabará con tus Quest (sesiones de captura del 1–2 y 8–9
   nov). Las reglas piden "gameplay real"; el vídeo actual del emulador queda
   como reserva. Súbelo a YouTube como vídeo **público**, menos de 3 minutos.
2. Rellena el formulario copiando [`handcast/SUBMISSION.md`](handcast/SUBMISSION.md).
   Faltan el enlace del vídeo, la fecha de lanzamiento prevista y el equipo
   (nombre, email y rol). Miniatura: `handcast/media/brand/handcast-thumbnail.png`;
   para la galería, fotogramas del vídeo.
3. Envía antes del **18 nov 2026 a las 21:00 (hora peninsular)**. Después del
   cierre no se puede cambiar el envío y se juzga el estado en esa fecha.
   El workflow ya se niega a publicar después del plazo; tras el último
   despliegue, crea la variable de repositorio `HANDCAST_FROZEN` = `1`
   (**Settings → Secrets and variables → Actions → Variables**) y mantén la URL
   accesible hasta el 11 dic.
