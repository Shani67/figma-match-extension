import { idb, saveToken, loadToken, clearAll, getLocal, setLocal, pageKeyFor } from '../lib/store.js';
import { parseFigmaUrl, getMe, getFrame, renderFrame, simplify, FigmaError } from '../lib/figma.js';

/* ==================================================================== */
/* state                                                                */
/* ==================================================================== */
const MAX_CAPTURE_HEIGHT = 30000;

const S = {
  token: null,
  user: null,
  tabId: Number(new URLSearchParams(location.search).get('tab')) || null,
  windowId: null,
  url: null,
  origin: null,
  pattern: null,
  pageKey: null,
  supported: false,
  allowed: false,
  page: null, // { figmaUrl, fileKey, nodeId, map, overlay }
  design: null, // simplified design
  designBlob: null,
  designSrc: null,
  fetchedAt: null,
  frozen: false,
  diff: null,
  diffSrc: null,
  spec: null,
  specStale: false,
  specFilter: 'all',
  busy: false,
  viewport: null, // last page-info from the page
  hideScrollbar: true,
  locks: new Map(), // tabId -> { width, height, scale }
  attached: new Set(),
};

const DEFAULT_OVERLAY = { visible: false, source: 'design', opacity: 0.5, blend: 'normal', x: 0, y: 0 };

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'style') n.setAttribute('style', v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

/* ==================================================================== */
/* status                                                               */
/* ==================================================================== */
let statusTimer = null;
function status(msg, kind = 'info', ms = 3500) {
  const el = $('#status');
  clearTimeout(statusTimer);
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.className = `status ${kind}`;
  el.hidden = false;
  if (kind !== 'busy') statusTimer = setTimeout(() => { el.hidden = true; }, ms);
}

async function task(label, fn) {
  if (S.busy) { status('Please wait for the current task to finish.', 'info'); return; }
  S.busy = true;
  renderBusy();
  status(label, 'busy');
  try {
    const r = await fn();
    status(null);
    return r;
  } catch (err) {
    console.warn('[Figma Match]', err);
    if (err instanceof FigmaError && err.code === 'AUTH') {
      await signOut(true);
      status('Your Figma token is no longer valid. Please sign in again.', 'error', 7000);
    } else {
      status(err?.message || String(err), 'error', 7000);
    }
  } finally {
    S.busy = false;
    renderBusy();
  }
}

function renderBusy() {
  $$('#view-main button, #view-main input').forEach((b) => {
    if (S.busy) { if (!b.disabled) { b.dataset.busyDisabled = '1'; b.disabled = true; } }
    else if (b.dataset.busyDisabled) { delete b.dataset.busyDisabled; b.disabled = false; }
  });
  if (!S.busy) renderAll();
}

/* ==================================================================== */
/* background port (cleanup when the panel closes)                      */
/* ==================================================================== */
let port = null;
function connectPort() {
  port = chrome.runtime.connect({ name: 'fm-panel' });
  port.onDisconnect.addListener(() => { setTimeout(connectPort, 300); });
  for (const tabId of S.attached) port.postMessage({ type: 'debugger-attached', tabId });
}
setInterval(() => { try { port?.postMessage({ type: 'ping' }); } catch (_) {} }, 20000);

/* ==================================================================== */
/* auth                                                                 */
/* ==================================================================== */
async function signIn(e) {
  e.preventDefault();
  const token = $('#token').value.trim();
  const err = $('#login-err');
  err.textContent = '';
  if (!/^[A-Za-z0-9_-]{20,300}$/.test(token)) {
    err.textContent = 'That does not look like a Figma personal access token.';
    return;
  }
  $('#login-btn').disabled = true;
  try {
    const me = await getMe(token);
    await saveToken(token, $('#remember').checked);
    const user = { handle: me.handle, email: me.email, img: me.img };
    await (($('#remember').checked) ? chrome.storage.local : chrome.storage.session).set({ fmUser: user });
    S.token = token;
    S.user = user;
    $('#token').value = '';
    status(`Signed in as ${me.handle}.`, 'info');
    showView();
    await refreshTab();
  } catch (ex) {
    err.textContent = ex?.message || 'Sign-in failed.';
  } finally {
    $('#login-btn').disabled = false;
  }
}

/* Side panels can't show confirm() dialogs, so destructive buttons need a second click. */
function armed(btn, label) {
  if (btn.dataset.armed === '1') {
    delete btn.dataset.armed;
    btn.textContent = btn.dataset.label;
    return true;
  }
  btn.dataset.armed = '1';
  btn.dataset.label = btn.textContent;
  btn.textContent = label;
  setTimeout(() => {
    if (btn.dataset.armed === '1') { delete btn.dataset.armed; btn.textContent = btn.dataset.label; }
  }, 3000);
  return false;
}

async function signOut(silent) {
  for (const tabId of [...S.attached]) await detach(tabId);
  if (S.tabId && S.allowed) { try { await chrome.tabs.sendMessage(S.tabId, { type: 'fm:teardown' }); } catch (_) {} }
  await clearAll();
  Object.assign(S, { token: null, user: null, design: null, designBlob: null, designSrc: null, diff: null, diffSrc: null, spec: null });
  showView();
  if (!silent) status('Signed out. You can also revoke the token in Figma → Settings → Security.', 'info', 6000);
}

function showView() {
  const logged = !!S.token;
  $('#view-login').hidden = logged;
  $('#view-main').hidden = !logged;
  $('#account').hidden = !logged;
  if (logged && S.user) {
    $('#handle').textContent = S.user.handle || 'Figma user';
    $('#handle').title = S.user.email || '';
    const img = $('#avatar');
    if (S.user.img && /^https:\/\/[^/]*\.(figma\.com|amazonaws\.com)\//.test(S.user.img)) { img.src = S.user.img; img.hidden = false; } else img.hidden = true;
  }
}

/* ==================================================================== */
/* tabs / site permission                                               */
/* ==================================================================== */
async function savePage() {
  if (!S.pageKey || !S.page) return;
  const pages = await getLocal('fmPages', {});
  pages[S.pageKey] = S.page;
  await setLocal('fmPages', pages);
}

/* The controls live in their own window, so the "current" tab is the one
   you are working in, in a normal browser window. */
async function resolveTab() {
  if (S.tabId) {
    try {
      const t = await chrome.tabs.get(S.tabId);
      const w = await chrome.windows.get(t.windowId);
      if (w.type === 'normal') return t;
    } catch (_) { /* tab gone */ }
  }
  const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true }).catch(() => null);
  return w?.tabs?.find((t) => t.active) || null;
}

