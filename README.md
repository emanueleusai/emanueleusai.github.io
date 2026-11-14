# emanueleusai.com

Personal academic website of Emanuele Usai, Assistant Professor of Physics at The University of Alabama.
Served by GitHub Pages from `master` with the custom domain in `CNAME`.

## Structure

No build step: plain HTML, CSS and ES modules.

| Path | What it is |
| --- | --- |
| `*.html` | One complete HTML file per page (`index`, `research`, `hardware`, `teaching`, `join`, `publications`, `cv`, `404`). They share the same header, footer and `<head>`. |
| `assets/css/site.css` | Design system and all styles. |
| `assets/js/main.js` | Boot: mobile menu, scroll reveals, and switching the 3D view per page and per section. |
| `assets/js/router.js` | Swaps only `<main>` when you follow an internal link, so the 3D scene keeps running between pages. |
| `assets/js/scene.js` | The live CMS event display (Three.js): collision replay, camera views and transitions. |
| `assets/js/hexaboard.js` | Procedural HGCAL silicon module, hexaboard and detector layer used on the Hardware page. |
| `models/` | Event display models (glTF). |
| `assets/img/` | Photos (resized, metadata stripped), logo, fallback and social preview images. |
| `talks/sesaps-2026/` | The slides of the SESAPS 2026 talk: a self-contained reveal.js and Three.js deck (`index.html`, `dist/`, `img/`), built elsewhere and copied here without its speaker notes and without the name labels on the team photo. It does not use the site's header, styles or router; links to it carry `data-no-router`. |

## 3D views

Each page sets `<main data-view="...">`. A section can switch the camera while it scrolls past the middle of the
screen with `data-scene="..."`. Views: `home`, `research`, `research-btag`, `research-top`, `research-side`,
`hardware`, `hardware-module`, `hardware-exploded`, `teaching`, `join`, `publications`, `cv`, `notfound`.

| View | What it shows |
| --- | --- |
| `home` | The camera starts at the collision point and pulls out while the event replays; this repeats every 15 seconds. |
| `join` | Three-quarter view with a slow drift. |
| `teaching` | Looking along the beam line. The event turns slowly on its own, but not with the page scroll. |
| `research` | The real event with its tracks clustered into jets (anti-kT, R = 0.4, run in the browser on the track data): the tracks take their jet's color in the order the algorithm merges them, and a cone marks each jet. |
| `research-btag`, `research-top` | An illustration, not CMS data: the jet of a fast top quark. Close up, the b hadron's flight to a second vertex (b tagging); from farther away, one wide jet with three cores (top tagging). The captions on the page say that it is an illustration. |
| `research-side` | Side view of the real event, with its jets and calorimeter deposits. |

## Editing content

Edit the page's HTML directly; keep the header and footer identical across pages. To add a page, copy an existing
one, change `<title>`, the description and canonical tags, and `data-view`, then add it to the nav in every page and
to `sitemap.xml`.

## Local preview

```
python3 -m http.server 8000
```

Then open http://localhost:8000/.
