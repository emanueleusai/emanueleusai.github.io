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
| `assets/js/scene.js` | The live CMS event display (Three.js): collision replay, camera views and transitions. It also loads, on demand, the larger objects that only some views show ("props", see below). |
| `assets/js/hexaboard.js` | Procedural HGCAL silicon module (Hardware page), and the board textures and outlines that the endcap and the cassette reuse. |
| `assets/js/hgcal.js`, `hgcal-geom.js` | One HGCAL endcap with all its layers, and the layout numbers it is built from (Hardware page). |
| `assets/js/cassette.js` | One HGCAL cassette: modules on a cooling plate, with electronics and services (Hardware page). |
| `assets/js/transformer.js` | Illustration of a transformer classifying a jet (Research page). |
| `assets/js/classroom.js` | Three physics illustrations for the Teaching page: an electromagnetic wave, a spinning top and the electron cloud of a hydrogen atom. |
| `assets/js/globe.js`, `geo-data.js` | The globe of the CV page with the places of the CV, and its map data (Natural Earth). To add a second set of places, such as conferences, pass another data set like `CAREER` to `createGlobe`. |
| `assets/js/kit.js` | Shared 3D helpers: geometry builder, fading, glowing lines and dots, text labels. |
| `models/` | Event display models (glTF). |
| `assets/img/` | Photos (resized, metadata stripped), logo, fallback and social preview images. |
| `talks/sesaps-2026/` | The slides of the SESAPS 2026 talk: a self-contained reveal.js and Three.js deck (`index.html`, `dist/`, `img/`), built elsewhere and copied here without its speaker notes. The team photo keeps its first-name labels, at Emanuele's request (the site's own pages do not name people in photos). It does not use the site's header, styles or router; links to it carry `data-no-router`. |

## 3D views

Each page sets `<main data-view="...">`. A section can switch the camera while it scrolls past the middle of the
screen with `data-scene="..."`. Views: `home`, `research`, `research-btag`, `research-top`, `research-ai`,
`research-side`, `hardware`, `hardware-layers`, `hardware-cassette`, `hardware-module`, `hardware-exploded`,
`teaching`, `teaching-ph106`, `teaching-ph302`, `teaching-ph253`, `join`, `publications`, `cv`, `cv-globe`,
`notfound`.

| View | What it shows |
| --- | --- |
| `home` | The camera starts at the collision point and pulls out while the event replays; this repeats every 15 seconds. |
| `join` | Three-quarter view with a slow drift. |
| `teaching` | Looking along the beam line. The event turns slowly on its own, but not with the page scroll. |
| `research` | The real event with its tracks clustered into jets (anti-kT, R = 0.4, run in the browser on the track data): the tracks take their jet's color in the order the algorithm merges them, and a cone marks each jet. |
| `research-btag`, `research-top` | An illustration, not CMS data: the jet of a fast top quark. Close up, the b hadron's flight to a second vertex (b tagging); from farther away, one wide jet with three cores (top tagging). The captions on the page say that it is an illustration. |
| `research-ai` | An illustration, not a CMS model: the same jet stood upright, and above it a transformer that classifies it. Each track becomes a token, three attention layers link the tokens, and three bars show the scores. |
| `research-side` | Side view of the real event, with its jets and calorimeter deposits. |
| `hardware`, `hardware-layers`, `hardware-cassette`, `hardware-module`, `hardware-exploded` | From the whole to the part: one HGCAL endcap cut open, its front layers pulled apart, one cassette, one module taken off the cassette, and the module's own layers apart. |
| `teaching-ph106`, `teaching-ph302`, `teaching-ph253` | In place of the event, one illustration for each of three courses: an electromagnetic wave, a spinning top (integrated from its equations of motion) and the electron cloud of a hydrogen atom (sampled from its wave functions). |
| `cv`, `cv-globe` | The event, dim behind the long text; beside the career sections, a globe with the places of the CV, joined in the order of the career. |

A section that shows something other than the real event has a caption above it (`.scene-gap` with a
`.scene-caption`) that says what it is; illustrations are labeled as illustrations.

### Props

The endcap, the cassette, the transformer, the three classroom illustrations and the globe are "props": each
lives in its own module, which `scene.js` fetches the first time a view asks for it (`PROPS` in `scene.js`). A
view lists the props it shows (`props: { name: { settings } }`), and names a `fallback` view to show if a prop
cannot be built. A prop's module exports a function that returns `{ group, update(settings, fade, dt, still),
dispose() }`; `update` returns 0 when nothing on it moves, 1 for slow motion and 2 for motion that needs every
frame, and with `still` (reduced motion, or the reader paused the animation) it must draw a finished, static
picture.

## Editing content

Edit the page's HTML directly; keep the header and footer identical across pages. To add a page, copy an existing
one, change `<title>`, the description and canonical tags, and `data-view`, then add it to the nav in every page and
to `sitemap.xml`.

## Local preview

```
python3 -m http.server 8000
```

Then open http://localhost:8000/.