async function retarget(tabId) {
  if (!Number.isInteger(tabId) || tabId === S.tabId) return;
  S.tabId = tabId;
  await refreshTab();
}

async function refreshViewport() {
  S.viewport = null;
  if (!S.token || !S.allowed) return;
  try {
    if (S.design) await agent('fm:scrollbar', { hide: S.hideScrollbar });
    S.viewport = await agent('fm:page-info');
  } catch (_) { /* page not ready */ }
}

async function refreshTab() {
  const tab = await resolveTab();
  if (!tab) { S.tabId = null; S.supported = false; S.url = ''; renderAll(); return; }
  const prevKey = S.pageKey;
  S.tabId = tab.id;
  S.windowId = tab.windowId;
  S.url = tab.url || '';
  S.supported = /^https?:/i.test(S.url) && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(S.url);
  if (S.supported) {
    const u = new URL(S.url);
    S.origin = u.origin;
    S.pattern = `${u.protocol}//${u.hostname}/*`;
    S.allowed = await chrome.permissions.contains({ origins: [S.pattern] });
    S.pageKey = pageKeyFor(S.url);
  } else {
    S.origin = S.pattern = S.pageKey = null;
    S.allowed = false;
  }

  if (S.pageKey !== prevKey) {
    S.diff = null; S.diffSrc = null; S.spec = null; S.frozen = false;
    const pages = await getLocal('fmPages', {});
    S.page = S.pageKey ? (pages[S.pageKey] || null) : null;
    if (S.page) S.page.overlay = { ...DEFAULT_OVERLAY, ...(S.page.overlay || {}), visible: false };
    await loadDesignFromCache();
  }
  if (S.token && S.allowed && S.design) await pushOverlay(true).catch(() => {});
  await refreshViewport();
  document.title = S.url ? `Figma Match · ${S.url.replace(/^https?:\/\//, '')}` : 'Figma Match';
  renderAll();
}

async function allowSite() {
  if (!S.pattern) return;
  const ok = await chrome.permissions.request({ origins: [S.pattern] });
  if (!ok) { status('Permission was not granted.', 'error'); return; }
  S.allowed = true;
  status(`Figma Match can now run on ${new URL(S.url).hostname}.`);
  if (S.design) await pushOverlay(true).catch(() => {});
  renderAll();
}

/* ==================================================================== */
/* agent messaging                                                      */
/* ==================================================================== */
async function ensureAgent() {
  if (!S.allowed) throw new Error('Allow Figma Match on this site first.');
  try {
    const r = await chrome.tabs.sendMessage(S.tabId, { type: 'fm:ping' });
    if (r?.ok) return;
  } catch (_) {}
  await chrome.scripting.executeScript({ target: { tabId: S.tabId }, files: ['content/agent.js'] });
}

async function agent(type, payload = {}) {
  await ensureAgent();
  const r = await chrome.tabs.sendMessage(S.tabId, { type, ...payload });
  if (!r) throw new Error('The page did not respond. Reload the page and try again.');
  if (!r.ok) throw new Error(r.error || 'Page error');
  return r.data;
}

async function pushOverlay(withImages) {
  if (!S.design || !S.page) return;
  const payload = { state: { ...S.page.overlay, frameWidth: S.design.width } };
  if (withImages) { payload.designSrc = S.designSrc; payload.diffSrc = S.diffSrc; }
  if (payload.state.source === 'diff' && !S.diffSrc) payload.state.source = 'design';
  await agent('fm:overlay-set', payload);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (!sender.tab) {
    if (msg?.type === 'fm:target') { retarget(msg.tabId); window.focus(); }
    return;
  }
  if (sender.tab.id !== S.tabId) return;
  if (msg?.type === 'fm:viewport' && msg.info) {
    S.viewport = msg.info;
    renderEnv();
    return;
  }
  if (msg?.type === 'fm:overlay-state' && S.page) {
    const st = msg.state || {};
    S.page.overlay = {
      visible: !!st.visible,
      source: st.source === 'diff' ? 'diff' : 'design',
      opacity: Number(st.opacity) || 0.5,
      blend: st.blend === 'difference' ? 'difference' : 'normal',
      x: Math.round(Number(st.x) || 0),
      y: Math.round(Number(st.y) || 0),
    };
    savePage();
    renderOverlay();
  }
});

/* ==================================================================== */
/* design loading                                                       */
/* ==================================================================== */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function loadDesignFromCache() {
  S.design = S.designBlob = S.designSrc = null;
  if (!S.page?.fileKey) return;
  const rec = await idb.get('designs', `${S.page.fileKey}:${S.page.nodeId}`);
  if (!rec) return;
  S.design = rec.design;
  S.designBlob = rec.blob;
  S.fetchedAt = rec.fetchedAt;
  S.designSrc = await blobToDataUrl(rec.blob);
}

