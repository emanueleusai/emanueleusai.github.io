// Client-side page swaps that keep the 3D canvas alive.
// Every page is a complete HTML file (works without JS and for search engines);
// with JS we fetch the next page, swap only <main>, and let the scene fly the camera.

const cache = new Map();
let navigating = false;
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
  history.replaceState({ ...(history.state || {}), scrollY: window.scrollY }, '');

  async function navigate(href, { push = true, scrollY = 0 } = {}) {
    if (navigating) return;
    navigating = true;
    const url = new URL(href, location.href);
    try {
      const text = await fetchPage(url.href.split('#')[0]);
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const nextMain = doc.querySelector('main');
      const curMain = document.querySelector('main');
      if (!nextMain || !curMain) throw new Error('no <main>');

      if (push) {
        history.replaceState({ ...(history.state || {}), scrollY: window.scrollY }, '');
        history.pushState({ scrollY: 0 }, '', url.href);
      }

      const swap = () => {
        beforeSwap?.(nextMain);
        const adopted = document.importNode(nextMain, true);
        curMain.replaceWith(adopted);
        document.title = doc.title;
        for (const sel of ['meta[name="description"]', 'link[rel="canonical"]', 'meta[property="og:title"]', 'meta[property="og:description"]', 'meta[property="og:url"]']) {
          const next = doc.head.querySelector(sel);
          const cur = document.head.querySelector(sel);
          if (next && cur) cur.replaceWith(next.cloneNode(true));
        }
        markCurrentNav();
        rendered = url.pathname + url.search;
        if (url.hash) {
          const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
          if (target) target.scrollIntoView();
          else window.scrollTo(0, scrollY);
        } else {
          window.scrollTo(0, scrollY);
        }
        return adopted;
      };

      let adopted;
      if (document.startViewTransition && !reducedMotion) {
        const t = document.startViewTransition(() => { adopted = swap(); });
        await t.updateCallbackDone;
      } else {
        adopted = swap();
      }
      adopted.focus({ preventScroll: true });
      announce(doc.title);
      afterSwap?.(adopted);
    } catch (err) {
      console.warn('[router] falling back to full navigation:', err);
      location.href = url.href;
    } finally {
      navigating = false;
    }
  }

  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target && a.target !== '_self' || a.hasAttribute('download') || a.dataset.noRouter !== undefined) return;
    const url = new URL(a.getAttribute('href'), location.href);
    if (!isInternalPage(url)) return;
    if (samePage(url)) {
      if (url.hash) return; // in-page anchor: let the browser scroll
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
    if (location.pathname + location.search === rendered) return; // hash-only history step
    navigate(location.href, { push: false, scrollY: e.state?.scrollY || 0 });
  });
}
