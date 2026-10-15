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

## Estado (15 oct 2026)

- El juego se puede jugar entero con las manos: campaña, Daily, Horno,
  Estudio y Hall of Hands.
- 307 tests unitarios (14 ficheros) en verde y 20 de 20 comprobaciones
  end-to-end con manos emuladas en el emulador IWER de Quest 3.
- **GitHub Pages ya funciona.** El workflow
  `.github/workflows/handcast-pages.yml` publica desde la rama
  `claude/clever-bell-ohs0lz`, y hoy https://mghprojects.github.io/Devpost/
  sirve HANDCAST (último despliegue: 9 oct). Cada push a esa rama o a `main`
  que toque `handcast/` vuelve a publicar.
- El backend del Hall (Cloudflare Worker + D1) está escrito y probado, pero no
  desplegado; la versión publicada usa el Hall sin conexión.
- No consta que se haya probado todavía en unas Quest reales.
- El vídeo de demo irá en `handcast/media/handcast-demo.mp4` y aún no está.
  Lo que hay ahora en `handcast/media/` (`prism-song-demo.mp4` y las capturas)
  es del proyecto anterior: no lo uses.

## Lo que tienes que hacer tú

Fecha límite: **18 nov 2026, 12:00 PST = 21:00 hora peninsular**.

### a) GitHub Pages (ya está activo; revísalo solo si falla un despliegue)

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Settings → Environments → github-pages → Deployment branches:** permite
   la rama `claude/clever-bell-ohs0lz`, o fusiona la rama en `main`.
3. Para volver a publicar a mano: **Actions → Deploy Handcast to GitHub
   Pages → Run workflow**.

### b) Probarlo en tus Meta Quest 3

1. Activa el seguimiento de manos en las Quest y deja los mandos.
2. Siéntate a una mesa y abre https://mghprojects.github.io/Devpost/ en el
   navegador de las Quest (Meta Quest Browser). Pulsa **Enter XR**.
3. Apoya una mano plana sobre la mesa (palma abajo, dedos rectos) y quédate
   quieto un segundo: el banco aparece bajo tu mano. Si hay que repetirlo:
   **Menu → Table**.
4. Primer tablero: pon la mano abierta en el charco de luz y quédate quieto
   hasta que se vuelva de cristal; luego saca la mano. Apunta cualquier cosa
   que falle.

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
   wrangler secret put HASH_SALT        # recomendado: cualquier texto largo aleatorio
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

1. Sube `handcast/media/handcast-demo.mp4` a YouTube (o Vimeo) como vídeo
   **público**. Debe durar menos de 3 minutos; las reglas aceptan imágenes del
   emulador.
2. Rellena el formulario copiando [`handcast/SUBMISSION.md`](handcast/SUBMISSION.md).
   Faltan el enlace del vídeo, la fecha de lanzamiento prevista y el equipo
   (nombre, email y rol). Para la galería usa capturas de HANDCAST, no las de
   Prism Song.
3. Envía antes del **18 nov 2026 a las 21:00 (hora peninsular)**. Después del
   cierre no se puede cambiar el envío y se juzga el estado en esa fecha: no
   hagas push que vuelva a publicar la web durante la evaluación, y mantén la
   URL accesible.