async function loadDesign(url, force) {
  if (!S.pageKey) throw new Error('Open the page you want to check first.');
  const { fileKey, nodeId } = parseFigmaUrl(url);
  const cacheKey = `${fileKey}:${nodeId}`;
  let rec = force ? null : await idb.get('designs', cacheKey);
  if (!rec) {
    status('Reading the frame from Figma…', 'busy');
    const frame = await getFrame(S.token, fileKey, nodeId);
    const design = simplify(frame);
    status(`Rendering “${design.name}” (${design.width}×${design.height})…`, 'busy');
    const blob = await renderFrame(S.token, fileKey, nodeId);
    const bmp = await createImageBitmap(blob);
    design.imageWidth = bmp.width;
    design.imageHeight = bmp.height;
    bmp.close();
    rec = { design, blob, fetchedAt: Date.now() };
    await idb.set('designs', cacheKey, rec);
  }
  const sameNode = S.page && S.page.fileKey === fileKey && S.page.nodeId === nodeId;
  S.page = {
    figmaUrl: String(url).trim(),
    fileKey,
    nodeId,
    map: sameNode ? (S.page.map || {}) : {},
    overlay: sameNode ? S.page.overlay : { ...DEFAULT_OVERLAY },
  };
  S.design = rec.design;
  S.designBlob = rec.blob;
  S.fetchedAt = rec.fetchedAt;
  S.designSrc = await blobToDataUrl(rec.blob);
  S.diff = null; S.diffSrc = null; S.spec = null;
  // Forget section links that no longer exist in the frame.
  const ids = new Set(S.design.sections.map((s) => s.id));
  for (const id of Object.keys(S.page.map)) if (!ids.has(id)) delete S.page.map[id];
  await savePage();
  if (S.allowed) await pushOverlay(true);
  if (S.design.imageWidth && S.design.imageWidth !== S.design.width) {
    status(`Note: Figma rendered ${S.design.imageWidth}px wide for a ${S.design.width}px frame; the overlay is scaled to fit.`, 'info', 6000);
  }
}

async function unlinkDesign() {
  if (!S.pageKey) return;
  const pages = await getLocal('fmPages', {});
  delete pages[S.pageKey];
  await setLocal('fmPages', pages);
  try { await agent('fm:teardown'); } catch (_) {}
  S.page = null; S.design = null; S.designSrc = null; S.designBlob = null; S.diff = null; S.diffSrc = null; S.spec = null;
  $('#figma-url').value = '';
}

/* ==================================================================== */
/* viewport lock (Chrome DevTools Protocol)                             */
/* ==================================================================== */
const cdp = (method, params = {}) => chrome.debugger.sendCommand({ tabId: S.tabId }, method, params);

async function attach(tabId) {
  if (S.attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    throw new Error(`Could not lock the viewport: ${e.message}. Close other debugging extensions for this tab and try again.`);
  }
  S.attached.add(tabId);
  port?.postMessage({ type: 'debugger-attached', tabId });
}

async function detach(tabId) {
  if (!S.attached.has(tabId)) return;
  try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride'); } catch (_) {}
  try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.setScrollbarsHidden', { hidden: false }); } catch (_) {}
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  S.attached.delete(tabId);
  S.locks.delete(tabId);
  port?.postMessage({ type: 'debugger-detached', tabId });
}

chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (!S.attached.has(tabId)) return;
  S.attached.delete(tabId);
  S.locks.delete(tabId);
  port?.postMessage({ type: 'debugger-detached', tabId });
  if (tabId === S.tabId) status('The viewport lock was turned off (Chrome’s debugging bar was closed).', 'info', 5000);
  renderAll();
});

async function setMetrics(lock, scale) {
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: lock.width,
    height: lock.height,
    deviceScaleFactor: 1,
    mobile: false,
    scale,
    screenWidth: lock.width,
    screenHeight: lock.height,
  });
}

async function lockViewport() {
  if (!S.design) throw new Error('Load a Figma frame first.');
  const width = S.design.width;
  const current = S.locks.get(S.tabId);
  let realW;
  let realH;
  if (current) {
    realW = current.realW; realH = current.realH;
  } else {
    const info = await agent('fm:page-info');
    realW = info.innerWidth; realH = info.innerHeight;
  }
  await attach(S.tabId);
  const scale = Math.min(1, realW / width);
  const lock = { width, height: Math.max(400, Math.round(realH / scale)), scale, realW, realH };
  await setMetrics(lock, scale);
  try { await cdp('Emulation.setScrollbarsHidden', { hidden: true }); } catch (_) {}
  S.locks.set(S.tabId, lock);
  await new Promise((r) => setTimeout(r, 300));
  await pushOverlay(false).catch(() => {});
  S.viewport = await agent('fm:page-info').catch(() => S.viewport);
}

/* True when the real browser viewport already equals the Figma frame width. */
function nativeMatch(info) {
  return !!info && info.innerWidth === S.design.width;
}

/* Make sure the page is laid out at exactly the frame width.
   If the window already is that wide (e.g. maximised 1920px), nothing is done;
   otherwise the viewport is locked through the debugger. */
async function ensureExactWidth() {
  const lock = S.locks.get(S.tabId);
  if (lock && lock.width === S.design.width) return;
  await agent('fm:scrollbar', { hide: S.hideScrollbar });
  S.viewport = await agent('fm:page-info');
  if (nativeMatch(S.viewport)) return;
  await lockViewport();
  status(`The window is ${S.viewport.innerWidth}px, so the page was locked to ${S.design.width}px for this check.`, 'info', 5000);
}

/* Runs in the page's MAIN world (not in the extension). Only stops motion. */
function mainWorldFreeze() {
  const w = window;
  const safe = (fn) => { try { fn(); } catch (_) { /* ignore */ } };
  safe(() => document.querySelectorAll('[data-aos]').forEach((e) => e.classList.add('aos-animate')));
  safe(() => w.ScrollTrigger && w.ScrollTrigger.getAll().forEach((st) => safe(() => st.animation && st.animation.progress(1))));
  safe(() => w.gsap && w.gsap.globalTimeline.getChildren(true, true, false).forEach((t) => safe(() => {
    if (typeof t.repeat === 'function' && t.repeat() === -1) t.pause(0); else t.progress(1);
  })));
  safe(() => {
    if (w.jQuery && w.jQuery.fn && w.jQuery.fn.slick) {
      const $s = w.jQuery('.slick-initialized');
      $s.slick('slickPause');
      $s.slick('slickGoTo', 0, true);
    }
  });
  safe(() => document.querySelectorAll('.swiper, .swiper-container').forEach((el) => {
    const s = el.swiper;
    if (s) { safe(() => s.autoplay && s.autoplay.stop()); safe(() => s.slideTo(0, 0)); }
  }));
  safe(() => w.lenis && typeof w.lenis.destroy === 'function' && w.lenis.destroy());
  return true;
}

