/*
 * Figma Match – service worker.
 * Opens the controls in a separate small window, so the page keeps its full
 * width (e.g. 1920px) and can be compared 1:1 with the Figma frame.
 * Cleans up (detaches the debugger, removes the overlay) when that window closes.
 * The Figma token is never read here.
 */

const PANEL_PATH = 'sidepanel/sidepanel.html';
const PANEL_W = 430;

async function getPanelWindowId() {
  const { fmPanelWin } = await chrome.storage.session.get('fmPanelWin');
  if (!fmPanelWin) return null;
  try {
    await chrome.windows.get(fmPanelWin);
    return fmPanelWin;
  } catch (_) {
    await chrome.storage.session.remove('fmPanelWin');
    return null;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  const existing = await getPanelWindowId();
  if (existing) {
    await chrome.windows.update(existing, { focused: true, state: 'normal' }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'fm:target', tabId: tab.id }).catch(() => {});
    return;
  }
  let bounds = (await chrome.storage.local.get('fmPanelBounds')).fmPanelBounds;
  if (!bounds) {
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    const height = Math.min(win?.height || 900, 920);
    bounds = {
      width: PANEL_W,
      height,
      left: Math.max(0, (win?.left || 0) + (win?.width || 1920) - PANEL_W - 24),
      top: (win?.top || 0) + 90,
    };
  }
  const w = await chrome.windows.create({
    url: `${PANEL_PATH}?tab=${encodeURIComponent(tab.id)}`,
    type: 'popup',
    focused: true,
    ...bounds,
  });
  await chrome.storage.session.set({ fmPanelWin: w.id });
});

chrome.windows.onBoundsChanged?.addListener(async (win) => {
  const id = await getPanelWindowId();
  if (win.id !== id || win.state !== 'normal') return;
  await chrome.storage.local.set({ fmPanelBounds: { left: win.left, top: win.top, width: win.width, height: win.height } });
});

chrome.windows.onRemoved.addListener(async (winId) => {
  const { fmPanelWin } = await chrome.storage.session.get('fmPanelWin');
  if (winId === fmPanelWin) await chrome.storage.session.remove('fmPanelWin');
});

/* ---------- cleanup when the controls window closes ---------- */

async function getTracked() {
  const { fmDebugTabs = [] } = await chrome.storage.session.get('fmDebugTabs');
  return new Set(fmDebugTabs);
}

async function setTracked(set) {
  await chrome.storage.session.set({ fmDebugTabs: [...set] });
}

async function cleanup() {
  const tabs = await getTracked();
  for (const tabId of tabs) {
    try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride'); } catch (_) {}
    try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.setScrollbarsHidden', { hidden: false }); } catch (_) {}
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  }
  await setTracked(new Set());
  const all = await chrome.tabs.query({});
  for (const t of all) {
    chrome.tabs.sendMessage(t.id, { type: 'fm:teardown' }).catch(() => {});
  }
}

chrome.runtime.onConnect.addListener((port) => {
  // Only our own controls page may connect.
  if (port.name !== 'fm-panel' || port.sender?.id !== chrome.runtime.id
    || !String(port.sender?.url || '').startsWith(chrome.runtime.getURL(PANEL_PATH))) {
    port.disconnect();
    return;
  }
  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const tabs = await getTracked();
    if (msg.type === 'debugger-attached' && Number.isInteger(msg.tabId)) tabs.add(msg.tabId);
    if (msg.type === 'debugger-detached' && Number.isInteger(msg.tabId)) tabs.delete(msg.tabId);
    await setTracked(tabs);
    // msg.type === 'ping' just keeps the worker alive while the controls are open.
  });
  port.onDisconnect.addListener(() => { cleanup(); });
});

chrome.debugger.onDetach.addListener(async ({ tabId }) => {
  const tabs = await getTracked();
  if (tabs.delete(tabId)) await setTracked(tabs);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabs = await getTracked();
  if (tabs.delete(tabId)) await setTracked(tabs);
});

// This extension exposes no external messaging surface.
chrome.runtime.onMessageExternal?.addListener((_m, _s, send) => send({ ok: false }));
