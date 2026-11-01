// Craft Apps landing page: theme toggle, host label, and a check for what the apps need to render.
// The page works without this file; it only adds those three things.
(() => {
  const root = document.documentElement;
  const KEY = 'craft-apps-theme';

  const stored = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
  if (stored === 'light' || stored === 'dark') root.dataset.theme = stored;

  const current = () => root.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  document.getElementById('theme')?.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch { /* private window: the choice lasts this visit */ }
  });

  const host = document.getElementById('host');
  if (host) host.textContent = `On ${location.host}`;

  // The apps render with WebGPU and fall back to WebGL2; with neither they show an error instead.
  const gpu = document.getElementById('gpu');
  if (gpu) {
    let webgl2 = false;
    try { webgl2 = !!document.createElement('canvas').getContext('webgl2'); } catch { /* no WebGL */ }
    if ('gpu' in navigator) gpu.textContent = 'This browser: WebGPU';
    else if (webgl2) gpu.textContent = 'This browser: WebGL2';
    else {
      gpu.textContent = 'This browser has neither WebGPU nor WebGL2: the apps will not start';
      gpu.className = 'warn';
    }
  }
})();