async function setFreeze(on) {
  await agent('fm:freeze', { on });
  if (on) {
    await chrome.scripting.executeScript({ target: { tabId: S.tabId }, world: 'MAIN', func: mainWorldFreeze });
  }
  S.frozen = on;
}

/* ==================================================================== */
/* full-page capture                                                    */
/* ==================================================================== */
function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

async function capturePage() {
  await ensureExactWidth();
  if (!S.frozen && (await getLocal('fmAutoFreeze', true))) await setFreeze(true);
  status('Loading lazy images and fonts…', 'busy');
  await agent('fm:preload');
  const lock = S.locks.get(S.tabId);
  const W = S.design.width;
  // Screenshots need the debugger. Without a lock it is attached only for the capture.
  const temporary = !S.attached.has(S.tabId);
  await attach(S.tabId);
  if (lock) await setMetrics(lock, 1);
  let info;
  try {
    info = await agent('fm:capture-begin');
  } catch (e) {
    if (temporary) await detach(S.tabId);
    throw e;
  }
  try {
    const total = Math.min(info.docHeight, MAX_CAPTURE_HEIGHT);
    const vh = info.vh;
    const canvas = new OffscreenCanvas(W, total);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, total);
    let y = 0;
    let first = true;
    for (let guard = 0; guard < 200; guard++) {
      status(`Capturing page… ${Math.min(100, Math.round((y / total) * 100))}%`, 'busy');
      const { scrollY } = await agent('fm:scroll-to', { y, hideFixed: !first, settle: first ? 350 : 220 });
      const shot = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const bmp = await createImageBitmap(b64ToBlob(shot.data, 'image/png'));
      const k = W / bmp.width;
      ctx.drawImage(bmp, 0, scrollY, W, Math.round(bmp.height * k));
      bmp.close();
      first = false;
      if (scrollY + vh >= total - 1) break;
      const next = scrollY + vh;
      if (next <= y) break;
      y = next;
    }
    return { canvas, height: total, truncated: info.docHeight > MAX_CAPTURE_HEIGHT };
  } finally {
    await agent('fm:capture-end').catch(() => {});
    if (lock) await setMetrics(lock, lock.scale).catch(() => {});
    if (temporary) await detach(S.tabId);
  }
}

/* ==================================================================== */
/* pixel diff                                                           */
/* ==================================================================== */
function runWorker(payload, transfer) {
  return new Promise((resolve, reject) => {
    const w = new Worker(chrome.runtime.getURL('lib/diff-worker.js'));
    w.onmessage = (e) => {
      if (e.data.progress) return;
      if (e.data.done) { w.terminate(); resolve(e.data); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'Diff failed')); };
    w.postMessage(payload, transfer);
  });
}

async function runDiff() {
  if (!S.design) throw new Error('Load a Figma frame first.');
  const W = S.design.width;
  const page = await capturePage();
  status('Comparing pixels…', 'busy');

  const dbmp = await createImageBitmap(S.designBlob);
  const DH = Math.round(dbmp.height * (W / dbmp.width));
  const dc = new OffscreenCanvas(W, DH);
  const dctx = dc.getContext('2d');
  dctx.fillStyle = '#ffffff';
  dctx.fillRect(0, 0, W, DH);
  dctx.drawImage(dbmp, 0, 0, W, DH);
  dbmp.close();
  const dData = dctx.getImageData(0, 0, W, DH);
  const PH = page.height;
  const pData = page.canvas.getContext('2d').getImageData(0, 0, W, PH);

  const rects = await agent('fm:measure', { map: S.page.map || {} });
  const regions = S.design.sections.map((s) => {
    const r = rects[s.id];
    return {
      id: s.id,
      name: s.name,
      fy: Math.max(0, Math.round(s.y)),
      fh: Math.round(s.h),
      py: Math.max(0, r ? r.top : Math.round(s.y)),
      ph: r ? r.height : Math.round(s.h),
      mapped: !!r,
      label: r?.label || null,
    };
  });

  const threshold = Number($('#diff-threshold').value) || 0.1;
  const out = await runWorker({
    W, DH, PH, regions: regions.map(({ id, fy, fh, py, ph }) => ({ id, fy, fh, py, ph })), threshold,
    design: dData.data.buffer, page: pData.data.buffer,
  }, [dData.data.buffer, pData.data.buffer]);

  const mc = new OffscreenCanvas(W, PH);
  mc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out.mask), W, PH), 0, 0);
  S.diffSrc = await blobToDataUrl(await mc.convertToBlob({ type: 'image/png' }));

  let diffSum = 0;
  let cmpSum = 0;
  const sections = regions.map((r) => {
    const st = out.stats.find((x) => x.id === r.id) || { compared: 0, diff: 0 };
    diffSum += st.diff; cmpSum += st.compared;
    return {
      ...r,
      score: st.compared ? 100 * (1 - st.diff / st.compared) : null,
      heightDelta: r.mapped ? r.ph - r.fh : null,
    };
  });
  S.diff = {
    at: Date.now(),
    threshold,
    overall: cmpSum ? 100 * (1 - diffSum / cmpSum) : null,
    pageHeight: PH,
    figmaHeight: S.design.height,
    truncated: page.truncated,
    sections,
  };
  S.page.overlay = { ...S.page.overlay, visible: true, source: 'diff' };
  await savePage();
  await pushOverlay(true);
  status('Pixel diff finished. Red areas on the page are differences.', 'info', 4500);
}

/* ==================================================================== */
/* spec check                                                           */
/* ==================================================================== */
async function runSpec() {
  if (!S.design) throw new Error('Load a Figma frame first.');
  await ensureExactWidth();
  if (!S.frozen && (await getLocal('fmAutoFreeze', true))) await setFreeze(true);
  status('Checking text layers…', 'busy');
  const tol = await getLocal('fmTolerances', {});
  S.spec = await agent('fm:spec', {
    texts: S.design.texts,
    sections: S.design.sections,
    map: S.page.map || {},
    frameWidth: S.design.width,
    tol,
  });
  S.specStale = false;
  S.specFilter = 'all';
  const n = S.spec.results.length;
  status(n ? `${n} text element${n > 1 ? 's' : ''} differ from Figma.` : 'All matched text elements match Figma.', 'info', 4500);
}

