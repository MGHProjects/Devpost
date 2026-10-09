# Hall of Hands backend (Cloudflare Worker + D1)

The optional community backend for HANDCAST. The game runs without it. Without
it, the Hall shows the curated shelf (`public/community/featured.json`), and
"publish" keeps levels in the player's "My creations" list and gives them a
share link (`#l=<code>`). With it, players can browse new and top levels, see
other players' glass hands, and like or report levels.

The Worker re-validates everything with the game's own pure modules
(`src/core/codec.ts`, `privacy.ts`, `moderation.ts`, which in turn use
`hand-features.ts` and `trace2d.ts`). Wrangler bundles them from the repo
through relative imports, so **always deploy from a full checkout of the repo**.

- A level is accepted only if its author's anonymised glass hands solve it
  within the hand budget. It is also rejected if it breaks the size limits
  (at most 12 hands and 24 crystals) or if a solution hand is the middle-finger
  gesture.
- Titles and author names are always generated ("Quiet Lantern" by "Amber
  Heron"). Players never type text that gets published.
- Hands are retargeted to canonical bone lengths before they are stored, so no
  hand-size biometric is kept. Device ids and IPs are stored only as salted
  SHA-256 hashes.

## Deploy (one time, about 5 minutes)

Prerequisites: a free Cloudflare account and Node 20 or newer.

```bash
npm i -g wrangler
cd handcast/community/worker
wrangler login                       # opens the browser
wrangler d1 create handcast-hall     # prints a database_id
```

Paste the printed `database_id` into `wrangler.toml` (replace the
`00000000-…` placeholder), then create the tables and deploy:

```bash
wrangler d1 execute handcast-hall --remote --file=./schema.sql
wrangler secret put HASH_SALT        # optional but recommended: any long random string
wrangler deploy                      # prints https://handcast-hall.<your-subdomain>.workers.dev
curl https://handcast-hall.<your-subdomain>.workers.dev/levels?sort=new   # -> {"entries":[],"cursor":null}
```

`schema.sql` is idempotent, so you can re-run it after schema changes.

### Point the game at it

The client reads `VITE_HANDCAST_API` at build time.

1. On GitHub, open the repo, then **Settings → Secrets and variables → Actions
   → Variables → New repository variable**. Name it `VITE_HANDCAST_API` and set
   the value to the Worker URL with no trailing slash, for example
   `https://handcast-hall.<your-subdomain>.workers.dev`. The URL is public, so a
   variable is enough; a secret also works if you prefer.
2. Pass it to the build step of `.github/workflows/handcast-pages.yml`:

   ```yaml
         - run: npm run build
           env:
             NODE_ENV: production
             VITE_HANDCAST_API: ${{ vars.VITE_HANDCAST_API }}   # or secrets.VITE_HANDCAST_API
   ```

3. Push, or re-run the Pages workflow.

The game passes `import.meta.env.VITE_HANDCAST_API` to `new HallClient(...)`.
When the variable is empty, the client stays offline.

### Allowed origins (CORS)

`ALLOWED_ORIGIN` in `wrangler.toml` is `https://mghprojects.github.io`, the
GitHub Pages origin (an origin has no path). `http(s)://localhost:*` and
`127.0.0.1` are always allowed for development. Requests from any other origin
cannot write (403), and browsers cannot read their responses. If you host the
game somewhere else, change `ALLOWED_ORIGIN` and run `wrangler deploy` again.

## Local development

```bash
cd handcast/community/worker
wrangler d1 execute handcast-hall --local --file=./schema.sql
wrangler dev                                   # http://localhost:8787
# in another shell, from handcast/:
VITE_HANDCAST_API=http://localhost:8787 npm run dev
```

The Worker tests run in Node against a fake D1 built on `node:sqlite` and the
real `schema.sql`. Run them from `handcast/` with
`npx vitest run tests/worker.test.ts`.

## API

Bodies are JSON. Every write needs an `X-Handcast-Device: <random id>` header;
the client generates the id and keeps it in localStorage. Errors come back as
`{ "error": "<code>", "message": "..." }` with a matching HTTP status
(400, 403, 404, 409, 413, 422, 429 or 500).

| Route | Body → Response |
| --- | --- |
| `GET /levels?sort=new\|top\|featured&cursor=&limit=` | → `{ entries: HallEntry[], cursor: string \| null }` (`limit` is at most 50) |
| `GET /levels/:id` | → `{ entry: HallEntry }` |
| `POST /levels` | `{ code }` (a level share code that includes the solution casts) → `201 { entry }`, or `200 { entry, existing: true }` for a board that is already published |
| `POST /levels/:id/solutions` | `{ casts: castCode[] }` → `{ rank, distinctHands, yourShare, solves, fingerprint }` |
| `GET /levels/:id/hands?limit=30` | → `{ hands: castCode[] }` (one per hand shape first, then the newest) |
| `POST /levels/:id/like` | → `{ liked, changed, likes }` (one per device) |
| `POST /levels/:id/report` | `{ reason: offensive\|broken\|spam\|other }` → `{ reported }` (hidden after 3 reports) |
| `GET /daily/:YYYY-MM-DD` | → `{ date, published, solutions, solvers, likes, mostSolved, pick }` |

`HallEntry` is `{ id, code, name, author, likes, solves, featured, createdAt }`.
The maker counts as the first solver of their own level, so a new level starts
at `solves: 1` and its maker's hands are the first ones in the Hall.

- `rank` is your order among the distinct players who solved the level
  (1 = first).
- `distinctHands` is the number of different hand shapes that solved it. Two
  solutions have the same shape when their open fingertips match and their
  finger headings round to the same 30-degree sector; where the hand sits and
  which hand it is do not count.
- `yourShare` is the fraction of solvers who used your shape.

Limits:

- Request bodies: 16 KB. Level codes: 6000 characters.
- Writes per hour, per device / per IP: publish 10 / 30, solutions 120 / 400,
  likes 200 / 600, reports 30 / 100.
- Requests per minute per IP: about 240, counted per isolate.

## Moderation

Run these from `handcast/community/worker`:

```bash
# Feature a level on the online "featured" shelf
wrangler d1 execute handcast-hall --remote --command "UPDATE levels SET featured = 1 WHERE id = 'u…'"
# Restore a level that reports hid
wrangler d1 execute handcast-hall --remote --command "UPDATE levels SET hidden = 0, reports = 0 WHERE id = 'u…'; DELETE FROM reports WHERE level_id = 'u…'"
# Remove a level for good
wrangler d1 execute handcast-hall --remote --command "DELETE FROM solutions WHERE level_id = 'u…'; DELETE FROM likes WHERE level_id = 'u…'; DELETE FROM reports WHERE level_id = 'u…'; DELETE FROM levels WHERE id = 'u…'"
```

## Costs

Typical traffic fits in the Workers and D1 free tiers. Verifying a solution
re-traces a small board and takes a few milliseconds of CPU.
