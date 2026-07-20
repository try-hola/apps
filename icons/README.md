# App icons

App logos referenced by each package's `manifest.json` `icon` field (and therefore
by the generated [`catalog.json`](../catalog.json)). The Hola dashboard renders an
`icon` that is an image URL as a logo, falling back to an emoji/monogram.

These are served from this repo over the same origin as `catalog.json`:

```
https://raw.githubusercontent.com/try-hola/apps/main/icons/<name>.svg
```

Keeping our own copies (rather than hot-linking a third-party CDN) means icons
share the catalog's availability and don't add an external request to a service
we don't control.

## Sources

Logos are the trademarks of their respective projects, included here to identify
the apps they represent. SVGs were sourced from community icon sets:

- Most icons: [homarr-labs/dashboard-icons](https://github.com/homarr-labs/dashboard-icons)
- `homepage.svg`: [selfhst/icons](https://github.com/selfhst/icons)
- `webtop.svg`: dashboard-icons' `ubuntu-linux.svg`. The webtop package is a
  distro desktop rather than a branded product, so it carries the Ubuntu
  Circle of Friends (a Canonical trademark) to identify the distro it ships.
- `remo.svg`: upstream's own logo, copied verbatim from
  [get2knowio/remo](https://github.com/get2knowio/remo/blob/main/remo.svg).
  Unlike the rest of these it is a raster (a JPEG in an SVG wrapper, 1024²),
  hence the file size; it renders identically to a vector at the 34–60px the
  dashboard draws icons at.

## Adding / updating an icon

1. Drop `icons/<name>.svg` here (prefer SVG; match the package's `id`).
2. Set `"icon": "https://raw.githubusercontent.com/try-hola/apps/main/icons/<name>.svg"`
   in `src/<name>/src/manifest.json`.
3. Regenerate the index: `./bin/build-catalog.sh`.
