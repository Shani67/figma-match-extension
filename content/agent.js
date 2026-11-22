/*
 * Figma Match – page agent (content script, isolated world).
 * Injected on demand by the side panel only on sites you have allowed.
 * It never sees the Figma token; it only receives images and node data
 * from the extension and only accepts messages from this extension.
 */
(() => {
  if (window.__figmaMatchAgent) return;
  window.__figmaMatchAgent = true;

  /* ------------------------------------------------------------------ */
  /* state                                                              */
  /* ------------------------------------------------------------------ */
  const state = {
    visible: false,
    source: 'design', // 'design' | 'diff'
    opacity: 0.5,
    diffOpacity: 0.85,
    blend: 'normal', // 'normal' | 'difference'
    x: 0,
    y: 0,
    frameWidth: 1440,
  };
  let designSrc = null;
  let diffSrc = null;
  let shownSrc = null;

  let overlayHost = null;
  let overlayImg = null;
  let uiHost = null;
  let uiRoot = null;
  let picking = null;
  let refs = [];
  let hiddenFixed = [];
  let savedScroll = 0;
  let capturing = false;

  const SKIP = new Set(['script', 'style', 'link', 'noscript', 'template', 'meta', 'head', 'title', 'iframe', 'svg']);
  const isOurs = (el) => !!el && el.nodeType === 1 && el.localName.startsWith('figma-match');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = (n = 2) => new Promise((r) => {
    const step = () => (--n <= 0 ? r() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

  function imp(el, styles) {
    for (const [k, v] of Object.entries(styles)) el.style.setProperty(k, v, 'important');
  }

  /* ------------------------------------------------------------------ */
  /* overlay                                                            */
  /* ------------------------------------------------------------------ */
  function ensureOverlay() {
    if (overlayHost && overlayHost.isConnected) return;
    overlayHost = document.createElement('figma-match-overlay');
    const root = overlayHost.attachShadow({ mode: 'closed' });
    overlayImg = document.createElement('img');
    overlayImg.alt = '';
    overlayImg.draggable = false;
    imp(overlayImg, {
      display: 'block', width: '100%', height: 'auto', 'max-width': 'none',
      margin: '0', padding: '0', border: '0', 'user-select': 'none',
    });
    overlayImg.addEventListener('error', () => {
      toast('The overlay image was blocked. This site’s Content-Security-Policy may disallow data: images.', 6000);
    });
    root.appendChild(overlayImg);
    shownSrc = null;
    document.documentElement.appendChild(overlayHost);
  }

  const baseLeft = () => Math.max(0, Math.round((document.documentElement.clientWidth - state.frameWidth) / 2));

  function render() {
    const isDiff = state.source === 'diff';
    const src = isDiff ? diffSrc : designSrc;
    if (!state.visible || !src) {
      if (overlayHost) imp(overlayHost, { display: 'none' });
      return;
    }
    ensureOverlay();
    if (shownSrc !== src) {
      overlayImg.src = src;
      shownSrc = src;
    }
    imp(overlayHost, {
      all: 'initial',
      display: 'block',
      position: 'absolute',
      top: `${isDiff ? 0 : state.y}px`,
      left: `${baseLeft() + (isDiff ? 0 : state.x)}px`,
      width: `${state.frameWidth}px`,
      margin: '0',
      padding: '0',
      'z-index': '2147483646',
      'pointer-events': 'none',
      opacity: String(isDiff ? state.diffOpacity : state.opacity),
      'mix-blend-mode': isDiff ? 'normal' : state.blend,
    });
  }

  const publicState = () => ({ ...state, hasDesign: !!designSrc, hasDiff: !!diffSrc });

  function notify() {
    chrome.runtime.sendMessage({ type: 'fm:overlay-state', state: publicState() }).catch(() => {});
  }

  function pageInfo() {
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      clientWidth: document.documentElement.clientWidth,
      dpr: window.devicePixelRatio,
      docHeight: docHeight(),
      url: location.href,
      frozen: !!document.getElementById('figma-match-freeze'),
      scrollbarHidden: !!document.getElementById('figma-match-noscroll'),
    };
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (state.visible) render();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'fm:viewport', info: pageInfo() }).catch(() => {});
    }, 250);
  });

  function hideScrollbar(on) {
    let s = document.getElementById('figma-match-noscroll');
    if (on && !s) {
      s = document.createElement('style');
      s.id = 'figma-match-noscroll';
      s.textContent = 'html{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}';
      document.documentElement.appendChild(s);
    } else if (!on && s) {
      s.remove();
    }
    if (state.visible) render();
    return on;
  }

  /* ------------------------------------------------------------------ */
  /* UI layer (highlights, picker, toast)                               */
  /* ------------------------------------------------------------------ */
  const UI_CSS = `
    :host{all:initial}
    .box{position:absolute;box-sizing:border-box;pointer-events:none}
    .site{border:2px solid #0acf83;background:rgba(10,207,131,.08)}
    .figma{border:2px dashed #f24e1e;background:rgba(242,78,30,.06)}
    .pick{border:2px solid #7b61ff;background:rgba(123,97,255,.12)}
    .label{position:absolute;max-width:420px;font:12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
      color:#fff;background:#111827;padding:6px 8px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.3);
      white-space:pre-wrap;pointer-events:none}
    .label b{color:#a5b4fc;font-weight:600}
    .toast{position:fixed;left:16px;bottom:16px;font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
      color:#fff;background:#111827;padding:8px 12px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.35);
      max-width:420px;pointer-events:none}
    .bar{position:fixed;right:16px;bottom:16px;display:flex;align-items:center;gap:4px;padding:6px;background:#111827;color:#e5e7eb;
      border-radius:10px;font:12px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35);
      pointer-events:auto;user-select:none;-webkit-user-select:none}
    .bar button{all:unset;cursor:pointer;padding:6px 8px;border-radius:6px;background:#1f2937;color:#e5e7eb;font:inherit;white-space:nowrap}
    .bar button:hover{background:#374151}
    .bar button[aria-pressed="true"]{background:#7b61ff;color:#fff}
    .bar button:focus-visible{outline:2px solid #a5b4fc}
    .bar input[type=range]{width:84px;accent-color:#7b61ff;margin:0 4px}
    .bar .grip{cursor:move;padding:6px 4px 6px 6px;color:#9ca3af;font-weight:700;letter-spacing:.02em}
    .bar .meta{color:#9ca3af;padding:0 4px;min-width:64px;text-align:center}
    .bar .sep{width:1px;height:18px;background:#374151;margin:0 2px}
    .bar.min .opt{display:none}
    .banner{position:fixed;left:50%;top:12px;transform:translateX(-50%);font:13px/1.4 system-ui,sans-serif;color:#fff;
      background:#7b61ff;padding:8px 14px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.3);pointer-events:none;white-space:nowrap}
  `;

  function ensureUi() {
    if (uiHost && uiHost.isConnected) return;
    uiHost = document.createElement('figma-match-ui');
    uiRoot = uiHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    uiRoot.appendChild(style);
    imp(uiHost, {
      all: 'initial', position: 'absolute', top: '0', left: '0', width: '0', height: '0',
      'z-index': '2147483647', 'pointer-events': 'none', display: 'block',
    });
    document.documentElement.appendChild(uiHost);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clearLayer(cls) {
    if (!uiRoot) return;
    uiRoot.querySelectorAll(cls ? `.${cls}` : '.box,.label,.banner').forEach((n) => n.remove());
  }

  function drawBox(r, cls, group) {
    ensureUi();
    const b = el('div', `box ${cls} ${group || ''}`);
    Object.assign(b.style, { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
    uiRoot.appendChild(b);
    return b;
  }

  function drawLabel(r, lines, group) {
    ensureUi();
    const l = el('div', `label ${group || ''}`);
    lines.forEach((line, i) => {
      if (i) l.appendChild(document.createTextNode('\n'));
      if (Array.isArray(line)) {
        l.appendChild(el('b', '', line[0]));
        l.appendChild(document.createTextNode(` ${line[1]}`));
      } else {
        l.appendChild(document.createTextNode(line));
      }
    });
    const top = r.top - 8 > window.scrollY + 40 ? r.top - 8 : r.top + r.height + 8;
    Object.assign(l.style, { top: `${top}px`, left: `${Math.max(4, r.left)}px` });
    if (top < r.top) l.style.transform = 'translateY(-100%)';
    uiRoot.appendChild(l);
  }

  let toastTimer = null;
  function toast(msg, ms = 1800) {
    ensureUi();
    clearTimeout(toastTimer);
    uiRoot.querySelectorAll('.toast').forEach((n) => n.remove());
    uiRoot.appendChild(el('div', 'toast', msg));
    toastTimer = setTimeout(() => uiRoot && uiRoot.querySelectorAll('.toast').forEach((n) => n.remove()), ms);
  }

  /* ------------------------------------------------------------------ */
  /* DOM helpers                                                        */
  /* ------------------------------------------------------------------ */
  function docRect(node) {
    const r = node.getBoundingClientRect();
    return {
      top: Math.round(r.top + window.scrollY),
      left: Math.round(r.left + window.scrollX),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  }

  function uniqueId(n) {
    if (!n.id) return null;
    const sel = `#${CSS.escape(n.id)}`;
    try { return document.querySelectorAll(sel).length === 1 ? sel : null; } catch (_) { return null; }
  }

  function selectorFor(target) {
    const own = uniqueId(target);
    if (own) return own;
    const parts = [];
    let n = target;
    while (n && n.nodeType === 1 && n !== document.body && n !== document.documentElement) {
      const id = uniqueId(n);
      if (id) { parts.unshift(id); break; }
      const tag = n.localName;
      let i = 1;
      let s = n;
      while ((s = s.previousElementSibling)) if (s.localName === tag) i++;
      parts.unshift(`${tag}:nth-of-type(${i})`);
      n = n.parentElement;
    }
    if (!parts.length || !parts[0].startsWith('#')) parts.unshift('body');
    return parts.join(' > ');
  }

  function labelFor(n) {
    const cls = [...n.classList].filter((c) => !/^(aos|lenis|slick|swiper)/.test(c)).slice(0, 2);
    return n.localName + (n.id ? `#${n.id}` : '') + (cls.length ? `.${cls.join('.')}` : '');
  }

  function query(sel) {
    try { return document.querySelector(sel); } catch (_) { return null; }
  }

  function visible(n) {
    const r = n.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(n);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  /* ------------------------------------------------------------------ */
  /* element picker                                                     */
  /* ------------------------------------------------------------------ */
  function pick(title) {
    cancelPick();
    ensureUi();
    return new Promise((resolve) => {
      let current = null;
      const stack = [];
      const banner = el('div', 'banner', `${title || 'Click the matching element'} · ↑ parent · ↓ child · Enter select · Esc cancel`);
      uiRoot.appendChild(banner);

      const draw = () => {
        clearLayer('pickbox');
        if (!current) return;
        const r = docRect(current);
        drawBox(r, 'pick', 'pickbox');
        drawLabel(r, [[labelFor(current), `${r.width}×${r.height}`]], 'pickbox');
      };
      const move = (e) => {
        const t = document.elementFromPoint(e.clientX, e.clientY);
        if (!t || isOurs(t) || t === current) return;
        current = t;
        stack.length = 0;
        draw();
      };
      const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
      const finish = (target) => {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('keydown', key, true);
        ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'contextmenu'].forEach((t) => window.removeEventListener(t, t === 'click' ? click : swallow, true));
        clearLayer('pickbox');
        banner.remove();
        picking = null;
        resolve(target ? { selector: selectorFor(target), label: labelFor(target), rect: docRect(target) } : null);
      };
      const click = (e) => { swallow(e); finish(current); };
      const key = (e) => {
        if (e.key === 'Escape') finish(null);
        else if (e.key === 'Enter' && current) finish(current);
        else if (e.key === 'ArrowUp' && current?.parentElement && current.parentElement !== document.documentElement) {
          stack.push(current); current = current.parentElement; draw();
        } else if (e.key === 'ArrowDown' && stack.length) {
          current = stack.pop(); draw();
        } else return;
        swallow(e);
      };
      window.addEventListener('mousemove', move, true);
      window.addEventListener('keydown', key, true);
      ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'contextmenu'].forEach((t) => window.addEventListener(t, t === 'click' ? click : swallow, true));
      picking = { cancel: () => finish(null) };
    });
  }

  function cancelPick() {
    if (picking) picking.cancel();
  }

  /* ------------------------------------------------------------------ */
  /* section mapping                                                    */
  /* ------------------------------------------------------------------ */
  function docHeight() {
    // Ignore our own overlay, which can be taller than the page.
    const shown = overlayHost && overlayHost.isConnected && overlayHost.style.getPropertyValue('display') !== 'none';
    if (shown) overlayHost.style.setProperty('display', 'none', 'important');
    const value = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    if (shown) overlayHost.style.setProperty('display', 'block', 'important');
    return value;
  }

  function domBlocks() {
    const vw = document.documentElement.clientWidth;
    const H = docHeight();
    const ok = (n) => {
      if (isOurs(n) || SKIP.has(n.localName)) return false;
      const r = n.getBoundingClientRect();
      if (r.height < 24 || r.width < vw * 0.6) return false;
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (cs.position === 'fixed' && r.top > 5) return false;
      return true;
    };
    const kids = (n) => [...n.children].filter(ok);
    const out = [];
    const visit = (n, depth) => {
      for (const k of kids(n)) {
        const sub = kids(k);
        const h = k.getBoundingClientRect().height;
        if (depth < 6 && sub.length >= 2 && h > H * 0.4) visit(k, depth + 1);
        else out.push(k);
      }
    };
    if (document.body) visit(document.body, 0);
    return out.map((n) => ({ el: n, ...docRect(n) })).sort((a, b) => a.top - b.top);
  }

  function autoMap({ sections, frameHeight }) {
    const map = {};
    document.querySelectorAll('[data-figma-node]').forEach((n) => {
      const id = String(n.getAttribute('data-figma-node')).replace(/-/g, ':');
      if (sections.some((s) => s.id === id)) map[id] = selectorFor(n);
    });
    const blocks = domBlocks();
    const H = docHeight() || 1;
    const FH = frameHeight || 1;
    const todo = sections.filter((s) => !map[s.id]);
    if (todo.length && todo.length === blocks.length) {
      todo.forEach((s, i) => { map[s.id] = selectorFor(blocks[i].el); });
      return map;
    }
    let j = 0;
    for (const s of todo) {
      let best = -1;
      let bestD = Infinity;
      for (let k = j; k < blocks.length; k++) {
        const b = blocks[k];
        const d = Math.abs(b.top / H - s.y / FH) + 0.5 * Math.abs(b.height / H - s.h / FH);
        if (d < bestD) { bestD = d; best = k; }
      }
      if (best > -1 && bestD < 0.12) {
        map[s.id] = selectorFor(blocks[best].el);
        j = best + 1;
      }
    }
    return map;
  }

  function measure({ map }) {
    const out = {};
    for (const [id, sel] of Object.entries(map || {})) {
      const n = query(sel);
      out[id] = n ? { ...docRect(n), label: labelFor(n) } : null;
    }
    return out;
  }

  function flash({ selector, figma, title }) {
    clearLayer();
    const n = selector ? query(selector) : null;
    let r = null;
    if (n) {
      n.scrollIntoView({ block: 'start', behavior: 'instant' });
      r = docRect(n);
      drawBox(r, 'site');
    } else if (figma) {
      window.scrollTo({ top: Math.max(0, figma.top - 40), behavior: 'instant' });
    }
    if (figma) drawBox(figma, 'figma');
    const lines = [title || ''];
    if (r && figma) lines.push(['Height', `site ${r.height}px · Figma ${figma.height}px (${r.height - figma.height >= 0 ? '+' : ''}${r.height - figma.height}px)`]);
    if (r || figma) drawLabel(r || figma, lines);
    return !!n;
  }

  /* ------------------------------------------------------------------ */
  /* freeze / capture                                                   */
  /* ------------------------------------------------------------------ */
  const FREEZE_CSS = `
    *,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;
      transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;caret-color:transparent!important}
    html,body{scroll-behavior:auto!important}
    [data-aos]{opacity:1!important;transform:none!important;visibility:visible!important}
    .wow,.animate__animated,.reveal,.fade-up,.fade-in{opacity:1!important;visibility:visible!important;transform:none!important}
  `;

  function freeze(on) {
    let s = document.getElementById('figma-match-freeze');
    if (on && !s) {
      s = document.createElement('style');
      s.id = 'figma-match-freeze';
      s.textContent = FREEZE_CSS;
      document.documentElement.appendChild(s);
      document.querySelectorAll('img[loading="lazy"]').forEach((i) => { i.loading = 'eager'; });
      document.querySelectorAll('video').forEach((v) => { try { v.pause(); v.currentTime = 0; } catch (_) {} });
    } else if (!on && s) {
      s.remove();
    }
    return on;
  }

  async function preload() {
    const vh = window.innerHeight;
    for (let y = 0; y < docHeight(); y += Math.round(vh * 0.8)) {
      window.scrollTo({ top: y, left: 0, behavior: 'instant' });
      await sleep(70);
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    const pending = [...document.images].filter((i) => !i.complete);
    await Promise.race([
      Promise.all(pending.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
      sleep(4000),
    ]);
    try { await Promise.race([document.fonts.ready, sleep(3000)]); } catch (_) {}
    await frames(2);
    return true;
  }

  function setHostsHidden(hidden) {
    [overlayHost, uiHost].forEach((h) => { if (h) h.style.setProperty('visibility', hidden ? 'hidden' : 'visible', 'important'); });
  }

  function captureBegin() {
    cancelPick();
    capturing = true;
    savedScroll = window.scrollY;
    setHostsHidden(true);
    if (overlayHost) imp(overlayHost, { display: 'none' });
    return {
      docHeight: docHeight(),
      vh: window.innerHeight,
      vw: document.documentElement.clientWidth,
    };
  }

  function hideFixedElements() {
    if (hiddenFixed.length) return;
    for (const n of document.body.querySelectorAll('*')) {
      if (isOurs(n)) continue;
      const p = getComputedStyle(n).position;
      if (p === 'fixed' || p === 'sticky') {
        hiddenFixed.push([n, n.style.getPropertyValue('visibility'), n.style.getPropertyPriority('visibility')]);
        n.style.setProperty('visibility', 'hidden', 'important');
      }
    }
  }

  async function scrollToY({ y, hideFixed, settle = 250 }) {
    if (hideFixed) hideFixedElements();
    window.scrollTo({ top: y, left: 0, behavior: 'instant' });
    await frames(2);
    await sleep(settle);
    return { scrollY: Math.round(window.scrollY) };
  }

  function captureEnd() {
    if (!capturing) { render(); return true; }
    capturing = false;
    hiddenFixed.forEach(([n, v, p]) => {
      if (v) n.style.setProperty('visibility', v, p); else n.style.removeProperty('visibility');
    });
    hiddenFixed = [];
    window.scrollTo({ top: savedScroll, left: 0, behavior: 'instant' });
    setHostsHidden(false);
    render();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* spec check                                                         */
  /* ------------------------------------------------------------------ */
  const keyOf = (s) => String(s).normalize('NFKC').toLowerCase()
    .replace(/[‘’‚′`]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[\s ​‌‍﻿]+/g, '');

  const hex = (c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}${c.a < 1 ? ` @${Math.round(c.a * 100)}%` : ''}`;

  function parseColor(str) {
    const m = String(str).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?/i);
    if (!m) return null;
    let a = m[4] == null ? 1 : parseFloat(m[4]);
    if (String(m[4]).endsWith('%')) a /= 100;
    return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]), a: Math.round(a * 100) / 100 };
  }

  const famKey = (f) => String(f).replace(/["']/g, '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const px = (v) => `${Math.round(v * 100) / 100}px`;
  const snippet = (s, n = 70) => {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };

  function lineCount(n) {
    const range = document.createRange();
    range.selectNodeContents(n);
    const tops = [];
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      if (!tops.some((t) => Math.abs(t - r.top) < r.height * 0.5)) tops.push(r.top);
    }
    return { lines: tops.length, rect: range.getBoundingClientRect() };
  }

  function buildIndex() {
    const index = new Map();
    if (!document.body) return index;
    for (const n of document.body.querySelectorAll('*')) {
      if (isOurs(n) || SKIP.has(n.localName) || n instanceof SVGElement) continue;
      const t = n.textContent;
      if (!t || t.length > 1500) continue;
      const k = keyOf(t);
      if (!k) continue;
      let arr = index.get(k);
      if (!arr) index.set(k, (arr = []));
      arr.push(n);
    }
    return index;
  }

  function deepest(list) {
    return list.filter((a) => !list.some((b) => b !== a && a.contains(b)));
  }

  function spec({ texts, sections, map, frameWidth, tol }) {
    state.frameWidth = frameWidth || state.frameWidth;
    refs = [];
    const T = { fontSize: 0.5, lineHeight: 1, letterSpacing: 0.2, color: 6, position: 4, ...(tol || {}) };
    const left0 = baseLeft();

    // Section shifts (site top - Figma top) for mapped sections.
    const sorted = [...sections].sort((a, b) => a.y - b.y);
    const shifts = new Map();
    for (const s of sorted) {
      const n = map && map[s.id] ? query(map[s.id]) : null;
      if (n) shifts.set(s.id, docRect(n).top - s.y);
    }
    const sectionOf = (t) => {
      const cy = t.y + Math.min(t.h, 40) / 2;
      const hits = sorted.filter((s) => cy >= s.y && cy < s.y + s.h).sort((a, b) => a.h - b.h);
      return hits[0] || [...sorted].reverse().find((s) => s.y <= cy) || sorted[0];
    };
    const shiftFor = (sec) => {
      if (!sec) return 0;
      if (shifts.has(sec.id)) return shifts.get(sec.id);
      const above = sorted.filter((s) => s.y <= sec.y && shifts.has(s.id)).pop();
      return above ? shifts.get(above.id) : 0;
    };

    const index = buildIndex();
    const keys = [...index.keys()];
    const results = [];
    const missing = [];
    let matched = 0;

    for (const t of texts) {
      const sec = sectionOf(t);
      const shift = shiftFor(sec);
      const expected = { left: Math.round(left0 + t.x), top: Math.round(t.y + shift), width: Math.round(t.w), height: Math.round(t.h) };
      const k = keyOf(t.chars);
      let cands = index.get(k);
      let partial = false;
      if (!cands && k.length >= 12) {
        const head = k.slice(0, Math.min(24, k.length));
        const near = keys.filter((x) => x.length >= 8 && (x.startsWith(head) || (k.startsWith(x.slice(0, 24)) && x.length >= 12)));
        if (near.length) {
          cands = near.flatMap((x) => index.get(x));
          partial = true;
        }
      }
      cands = cands ? deepest(cands).filter(visible) : [];
      if (!cands.length) {
        missing.push({ id: t.id, text: snippet(t.chars, 90), section: sec?.name || '', expected });
        continue;
      }
      // Closest to where Figma expects it.
      let best = cands[0];
      let bestD = Infinity;
      for (const c of cands) {
        const r = docRect(c);
        const d = Math.abs(r.top - expected.top) + Math.abs(r.left - expected.left) * 0.5;
        if (d < bestD) { bestD = d; best = c; }
      }
      matched++;
      const n = best;
      const cs = getComputedStyle(n);
      const problems = [];
      const add = (prop, figma, site, hint) => problems.push({ prop, figma, site, hint: hint || '' });

      if (partial) add('content', snippet(t.chars, 120), snippet(n.textContent, 120), 'Text differs from Figma');

      const fs = parseFloat(cs.fontSize);
      if (t.fontSize && Math.abs(fs - t.fontSize) > T.fontSize) add('font-size', px(t.fontSize), px(fs));

      const fw = parseInt(cs.fontWeight, 10);
      if (t.fontWeight && fw !== t.fontWeight) add('font-weight', String(t.fontWeight), String(fw));

      const siteFam = cs.fontFamily.split(',')[0];
      if (t.fontFamily && famKey(siteFam) !== famKey(t.fontFamily)
        && !famKey(siteFam).includes(famKey(t.fontFamily)) && !famKey(t.fontFamily).includes(famKey(siteFam))) {
        add('font-family', t.fontFamily, siteFam.replace(/["']/g, '').trim());
      }

      if (t.italic !== (cs.fontStyle === 'italic' || cs.fontStyle.startsWith('oblique'))) {
        add('font-style', t.italic ? 'italic' : 'normal', cs.fontStyle);
      }

      const lhSite = cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight);
      if (t.lineHeightPx) {
        if (t.lineHeightAuto) {
          if (lhSite != null && Math.abs(lhSite - t.lineHeightPx) > Math.max(2, T.lineHeight)) add('line-height', `${px(t.lineHeightPx)} (auto)`, px(lhSite));
        } else if (lhSite == null) {
          add('line-height', px(t.lineHeightPx), 'normal');
        } else if (Math.abs(lhSite - t.lineHeightPx) > T.lineHeight) {
          add('line-height', px(t.lineHeightPx), px(lhSite));
        }
      }

      const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing);
      if (Math.abs(ls - (t.letterSpacing || 0)) > T.letterSpacing) add('letter-spacing', px(t.letterSpacing || 0), px(ls));

      const raw = n.textContent;
      const hasLower = /\p{Ll}/u.test(raw);
      const hasUpper = /\p{Lu}/u.test(raw);
      const tt = cs.textTransform;
      if (t.textCase === 'UPPER' && tt !== 'uppercase' && hasLower) add('text-transform', 'uppercase', tt);
      else if (t.textCase === 'LOWER' && tt !== 'lowercase' && hasUpper) add('text-transform', 'lowercase', tt);
      else if (t.textCase === 'TITLE' && tt !== 'capitalize') add('text-transform', 'capitalize', tt);
      else if (t.textCase === 'ORIGINAL' && tt === 'uppercase' && /\p{Ll}/u.test(t.chars)) add('text-transform', 'none', tt);

      if (t.color && !t.color.gradient) {
        const c = parseColor(cs.color);
        if (c) {
          const dc = Math.max(Math.abs(c.r - t.color.r), Math.abs(c.g - t.color.g), Math.abs(c.b - t.color.b));
          if (dc > T.color || Math.abs(c.a - t.color.a) > 0.06) add('color', hex(t.color), hex(c));
        }
      }

      const { lines, rect: tr } = lineCount(n);
      if (t.lineHeightPx > 0) {
        const fl = Math.max(1, Math.round(t.h / t.lineHeightPx));
        if (lines && fl !== lines) add('line wrap', `${fl} line${fl > 1 ? 's' : ''}`, `${lines} line${lines > 1 ? 's' : ''}`, 'Check max-width, padding or font size');
      }

      const r = docRect(n);
      const dy = r.top - expected.top;
      if (Math.abs(dy) > T.position) add('top', `${expected.top}px`, `${r.top}px`, `${dy > 0 ? 'lower' : 'higher'} by ${Math.abs(dy)}px`);

      const textLeft = Math.round(tr.left + window.scrollX);
      const textRight = Math.round(tr.right + window.scrollX);
      let dx = 0;
      if (t.align === 'CENTER') dx = Math.round((textLeft + textRight) / 2 - (expected.left + expected.width / 2));
      else if (t.align === 'RIGHT') dx = textRight - (expected.left + expected.width);
      else dx = textLeft - expected.left;
      if (Math.abs(dx) > T.position) add('left', `${t.align.toLowerCase()} edge`, `${dx > 0 ? '+' : ''}${dx}px`, `${dx > 0 ? 'right' : 'left'} by ${Math.abs(dx)}px`);

      if (problems.length) {
        refs.push(n);
        results.push({
          ref: refs.length - 1,
          id: t.id,
          text: snippet(t.chars),
          section: sec?.name || '',
          sectionId: sec?.id || null,
          selector: selectorFor(n),
          label: labelFor(n),
          mixed: t.mixed,
          expected,
          problems,
        });
      }
    }
    return { total: texts.length, matched, results, missing };
  }

  function highlight({ ref, expected, title, problems }) {
    clearLayer();
    const n = refs[ref];
    if (!n || !n.isConnected) return false;
    n.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = docRect(n);
    if (expected) drawBox(expected, 'figma');
    drawBox(r, 'site');
    const lines = [title || labelFor(n)];
    (problems || []).slice(0, 8).forEach((p) => lines.push([p.prop, `Figma ${p.figma} → site ${p.site}`]));
    lines.push('green = site · dashed orange = Figma');
    drawLabel(r, lines);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* floating toolbar on the page                                       */
  /* ------------------------------------------------------------------ */
  let bar = null;
  const barEls = {};

  function barButton(label, title, onClick, cls) {
    const b = el('button', cls || '', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
  }

  function changeFromBar(patch) {
    Object.assign(state, patch);
    render();
    syncBar();
    notify();
  }

  function ensureBar() {
    if (!designSrc) { if (bar) { bar.remove(); bar = null; } return; }
    ensureUi();
    if (bar && bar.isConnected) { syncBar(); return; }
    bar = el('div', 'bar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Figma Match overlay');
    const grip = el('span', 'grip', '⠿ FM');
    grip.title = 'Drag to move';
    barEls.eye = barButton('Overlay', 'Show / hide overlay (Alt+Shift+O)', () => changeFromBar({ visible: !state.visible }));
    barEls.design = barButton('Design', 'Show the Figma design', () => changeFromBar({ source: 'design', visible: true }), 'opt');
    barEls.diff = barButton('Heatmap', 'Show the pixel-diff heatmap (Alt+Shift+H)', () => changeFromBar({ source: 'diff', visible: true }), 'opt');
    barEls.blend = barButton('Difference', 'Difference blend (Alt+Shift+D)', () => changeFromBar({ blend: state.blend === 'difference' ? 'normal' : 'difference', source: 'design', visible: true }), 'opt');
    barEls.opacity = document.createElement('input');
    barEls.opacity.type = 'range';
    barEls.opacity.min = '5';
    barEls.opacity.max = '100';
    barEls.opacity.className = 'opt';
    barEls.opacity.title = 'Overlay opacity';
    barEls.opacity.addEventListener('input', (e) => { e.stopPropagation(); changeFromBar({ opacity: Number(barEls.opacity.value) / 100, visible: true }); });
    barEls.meta = el('span', 'meta opt', '');
    barEls.meta.title = 'Overlay offset. Nudge with Alt+Shift+arrows';
    barEls.reset = barButton('0,0', 'Reset offset', () => changeFromBar({ x: 0, y: 0 }), 'opt');
    barEls.min = barButton('–', 'Collapse / expand', () => { bar.classList.toggle('min'); barEls.min.textContent = bar.classList.contains('min') ? '+' : '–'; });
    const sep = () => { const s = el('span', 'sep opt'); return s; };
    bar.append(grip, barEls.eye, sep(), barEls.design, barEls.diff, barEls.blend, sep(), barEls.opacity, barEls.meta, barEls.reset, barEls.min);
    ['keydown', 'keyup', 'mousedown', 'pointerdown', 'wheel'].forEach((t) => bar.addEventListener(t, (e) => e.stopPropagation()));

    // drag
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = bar.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const move = (ev) => {
        const left = Math.min(window.innerWidth - r.width - 4, Math.max(4, ev.clientX - dx));
        const top = Math.min(window.innerHeight - r.height - 4, Math.max(4, ev.clientY - dy));
        Object.assign(bar.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
      };
      const up = () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
    });
    uiRoot.appendChild(bar);
    syncBar();
  }

  function syncBar() {
    if (!bar) return;
    barEls.eye.setAttribute('aria-pressed', String(state.visible));
    barEls.design.setAttribute('aria-pressed', String(state.visible && state.source === 'design'));
    barEls.diff.setAttribute('aria-pressed', String(state.visible && state.source === 'diff'));
    barEls.diff.hidden = !diffSrc;
    barEls.diff.style.display = diffSrc ? '' : 'none';
    barEls.blend.setAttribute('aria-pressed', String(state.blend === 'difference'));
    barEls.opacity.value = String(Math.round(state.opacity * 100));
    barEls.meta.textContent = `${Math.round(state.opacity * 100)}% · ${state.x},${state.y}`;
  }

  /* ------------------------------------------------------------------ */
  /* keyboard shortcuts (Alt+Shift+…)                                    */
  /* ------------------------------------------------------------------ */
  window.addEventListener('keydown', (e) => {
    if (picking || !e.altKey || !e.shiftKey || !designSrc) return;
    const step = e.ctrlKey || e.metaKey ? 10 : 1;
    let msg = null;
    switch (e.code) {
      case 'KeyO': state.visible = !state.visible; msg = state.visible ? 'Overlay on' : 'Overlay off'; break;
      case 'KeyD': state.blend = state.blend === 'difference' ? 'normal' : 'difference'; msg = `Blend: ${state.blend}`; break;
      case 'KeyH': state.source = state.source === 'diff' ? 'design' : 'diff'; msg = state.source === 'diff' ? 'Showing diff heatmap' : 'Showing Figma design'; break;
      case 'ArrowUp': state.y -= step; break;
      case 'ArrowDown': state.y += step; break;
      case 'ArrowLeft': state.x -= step; break;
      case 'ArrowRight': state.x += step; break;
      case 'BracketLeft': state.opacity = Math.max(0.05, Math.round((state.opacity - 0.1) * 100) / 100); break;
      case 'BracketRight': state.opacity = Math.min(1, Math.round((state.opacity + 0.1) * 100) / 100); break;
      case 'Digit0': state.x = 0; state.y = 0; msg = 'Offset reset'; break;
      default: return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!state.visible && e.code !== 'KeyO') state.visible = true;
    render();
    toast(msg || `Offset ${state.x}, ${state.y}px · opacity ${Math.round(state.opacity * 100)}%`);
    syncBar();
    notify();
  }, true);

  /* ------------------------------------------------------------------ */
  /* messaging                                                          */
  /* ------------------------------------------------------------------ */
  const handlers = {
    'fm:ping': () => ({ alive: true }),
    'fm:page-info': () => pageInfo(),
    'fm:scrollbar': (m) => hideScrollbar(!!m.hide),
    'fm:overlay-set': (m) => {
      if (typeof m.designSrc === 'string' || m.designSrc === null) designSrc = m.designSrc;
      if (typeof m.diffSrc === 'string' || m.diffSrc === null) diffSrc = m.diffSrc;
      const p = m.state || {};
      if (typeof p.visible === 'boolean') state.visible = p.visible;
      if (p.source === 'design' || p.source === 'diff') state.source = p.source;
      if (p.blend === 'normal' || p.blend === 'difference') state.blend = p.blend;
      if (Number.isFinite(p.opacity)) state.opacity = Math.min(1, Math.max(0, p.opacity));
      if (Number.isFinite(p.diffOpacity)) state.diffOpacity = Math.min(1, Math.max(0, p.diffOpacity));
      if (Number.isFinite(p.x)) state.x = Math.round(p.x);
      if (Number.isFinite(p.y)) state.y = Math.round(p.y);
      if (Number.isFinite(p.frameWidth) && p.frameWidth > 0) state.frameWidth = Math.round(p.frameWidth);
      render();
      ensureBar();
      return publicState();
    },
    'fm:overlay-get': () => publicState(),
    'fm:pick': (m) => pick(String(m.title || '')),
    'fm:pick-cancel': () => { cancelPick(); return true; },
    'fm:auto-map': (m) => autoMap(m),
    'fm:measure': (m) => measure(m),
    'fm:flash': (m) => flash(m),
    'fm:clear-marks': () => { clearLayer(); return true; },
    'fm:freeze': (m) => freeze(!!m.on),
    'fm:preload': () => preload(),
    'fm:capture-begin': () => captureBegin(),
    'fm:scroll-to': (m) => scrollToY(m),
    'fm:capture-end': () => captureEnd(),
    'fm:spec': (m) => spec(m),
    'fm:highlight': (m) => highlight(m),
    'fm:teardown': () => {
      cancelPick();
      captureEnd();
      freeze(false);
      hideScrollbar(false);
      overlayHost?.remove();
      uiHost?.remove();
      overlayHost = uiHost = uiRoot = overlayImg = bar = null;
      designSrc = diffSrc = shownSrc = null;
      state.visible = false;
      refs = [];
      return true;
    },
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Accept messages only from this extension's own pages (side panel / worker).
    if (sender.id !== chrome.runtime.id || sender.tab || !msg || typeof msg.type !== 'string') return undefined;
    const h = handlers[msg.type];
    if (!h) return undefined;
    Promise.resolve()
      .then(() => h(msg))
      .then((data) => sendResponse({ ok: true, data }), (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  });
})();
