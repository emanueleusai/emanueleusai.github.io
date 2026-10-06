// Site entry point: navigation, page-swap router, scroll reveals, and the 3D backdrop.
import { initRouter, markCurrentNav } from './router.js';

const root = document.documentElement;
root.classList.remove('no-js');
const reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = reducedMotionQuery.matches;
if (reducedMotion) root.classList.add('reduced-motion');

let scene = null;          // controller returned by scene.js
let activeView = null;     // last view name sent to the scene

// ---------------------------------------------------------------------------
// 3D scene
// ---------------------------------------------------------------------------
function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

function pageView() {
  return document.querySelector('main')?.dataset.view || 'home';
}

function setView(name, opts) {
  if (!name || name === activeView) return;
  activeView = name;
  scene?.setView(name, opts);
}

async function startScene() {
  const canvas = document.getElementById('scene');
  if (!canvas) return;
  if (!webglAvailable()) {
    root.classList.add('no-webgl');
    return;
  }
  try {
    const { initScene } = await import('./scene.js');
    scene = await initScene({ canvas, reducedMotion, initialView: currentSceneView() });
    activeView = null;
    setView(currentSceneView(), { instant: true });
  } catch (err) {
    console.error('[scene] disabled:', err);
    root.classList.add('no-webgl');
  }
}

// Sections can retarget the camera as they scroll past the middle of the
// viewport: <section data-scene="hardware-module">. Above the first such
// section, the page's own view (main[data-view]) applies.
function currentSceneView() {
  const mid = window.innerHeight * 0.5;
  let view = pageView();
  for (const el of document.querySelectorAll('main [data-scene]')) {
    if (el.getBoundingClientRect().top < mid) view = el.dataset.scene;
  }
  return view;
}

let scrollTicking = false;
function onScroll() {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    scrollTicking = false;
    setView(currentSceneView());
  });
}

// ---------------------------------------------------------------------------
// Page setup (runs on first load and after every router swap)
// ---------------------------------------------------------------------------
let revealObserver = null;
function setupReveals(main) {
  revealObserver?.disconnect();
  const items = main.querySelectorAll('.reveal');
  if (reducedMotion || !('IntersectionObserver' in window)) {
    items.forEach(el => el.classList.add('is-visible'));
    return;
  }
  revealObserver = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('is-visible');
        revealObserver.unobserve(e.target);
      }
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
  items.forEach(el => revealObserver.observe(el));
}

function setupPage(main) {
  document.body.dataset.dim = main.dataset.dim || '';
  document.body.dataset.page = main.dataset.view || '';
  setupReveals(main);
  for (const el of document.querySelectorAll('[data-year]')) el.textContent = new Date().getFullYear();
  closeMenu();
  setView(currentSceneView());
}

// ---------------------------------------------------------------------------
// Mobile menu
// ---------------------------------------------------------------------------
const nav = document.querySelector('.nav');
const toggle = document.querySelector('.nav__toggle');
function closeMenu() {
  if (!nav || !toggle) return;
  nav.dataset.open = 'false';
  toggle.setAttribute('aria-expanded', 'false');
}
toggle?.addEventListener('click', () => {
  const open = nav.dataset.open !== 'true';
  nav.dataset.open = String(open);
  toggle.setAttribute('aria-expanded', String(open));
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && nav?.dataset.open === 'true') {
    closeMenu();
    toggle.focus();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
markCurrentNav();
setupPage(document.querySelector('main'));
window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', onScroll, { passive: true });
initRouter({
  reducedMotion,
  afterSwap: main => setupPage(main),
});
startScene();

// Expose for debugging and for page-level enhancements.
window.__site = { get scene() { return scene; }, setView: (n, o) => { activeView = null; setView(n, o); } };