const FILTERS = [
  ['all', 'All'],
  ['type', 'Typography', ['font-size', 'font-weight', 'font-family', 'font-style', 'line-height', 'letter-spacing', 'text-transform']],
  ['color', 'Colour', ['color']],
  ['layout', 'Position', ['top', 'left']],
  ['wrap', 'Wrapping', ['line wrap']],
  ['content', 'Content', ['content']],
];

/* ==================================================================== */
/* sections                                                             */
/* ==================================================================== */
async function pickSection(sec) {
  status(`Click the element for “${sec.name}” on the page…`, 'busy');
  const res = await agent('fm:pick', { title: `Select: ${sec.name}` });
  if (!res) return;
  S.page.map = { ...(S.page.map || {}), [sec.id]: res.selector };
  await savePage();
  await agent('fm:flash', { selector: res.selector, figma: figmaRectFor(sec, res.rect.top), title: sec.name });
}

function figmaRectFor(sec, top) {
  const lock = S.locks.get(S.tabId);
  const vw = lock ? lock.width : (S.viewport?.clientWidth || S.design.width);
  const left = Math.max(0, Math.round((vw - S.design.width) / 2));
  return { left: left + Math.round(sec.x), top: Math.round(top ?? sec.y), width: Math.round(sec.w), height: Math.round(sec.h) };
}

async function autoMap() {
  await ensureExactWidth();
  const map = await agent('fm:auto-map', { sections: S.design.sections, frameHeight: S.design.height });
  S.page.map = map;
  await savePage();
  const n = Object.keys(map).length;
  status(`Matched ${n} of ${S.design.sections.length} sections. Check them with “Show” and fix any wrong ones with “Pick”.`, 'info', 6000);
}

/* ==================================================================== */
/* report                                                               */
/* ==================================================================== */
function reportMarkdown() {
  const L = [];
  const d = S.design;
  L.push('# Figma Match report', '');
  L.push(`- **Page:** ${S.url}`);
  L.push(`- **Figma:** ${d.fileName} → ${d.name} (${d.width}×${d.height}px) — ${S.page.figmaUrl}`);
  L.push(`- **Viewport:** ${d.width}px wide (locked), date: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '');

  if (S.diff) {
    L.push('## Pixel diff', '');
    L.push(`Overall match: **${fmtPct(S.diff.overall)}** · page height ${S.diff.pageHeight}px vs Figma ${S.diff.figmaHeight}px`, '');
    L.push('| Section | Match | Height Δ | Page element |', '|---|---|---|---|');
    for (const s of S.diff.sections) {
      L.push(`| ${mdCell(s.name)} | ${fmtPct(s.score)} | ${s.heightDelta == null ? 'not linked' : `${s.heightDelta > 0 ? '+' : ''}${s.heightDelta}px`} | ${s.label ? `\`${s.label}\`` : '—'} |`);
    }
    L.push('');
  }

  if (S.spec) {
    L.push(`## Spec issues (${S.spec.results.length})`, '');
    const bySec = groupBy(S.spec.results, (r) => r.section || 'Other');
    for (const [sec, items] of bySec) {
      L.push(`### ${sec}`, '');
      for (const r of items) {
        L.push(`- **“${r.text}”** — \`${r.label}\`${r.mixed ? ' _(mixed styles in Figma)_' : ''}`);
        L.push(`  - selector: \`${r.selector}\``);
        for (const p of r.problems) {
          L.push(`  - ${p.prop}: Figma \`${p.figma}\` → site \`${p.site}\`${p.hint ? ` (${p.hint})` : ''}`);
        }
      }
      L.push('');
    }
    if (S.spec.missing.length) {
      L.push(`## Figma text not found on the page (${S.spec.missing.length})`, '');
      for (const m of S.spec.missing) L.push(`- “${m.text}” (${m.section})`);
      L.push('');
    }
  }
  return L.join('\n');
}

const mdCell = (s) => String(s).replace(/\|/g, '\\|');
const fmtPct = (v) => (v == null ? '—' : `${v.toFixed(1)}%`);
function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

/* ==================================================================== */
/* rendering                                                            */
/* ==================================================================== */
function renderAll() {
  showView();
  if (!S.token) return;
  renderSite();
  renderDesign();
  renderEnv();
  renderReady();
  renderOverlay();
  renderSections();
  renderDiff();
  renderSpec();
  $('#export-card').hidden = !(S.diff || S.spec);
}

function renderSite() {
  $('#site-url').textContent = S.supported ? S.url : 'This tab can’t be checked';
  const st = $('#site-state');
  const allowBtn = $('#allow-site');
  const hint = $('#site-hint');
  if (!S.supported) {
    st.textContent = 'Unsupported'; st.className = 'pill bad';
    allowBtn.hidden = true;
    hint.textContent = 'Open a normal http(s) page, e.g. your local WordPress site.';
  } else if (!S.allowed) {
    st.textContent = 'Not allowed'; st.className = 'pill bad';
    allowBtn.hidden = false;
    allowBtn.textContent = `Allow on ${new URL(S.url).hostname}`;
    hint.textContent = 'Figma Match only runs on sites you allow. You can remove access any time in chrome://extensions.';
  } else {
    st.textContent = 'Allowed'; st.className = 'pill ok';
    allowBtn.hidden = true;
    hint.textContent = '';
  }
}

function renderDesign() {
  const input = $('#figma-url');
  if (S.page?.figmaUrl && document.activeElement !== input) input.value = S.page.figmaUrl;
  if (!S.page?.figmaUrl && document.activeElement !== input && !input.value) input.value = '';
  const info = $('#design-info');
  info.hidden = !S.design;
  $('#design-card').hidden = !S.supported;
  if (!S.design) return;
  $('#d-name').textContent = `${S.design.name} · ${S.design.fileName}`;
  $('#d-size').textContent = `${S.design.width} × ${S.design.height}px`;
  $('#d-counts').textContent = `${S.design.sections.length} · ${S.design.texts.length}`;
  $('#d-fetched').textContent = S.fetchedAt ? new Date(S.fetchedAt).toLocaleString() : '—';
}

