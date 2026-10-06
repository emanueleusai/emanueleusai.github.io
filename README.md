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

## 3D views

Each page sets `<main data-view="...">`. A section can switch the camera while it scrolls past the middle of the
screen with `data-scene="..."`. Views: `home`, `research`, `research-side`, `hardware`, `hardware-module`,
`hardware-exploded`, `teaching`, `join`, `publications`, `cv`, `notfound`.

## Editing content

Edit the page's HTML directly; keep the header and footer identical across pages. To add a page, copy an existing
one, change `<title>`, the description and canonical tags, and `data-view`, then add it to the nav in every page and
to `sitemap.xml`.

## Local preview

```
python3 -m http.server 8000
```

Then open http://localhost:8000/.
