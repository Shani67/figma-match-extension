/*
 * Storage helpers.
 *
 * Security model for the Figma token:
 *  - Encrypted with AES-GCM 256 before it is stored.
 *  - The key is a NON-EXTRACTABLE CryptoKey kept in this extension's own
 *    IndexedDB. Web pages and content scripts cannot reach that database,
 *    and the raw key bytes can never be exported, even by our own code.
 *  - "Keep me signed in" off  -> ciphertext lives in chrome.storage.session
 *    (memory only, cleared when the browser closes, trusted contexts only).
 *    "Keep me signed in" on   -> ciphertext lives in chrome.storage.local.
 *  - Sign out deletes the ciphertext AND the key, plus all cached designs.
 */

const DB_NAME = 'figma-match';
const DB_VERSION = 1;
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('designs')) d.createObjectStore('designs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const idb = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  set: (store, key, val) => tx(store, 'readwrite', (s) => s.put(val, key)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
};

/* ---------- token encryption ---------- */

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function getKey(create) {
  let key = await idb.get('kv', 'token-key');
  if (!key && create) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idb.set('kv', 'token-key', key);
  }
  return key || null;
}

export async function saveToken(token, remember) {
  const key = await getKey(true);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token));
  const rec = { iv: b64(iv), ct: b64(ct), v: 1 };
  await chrome.storage.local.remove('fmAuth');
  await chrome.storage.session.remove('fmAuth');
  await (remember ? chrome.storage.local : chrome.storage.session).set({ fmAuth: rec });
}

export async function loadToken() {
  const rec = (await chrome.storage.session.get('fmAuth')).fmAuth
    || (await chrome.storage.local.get('fmAuth')).fmAuth;
  if (!rec) return null;
  const key = await getKey(false);
  if (!key) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, key, unb64(rec.ct));
    return new TextDecoder().decode(pt);
  } catch (_) {
    return null;
  }
}

export async function clearAll() {
  await chrome.storage.local.remove(['fmAuth', 'fmUser']);
  await chrome.storage.session.remove(['fmAuth', 'fmUser']);
  await idb.del('kv', 'token-key');
  await idb.clear('designs');
}

/* ---------- small helpers for settings / per-page config ---------- */

export async function getLocal(key, fallback) {
  const v = (await chrome.storage.local.get(key))[key];
  return v === undefined ? fallback : v;
}

export async function setLocal(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export function pageKeyFor(url) {
  try {
    const u = new URL(url);
    return u.origin + (u.pathname.replace(/\/+$/, '') || '/');
  } catch (_) {
    return null;
  }
}