function renderEnv() {
  $('#env-card').hidden = !(S.supported && S.design);
  if (!S.design) return;
  const W = S.design.width;
  const lock = S.locks.get(S.tabId);
  const vp = S.viewport;
  const box = $('#vp-status');
  const text = $('#vp-text');
  const help = $('#vp-help');
  if (lock) {
    box.className = 'vp ok';
    text.textContent = `Locked to exactly ${lock.width}px${lock.scale < 1 ? ` (shown at ${Math.round(lock.scale * 100)}%)` : ''}`;
    help.textContent = 'Chrome shows a “started debugging” bar while the lock is on.';
  } else if (!vp) {
    box.className = 'vp';
    text.textContent = 'Page width unknown';
    help.textContent = 'Allow the site and load a frame to measure it.';
  } else if (nativeMatch(vp)) {
    box.className = 'vp ok';
    text.textContent = `Page is ${vp.innerWidth}px wide · 1:1 with Figma`;
    help.textContent = vp.clientWidth < vp.innerWidth
      ? `The scrollbar takes ${vp.innerWidth - vp.clientWidth}px. Turn on “Hide page scrollbar” for an exact match.`
      : (vp.dpr !== 1 ? `Display scale ${vp.dpr}×. Screenshots are scaled back to ${W}px.` : 'No lock needed.');
  } else {
    box.className = 'vp bad';
    text.textContent = `Page is ${vp.innerWidth}px, Figma frame is ${W}px`;
    help.textContent = vp.innerWidth < W
      ? `Maximise the browser window and reset the zoom to 100% (Ctrl+0). If the screen is narrower than ${W}px, turn on the lock below; checks lock it for you automatically.`
      : 'Reset the zoom to 100% (Ctrl+0) or turn on the lock below; checks lock it for you automatically.';
  }
  $('#lock-toggle').checked = !!lock;
  $('#lock-width').textContent = String(W);
  $('#scrollbar-toggle').checked = S.hideScrollbar;
  $('#freeze-toggle').checked = S.frozen;
}

function renderReady() {
  const np = $('#not-ready');
  let msg = '';
  if (!S.supported) msg = 'Open the page you want to check in this tab.';
  else if (!S.allowed) msg = 'Allow Figma Match on this site to start.';
  else if (!S.design) msg = 'Paste the link to the Figma desktop frame for this page and click Load.';
  np.hidden = !msg;
  np.textContent = msg;
  const ready = !msg;
  $('.tabs').hidden = !ready;
  $$('.tabpanel').forEach((p) => { p.hidden = !ready || p.id !== `tab-${currentTab}`; });
}

function renderOverlay() {
  const o = S.page?.overlay || DEFAULT_OVERLAY;
  $('#ov-visible').checked = !!o.visible;
  $$('input[name="ov-source"]').forEach((r) => { r.checked = r.value === o.source; });
  $('#ov-source-diff').disabled = !S.diffSrc;
  $$('input[name="ov-blend"]').forEach((r) => { r.checked = r.value === o.blend; });
  $('#ov-opacity').value = String(Math.round(o.opacity * 100));
  $('#ov-opacity-val').textContent = `${Math.round(o.opacity * 100)}%`;
  if (document.activeElement !== $('#ov-x')) $('#ov-x').value = String(o.x);
  if (document.activeElement !== $('#ov-y')) $('#ov-y').value = String(o.y);
}

function renderSections() {
  const list = $('#sec-list');
  list.replaceChildren();
  if (!S.design) return;
  const map = S.page?.map || {};
  for (const sec of S.design.sections) {
    const sel = map[sec.id];
    list.append(h('li', { class: 'item' },
      h('div', { class: 'item-head' },
        h('span', { class: 'item-title', title: sec.name, text: sec.name }),
        h('span', { class: `pill ${sel ? 'ok' : ''}`, text: sel ? 'Linked' : 'Not linked' })),
      h('div', { class: 'item-meta', text: `Figma y ${Math.round(sec.y)} · h ${Math.round(sec.h)}${sel ? ` · ${sel}` : ''}` }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => task('Waiting for you to pick…', () => pickSection(sec)) }, sel ? 'Re-pick' : 'Pick'),
        h('button', {
          class: 'btn small', type: 'button',
          onclick: () => task('Locating…', async () => {
            const rects = sel ? await agent('fm:measure', { map: { [sec.id]: sel } }) : {};
            const r = rects[sec.id];
            await agent('fm:flash', { selector: sel || null, figma: figmaRectFor(sec, r ? r.top : sec.y), title: sec.name });
          }),
        }, 'Show'),
        sel ? h('button', {
          class: 'btn small', type: 'button', title: 'Move the overlay so this Figma section lines up with its element',
          onclick: () => task('Aligning overlay…', async () => {
            const rects = await agent('fm:measure', { map: { [sec.id]: sel } });
            const r = rects[sec.id];
            if (!r) throw new Error('The linked element is no longer on the page. Pick it again.');
            S.page.overlay = { ...S.page.overlay, visible: true, source: 'design', x: 0, y: Math.round(r.top - sec.y) };
            await savePage();
            await pushOverlay(false);
            await agent('fm:flash', { selector: sel, title: `${sec.name} aligned (offset y ${S.page.overlay.y}px)` });
          }),
        }, 'Align overlay') : null,
        sel ? h('button', {
          class: 'btn small ghost', type: 'button', 'aria-label': `Unlink ${sec.name}`,
          onclick: async () => { delete S.page.map[sec.id]; await savePage(); renderSections(); },
        }, 'Unlink') : null)));
  }
}

function scoreClass(v) {
  if (v == null) return '';
  if (v >= 95) return 'good';
  if (v >= 85) return 'mid';
  return 'low';
}

