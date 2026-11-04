// Installing the web app (Chrome and Edge offer it once the page has a manifest and a service worker) and moving to a
// new version. Plain script, outside Blazor: the notices are fixed to the bottom of the window.
(() => {
  if (!('serviceWorker' in navigator) || window.mgspMissing?.length) return; // index.html: the app cannot run here

  let installEvent = null;
  const bar = document.createElement('div');
  bar.className = 'pwa-bar';
  bar.hidden = true;
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(bar));

  function show(html, buttons) {
    bar.innerHTML = '';
    const text = document.createElement('span');
    text.textContent = html;
    bar.appendChild(text);
    for (const [label, action, primary] of buttons) {
      const b = document.createElement('button');
      b.className = primary ? 'btn primary' : 'btn';
      b.textContent = label;
      b.addEventListener('click', action);
      bar.appendChild(b);
    }
    bar.hidden = false;
    if (!bar.isConnected && document.body) document.body.appendChild(bar);
  }
  const hide = () => { bar.hidden = true; };

  // A new version waits until the user reloads (never in the middle of a recording).
  let wantReload = false;
  function offerUpdate(worker) {
    show('A new version of Movesense GSP is ready. Reload when you are not recording.', [
      ['Reload now', () => { wantReload = true; worker.postMessage('skipWaiting'); }, true],
      ['Later', hide, false],
    ]);
  }

  navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
      });
    });
    // Look for a new version every 30 minutes while the page stays open.
    setInterval(() => reg.update().catch(() => { }), 30 * 60 * 1000);
  }).catch(err => console.warn('service worker', err));

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only after the user chose "Reload now" (skipWaiting); the first install takes control silently.
    if (reloading || !wantReload) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installEvent = e;
    if (sessionStorage.getItem('pwa-install-dismissed')) return;
    show('Install Movesense GSP as an app: its own window, and it starts without a network.', [
      ['Install', async () => { hide(); installEvent?.prompt(); installEvent = null; }, true],
      ['Not now', () => { hide(); try { sessionStorage.setItem('pwa-install-dismissed', '1'); } catch { } }, false],
    ]);
  });
  window.addEventListener('appinstalled', hide);
})();
