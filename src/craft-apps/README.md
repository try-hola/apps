# craft-apps

Fifteen open-source creative apps, written in Rust and compiled to WebAssembly, served from one
Hola install with a landing page that links to each:

PhotoCraft (image editor) · VectorCraft (vector illustration) · FilmCraft (video) ·
LightCraft (photo library & raw) · PdfCraft (PDFs) · EffectCraft (motion graphics) ·
DesignCraft (page layout) · FigCraft (interface design) · TextureCraft (3D texture painting) ·
WordCraft (word processing) · SoundCraft (audio) · DeckCraft (presentations) ·
CADCraft (CAD & drafting) · GridCraft (spreadsheets) · Craft Anything

They are made by the storytold/ArtCraft team and community, licensed MIT OR Apache-2.0
(<https://github.com/storytold>). Hola is not affiliated with them. The ArtCraft name and logo are
the team's trademarks, so this bundle uses neither: it is "Craft Apps", with its own icon.

- **Image:** `ghcr.io/try-hola/craft-apps-web`, built from [`images/craft-apps/`](../../images/craft-apps/)
  by `.github/workflows/craft-apps-image.yml`.
- **Ingress:** port 8080. The landing page is at `/`, each app at `/<app>/` (`/gridcraft/`, …).
- **Storage:** none. Every app runs in the visitor's browser: Open reads a file from their device,
  Save and Export download one, and preferences live in the browser. LightCraft keeps its photo
  library in the browser's own storage (OPFS/IndexedDB), so clearing site data deletes it. There is
  nothing on the server to back up, and work does not follow a user to another device.
- **Browser:** WebGPU or WebGL2 (any current desktop browser). HTTPS, which Hola provides, is what
  enables WebGPU and OPFS.

## Auth

`forward-auth`. The apps have no login of their own; Authentik gates the whole site.

## Maturity

The upstream repos are about a month old (October 2026), release every day or two, and are labelled
"early alpha" / "in development". Expect rough edges.

## How the image is built and updated

[`images/craft-apps/`](../../images/craft-apps/):

| File | What it is |
|---|---|
| `lineup.json` | What the landing page says about each app (hand-written) |
| `apps.lock.json` | Each app's pinned web zip and its sha256 (written by `scripts/update.mjs`) |
| `scripts/build.mjs` | Downloads and verifies the zips, renders the landing page, precompresses → `dist/` |
| `scripts/smoke.mjs` | Opens every app in headless Chromium and fails on any that doesn't start |
| `landing/` | The landing page: HTML template, CSS, JS, self-hosted fonts (SIL OFL) |
| `nginx.conf`, `Dockerfile` | nginx-unprivileged serving `dist/` |

**Weekly:** the workflow moves every pin to its app's latest release, rebuilds, and smoke-tests. A
release that doesn't start is put back to its previous pin and named in the PR. The image is pushed
under a content-hash tag, pinned in `src/craft-apps/src/compose.yaml`, the bundle's patch version is
bumped, and a PR is opened. Close and reopen that PR to run the rest of CI (it is opened with
`GITHUB_TOKEN`).

**Holds:** an app whose new web builds are broken upstream gets a `hold` (with its reason) in
`apps.lock.json`, and stays on its last good release until the hold is removed by hand. PhotoCraft is
held at 0.16.0: its 0.17.0 and 0.18.0 web builds never finish loading
([storytold/photocraft#10590](https://github.com/storytold/photocraft/issues/10590)).

**Locally:**

```bash
cd images/craft-apps
node scripts/build.mjs                       # → dist/ (downloads cached in .cache/)
docker build -t craft-apps-web:local .
docker run --rm -p 8080:8080 craft-apps-web:local
npm install --no-save playwright && npx playwright install chromium
node scripts/smoke.mjs http://localhost:8080 # screenshots in smoke/
```

## Publish

```bash
./bin/push-oci-package.sh craft-apps ghcr.io/try-hola apps
```