function renderDiff() {
  const out = $('#diff-out');
  out.replaceChildren();
  const d = S.diff;
  if (!d) return;
  const cls = scoreClass(d.overall);
  out.append(
    h('div', { class: 'score' }, h('b', { class: cls, text: fmtPct(d.overall) }), h('span', { class: 'muted', text: 'overall pixel match' })),
    h('p', { class: 'muted small', text: `Page ${d.pageHeight}px tall vs Figma ${d.figmaHeight}px (${d.pageHeight - d.figmaHeight >= 0 ? '+' : ''}${d.pageHeight - d.figmaHeight}px).${d.truncated ? ' The page was cut at 30,000px.' : ''} Text never matches 100%, because Figma and Chrome draw fonts differently. Look for red blocks, shifted edges and missing elements.` }),
    h('div', { class: 'row gap' },
      h('button', {
        class: 'btn small', type: 'button',
        onclick: () => task('Updating overlay…', async () => {
          S.page.overlay = { ...S.page.overlay, visible: true, source: 'diff' };
          await savePage(); await pushOverlay(false);
        }),
      }, 'Show heatmap on page'),
      h('button', {
        class: 'btn small ghost', type: 'button',
        onclick: () => task('Updating overlay…', async () => {
          S.page.overlay = { ...S.page.overlay, visible: false };
          await savePage(); await pushOverlay(false); await agent('fm:clear-marks');
        }),
      }, 'Hide')),
  );
  const list = h('ul', { class: 'list' });
  const sorted = [...d.sections].sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
  for (const s of sorted) {
    const sec = S.design.sections.find((x) => x.id === s.id);
    const c = scoreClass(s.score);
    list.append(h('li', {
      class: 'item clickable', tabindex: '0', role: 'button',
      onclick: () => task('Locating…', () => agent('fm:flash', { selector: S.page.map?.[s.id] || null, figma: sec ? figmaRectFor(sec, s.py) : null, title: `${s.name} · ${fmtPct(s.score)}` })),
      onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); },
    },
    h('div', { class: 'item-head' },
      h('span', { class: 'item-title', title: s.name, text: s.name }),
      h('b', { class: c, text: fmtPct(s.score) })),
    h('div', { class: `bar ${c === 'good' ? '' : c}` }, h('i', { style: `width:${Math.max(0, Math.min(100, s.score ?? 0))}%` })),
    h('div', {
      class: 'item-meta',
      text: s.mapped
        ? `${s.label} · height ${s.ph}px vs ${s.fh}px (${s.heightDelta > 0 ? '+' : ''}${s.heightDelta}px)`
        : 'Not linked: compared at the same position as in Figma. Link it in Sections for a fair result.',
    })));
  }
  out.append(list);
}

function renderSpec() {
  const out = $('#spec-out');
  const filters = $('#spec-filters');
  out.replaceChildren();
  filters.replaceChildren();
  const sp = S.spec;
  filters.hidden = !sp;
  if (!sp) return;

  out.append(h('div', { class: 'summary' },
    h('div', {}, h('b', { text: String(sp.total) }), h('span', { text: 'Figma texts' })),
    h('div', {}, h('b', { text: String(sp.matched) }), h('span', { text: 'found' })),
    h('div', {}, h('b', { class: sp.results.length ? 'low' : 'good', text: String(sp.results.length) }), h('span', { text: 'with issues' })),
    h('div', {}, h('b', { class: sp.missing.length ? 'mid' : 'good', text: String(sp.missing.length) }), h('span', { text: 'not found' }))));
  if (S.specStale) out.append(h('p', { class: 'callout', text: 'The page was reloaded. Run the check again to update the results and highlights.' }));

  for (const [key, label, props] of FILTERS) {
    const count = key === 'all' ? sp.results.length : sp.results.filter((r) => r.problems.some((p) => props.includes(p.prop))).length;
    filters.append(h('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(S.specFilter === key),
      onclick: () => { S.specFilter = key; renderSpec(); },
    }, `${label} ${count}`));
  }
  const f = FILTERS.find((x) => x[0] === S.specFilter);
  const props = f && f[2];
  const rows = sp.results
    .map((r) => (props ? { ...r, problems: r.problems.filter((p) => props.includes(p.prop)) } : r))
    .filter((r) => r.problems.length);

  for (const [sec, items] of groupBy(rows, (r) => r.section || 'Other')) {
    out.append(h('div', { class: 'group-title', text: `${sec} (${items.length})` }));
    const list = h('ul', { class: 'list' });
    for (const r of items) {
      list.append(h('li', {
        class: 'item clickable', tabindex: '0', role: 'button',
        onclick: () => task('Highlighting…', async () => {
          if (S.specStale) throw new Error('Run the spec check again after reloading the page.');
          await agent('fm:highlight', { ref: r.ref, expected: r.expected, title: `“${r.text}”`, problems: r.problems });
        }),
        onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); },
      },
      h('div', { class: 'item-head' }, h('span', { class: 'item-title', title: r.text, text: `“${r.text}”` })),
      h('div', { class: 'item-meta', text: r.label + (r.mixed ? ' · mixed styles in Figma' : '') }),
      ...r.problems.map((p) => h('div', { class: 'problem' },
        h('span', { class: 'p', text: p.prop }),
        h('span', { class: 'v' },
          h('span', { class: 'f', text: p.figma }), ' → ', h('span', { class: 's', text: p.site }),
          p.hint ? h('span', { class: 'muted', text: ` · ${p.hint}` }) : null)))));
    }
    out.append(list);
  }
  if (!rows.length) out.append(h('p', { class: 'muted', text: 'No issues in this category.' }));

  if (sp.missing.length) {
    const det = h('details', { class: 'note' }, h('summary', { text: `Figma texts not found on the page (${sp.missing.length})` }));
    const ul = h('ul');
    sp.missing.forEach((m) => ul.append(h('li', { text: `“${m.text}” — ${m.section}` })));
    det.append(ul);
    out.append(det);
  }
}

/* ==================================================================== */
/* events                                                               */
/* ==================================================================== */
let currentTab = 'overlay';

async function overlayChange(patch) {
  if (!S.page) return;
  S.page.overlay = { ...S.page.overlay, ...patch };
  renderOverlay();
  await savePage();
  try { await pushOverlay(false); } catch (e) { status(e.message, 'error'); }
}

