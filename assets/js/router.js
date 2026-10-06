// Client-side page swaps that keep the 3D canvas alive.
// Every page is a complete HTML file (works without JS and for search engines);
// with JS we fetch the next page, swap only <main>, and let the scene fly the camera.

const cache = new Map();
let navId = 0;            // the latest navigation wins; older ones bail out before touching history or the DOM
let rendered = location.pathname + location.search;

function isInternalPage(url) {
  if (url.origin !== location.origin) return false;
  const p = url.pathname;
  return p.endsWith('.html') || p.endsWith('/') || !p.split('/').pop().includes('.');
}

function samePage(url) {
  return url.pathname === location.pathname && url.search === location.search;
}

function fetchPage(href) {
  if (!cache.has(href)) {
    const p = fetch(href, { credentials: 'same-origin' }).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });
    p.catch(() => cache.delete(href));
    cache.set(href, p);
  }
  return cache.get(href);
}

export function markCurrentNav(doc = document) {
  const here = new URL(location.href);
  const herePath = here.pathname.replace(/index\.html$/, '');
  doc.querySelectorAll('.nav__link, .brand').forEach(a => {
    const u = new URL(a.getAttribute('href'), location.href);
    const path = u.pathname.replace(/index\.html$/, '');
    const match = path === herePath || path.replace(/\.html$/, '') === herePath.replace(/\.html$/, '');
    if (a.classList.contains('nav__link')) {
      if (match) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  });
}

// Programmatic jumps must not inherit html { scroll-behavior: smooth } (site.css): an animated
// jump would scroll the new page through the old offset and send the camera to the wrong view.
// Browsers without behavior: 'instant' (Safari before 15.4) throw on it; they get the root's
// scroll-behavior switched off around the jump instead.
function withoutSmooth(fn) {
  const html = document.documentElement;
  const prev = html.style.scrollBehavior;
  html.style.scrollBehavior = 'auto';
  void getComputedStyle(html).scrollBehavior;   // apply it now
  try { fn(); } finally { html.style.scrollBehavior = prev; }
}
function jumpTo(top) {
  try { window.scrollTo({ top, left: 0, behavior: 'instant' }); }
  catch { withoutSmooth(() => window.scrollTo(0, top)); }
}
function jumpToElement(el) {
  try { el.scrollIntoView({ block: 'start', behavior: 'instant' }); }
  catch { withoutSmooth(() => el.scrollIntoView()); }
}

function hashTarget(hash) {
  if (!hash || hash.length < 2) return null;
  try { return document.getElementById(decodeURIComponent(hash.slice(1))); } catch { return null; }
}

function saveScroll() {
  try { history.replaceState({ ...(history.state || {}), scrollY: window.scrollY }, ''); } catch { /* rate-limited */ }
}

function announce(text) {
  let live = document.getElementById('route-announcer');
  if (!live) {
    live = document.createElement('div');
    live.id = 'route-announcer';
    live.className = 'visually-hidden';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    document.body.appendChild(live);
  }
  live.textContent = text;
}

export function initRouter({ beforeSwap, afterSwap, reducedMotion }) {
  if (!('fetch' in window) || !('DOMParser' in window) || location.protocol === 'file:') return;
  history.scrollRestoration = 'manual';
  // Manual restoration also turns off the browser's own restore on reload and on Back from another
  // site (when the page is not in the back/forward cache), so keep the position in the history
  // entry as the reader scrolls and put it back on the way in.
  const saved = history.state?.scrollY;
  if (saved > 0 && !location.hash) jumpTo(saved);
  history.replaceState({ ...(history.state || {}), scrollY: saved ?? window.scrollY }, '');
  let saveTimer = 0;
  window.addEventListener('scroll', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveScroll, 200);
  }, { passive: true });

  async function navigate(href, { push = true, scrollY = null } = {}) {
    const id = ++navId;
    clearTimeout(saveTimer);
    const url = new URL(href, location.href);
    try {
      const text = await fetchPage(url.href.split('#')[0]);
      if (id !== navId) return;                 // superseded by a newer click or Back/Forward
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const nextMain = doc.querySelector('main');
      if (!nextMain || !document.querySelector('main')) throw new Error('no <main>');

      if (push) {
        saveScroll();
        history.pushState({ scrollY: 0 }, '', url.href);
      }

      let target = null;
      const swap = () => {
        if (id !== navId) return null;
        beforeSwap?.(nextMain);
        const adopted = document.importNode(nextMain, true);
        document.querySelector('main').replaceWith(adopted);
        document.title = doc.title;
        // Mirror the next page's tags; leaving the 404 page adds its missing canonical/og:url and drops noindex.
        for (const sel of ['meta[name="description"]', 'link[rel="canonical"]', 'meta[property="og:title"]', 'meta[property="og:description"]', 'meta[property="og:url"]', 'meta[name="robots"]']) {
          const next = doc.head.querySelector(sel);
          const cur = document.head.querySelector(sel);
          if (next && cur) cur.replaceWith(next.cloneNode(true));
          else if (next) document.head.appendChild(next.cloneNode(true));
          else if (cur) cur.remove();
        }
        markCurrentNav();
        rendered = url.pathname + url.search;
        target = hashTarget(url.hash);
        if (scrollY != null) jumpTo(scrollY);                         // Back/Forward: where the reader was
        else if (target) jumpToElement(target);
        else jumpTo(0);
        return adopted;
      };

      let adopted;
      if (document.startViewTransition && !reducedMotion) {
        const t = document.startViewTransition(() => { adopted = swap(); });
        await t.updateCallbackDone;
      } else {
        adopted = swap();
      }
      if (!adopted) return;
      // Keyboard focus continues from the anchor when there is one (as after a full page load),
      // otherwise from the top of the new content.
      if (target && scrollY == null) {
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      } else {
        adopted.focus({ preventScroll: true });
      }
      announce(doc.title);
      afterSwap?.(adopted);
    } catch (err) {
      if (id !== navId) return;
      console.warn('[router] falling back to full navigation:', err);
      location.href = url.href;
    }
  }

  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target && a.target !== '_self' || a.hasAttribute('download') || a.dataset.noRouter !== undefined) return;
    const url = new URL(a.getAttribute('href'), location.href);
    if (!isInternalPage(url)) return;
    if (samePage(url)) {
      if (url.hash) {
        // In-page anchor: let the browser scroll, but remember where we were so Back returns here.
        clearTimeout(saveTimer);
        saveScroll();
        return;
      }
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
      return;
    }
    e.preventDefault();
    navigate(url.href);
  });

  // Prefetch on intent.
  const prefetch = e => {
    const a = e.target.closest?.('a[href]');
    if (!a) return;
    const url = new URL(a.getAttribute('href'), location.href);
    if (isInternalPage(url) && !samePage(url)) fetchPage(url.href.split('#')[0]).catch(() => {});
  };
  document.addEventListener('pointerover', prefetch, { passive: true });
  document.addEventListener('focusin', prefetch);

  window.addEventListener('popstate', e => {
    clearTimeout(saveTimer);
    if (location.pathname + location.search === rendered) {       // hash-only history step
      navId++;                                                      // cancel a swap still in flight
      const y = e.state?.scrollY;
      const target = hashTarget(location.hash);
      if (y != null) jumpTo(y);
      else if (target) jumpToElement(target);
      else jumpTo(0);
      return;
    }
    navigate(location.href, { push: false, scrollY: e.state?.scrollY ?? null });
  });
}