function bind() {
  $('#login-form').addEventListener('submit', signIn);
  $('#toggle-token').addEventListener('click', () => {
    const t = $('#token');
    t.type = t.type === 'password' ? 'text' : 'password';
    $('#toggle-token').textContent = t.type === 'password' ? 'Show' : 'Hide';
  });
  $('#signout').addEventListener('click', (e) => { if (armed(e.currentTarget, 'Confirm sign out')) signOut(false); });
  $('#allow-site').addEventListener('click', allowSite);

  $('#design-form').addEventListener('submit', (e) => {
    e.preventDefault();
    task('Loading frame…', () => loadDesign($('#figma-url').value, false));
  });
  $('#refresh-design').addEventListener('click', () => task('Refreshing from Figma…', () => loadDesign(S.page.figmaUrl, true)));
  $('#unlink-design').addEventListener('click', (e) => { if (armed(e.currentTarget, 'Click again to unlink')) task('Unlinking…', unlinkDesign); });

  $('#lock-toggle').addEventListener('change', (e) => {
    const on = e.target.checked;
    task(on ? 'Locking viewport…' : 'Unlocking viewport…', async () => {
      if (on) await lockViewport(); else { await detach(S.tabId); await pushOverlay(false).catch(() => {}); }
    });
  });
  $('#freeze-toggle').addEventListener('change', (e) => {
    const on = e.target.checked;
    task(on ? 'Freezing animations…' : 'Restoring…', async () => {
      await setFreeze(on);
      if (!on) status('Animations unfrozen. Reload the page to restart sliders and smooth scroll.', 'info', 5000);
    });
  });

  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    currentTab = b.dataset.tab;
    $$('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    renderReady();
  }));

  $('#ov-visible').addEventListener('change', (e) => overlayChange({ visible: e.target.checked }));
  $$('input[name="ov-source"]').forEach((r) => r.addEventListener('change', () => overlayChange({ source: r.value, visible: true })));
  $$('input[name="ov-blend"]').forEach((r) => r.addEventListener('change', () => overlayChange({ blend: r.value, source: 'design', visible: true })));
  $('#ov-opacity').addEventListener('input', (e) => overlayChange({ opacity: Number(e.target.value) / 100 }));
  $('#ov-x').addEventListener('change', (e) => overlayChange({ x: Math.round(Number(e.target.value) || 0) }));
  $('#ov-y').addEventListener('change', (e) => overlayChange({ y: Math.round(Number(e.target.value) || 0) }));
  $$('[data-nudge]').forEach((b) => b.addEventListener('click', (e) => {
    const [axis, d] = b.dataset.nudge.split(':');
    const step = Number(d) * (e.shiftKey ? 10 : 1);
    overlayChange({ [axis]: (S.page?.overlay?.[axis] || 0) + step, visible: true });
  }));
  $('#ov-reset').addEventListener('click', () => overlayChange({ x: 0, y: 0 }));

  $('#sec-auto').addEventListener('click', () => task('Matching sections…', autoMap));
  $('#sec-clear').addEventListener('click', async (e) => {
    if (!S.page || !armed(e.currentTarget, 'Click again to clear')) return;
    S.page.map = {};
    await savePage();
    renderSections();
  });

  $('#diff-threshold').addEventListener('input', (e) => { $('#diff-threshold-val').textContent = Number(e.target.value).toFixed(2); });
  $('#diff-run').addEventListener('click', () => task('Running pixel diff…', runDiff));
  $('#spec-run').addEventListener('click', () => task('Running spec check…', runSpec));
  $('#copy-report').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(reportMarkdown());
      status('Fix list copied to the clipboard.');
    } catch (_) {
      status('Could not copy to the clipboard.', 'error');
    }
  });

  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    const w = await chrome.windows.get(windowId).catch(() => null);
    if (w?.type === 'normal') retarget(tabId);
  });
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId < 0) return;
    const w = await chrome.windows.get(windowId, { populate: true }).catch(() => null);
    if (w?.type !== 'normal') return;
    const t = w.tabs.find((x) => x.active);
    if (t) retarget(t.id);
  });
  chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === S.tabId) { S.tabId = null; refreshTab(); } });
  $('#scrollbar-toggle').addEventListener('change', (e) => {
    S.hideScrollbar = e.target.checked;
    setLocal('fmHideScrollbar', S.hideScrollbar);
    task('Updating…', refreshViewport);
  });
  $('#vp-refresh').addEventListener('click', () => task('Measuring…', refreshViewport));
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId !== S.tabId) return;
    if (info.url) refreshTab();
    if (info.status === 'complete') onTabLoaded();
  });
  chrome.permissions.onRemoved.addListener(() => refreshTab());
}

async function onTabLoaded() {
  const prevKey = S.pageKey;
  await refreshTab();
  if (!S.token || !S.allowed || !S.design || S.pageKey !== prevKey) return;
  // Same page reloaded (e.g. after you edited CSS): restore everything.
  try {
    if (S.spec) S.specStale = true;
    const lock = S.locks.get(S.tabId);
    if (lock && S.attached.has(S.tabId)) {
      await setMetrics(lock, lock.scale);
      try { await cdp('Emulation.setScrollbarsHidden', { hidden: true }); } catch (_) {}
    }
    if (S.frozen) await setFreeze(true);
    await pushOverlay(true);
    await refreshViewport();
  } catch (_) { /* page may still be busy */ }
  renderAll();
}

/* ==================================================================== */
/* boot                                                                 */
/* ==================================================================== */
async function init() {
  connectPort();
  bind();
  S.hideScrollbar = await getLocal('fmHideScrollbar', true);
  S.token = await loadToken();
  if (S.token) {
    S.user = (await chrome.storage.session.get('fmUser')).fmUser || (await chrome.storage.local.get('fmUser')).fmUser || null;
    try {
      const me = await getMe(S.token);
      S.user = { handle: me.handle, email: me.email, img: me.img };
    } catch (e) {
      if (e.code === 'AUTH') {
        await clearAll();
        S.token = null;
        status('Your Figma token expired or was revoked. Please sign in again.', 'error', 7000);
      }
    }
  }
  showView();
  await refreshTab();
}

init();
