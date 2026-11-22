/*
 * Figma REST API client (read-only).
 * Only ever talks to https://api.figma.com and the render URL Figma returns.
 * The token is sent in the X-Figma-Token header, never in a URL, and
 * requests carry no cookies and no referrer.
 */

const API = 'https://api.figma.com/v1';

export class FigmaError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function parseFigmaUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch (_) {
    throw new FigmaError('Paste a full Figma link (https://www.figma.com/design/…).', 'URL');
  }
  if (u.protocol !== 'https:' || !/(^|\.)figma\.com$/i.test(u.hostname)) {
    throw new FigmaError('Only figma.com links are accepted.', 'URL');
  }
  const parts = u.pathname.split('/').filter(Boolean);
  let fileKey = null;
  if (['design', 'file', 'proto'].includes(parts[0])) {
    fileKey = parts[1];
    const b = parts.indexOf('branch');
    if (b > -1 && parts[b + 1]) fileKey = parts[b + 1];
  }
  if (!fileKey || !/^[A-Za-z0-9]{10,64}$/.test(fileKey)) {
    throw new FigmaError('Could not find the file key in that link.', 'URL');
  }
  const raw = u.searchParams.get('node-id');
  if (!raw) {
    throw new FigmaError('The link has no frame. In Figma select the desktop frame → right-click → Copy/Paste as → Copy link to selection.', 'URL');
  }
  const nodeId = raw.replace(/-/g, ':');
  if (!/^[A-Za-z0-9:;]{3,80}$/.test(nodeId)) throw new FigmaError('The frame id in that link looks invalid.', 'URL');
  return { fileKey, nodeId };
}

async function api(path, token, context) {
  let res;
  try {
    res = await fetch(API + path, {
      headers: { 'X-Figma-Token': token },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch (_) {
    throw new FigmaError('Could not reach api.figma.com. Check your connection.', 'NET');
  }
  if (res.status === 401 || res.status === 403) {
    if (context === 'me') throw new FigmaError('Figma rejected this token. It may be wrong, expired or revoked.', 'AUTH');
    throw new FigmaError('No access to this file. Make sure your Figma account can open it and the token has the "File content: read" scope.', 'FORBIDDEN');
  }
  if (res.status === 404) throw new FigmaError('File or frame not found.', 'NOTFOUND');
  if (res.status === 429) throw new FigmaError('Figma rate limit reached. Wait a minute and try again.', 'RATE');
  if (!res.ok) throw new FigmaError(`Figma API error (${res.status}).`, 'HTTP');
  return res.json();
}

export async function getMe(token) {
  const me = await api('/me', token, 'me');
  return { id: me.id, handle: me.handle, email: me.email, img: me.img_url };
}

export async function getFrame(token, fileKey, nodeId) {
  const data = await api(`/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`, token);
  const node = data.nodes?.[nodeId]?.document;
  if (!node) throw new FigmaError('That frame was not found in the file (it may have been deleted).', 'NOTFOUND');
  if (!node.absoluteBoundingBox) throw new FigmaError('The selected node has no size. Link the desktop frame itself.', 'TYPE');
  return { fileName: data.name, lastModified: data.lastModified, node };
}

export async function renderFrame(token, fileKey, nodeId) {
  const data = await api(
    `/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png&scale=1&use_absolute_bounds=true`,
    token,
  );
  const url = data.images?.[nodeId];
  if (!url) throw new FigmaError('Figma could not render this frame (it may be too large or empty).', 'RENDER');
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new FigmaError('Unexpected render URL from Figma.', 'RENDER');
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new FigmaError(`Downloading the rendered frame failed (${res.status}).`, 'RENDER');
  return res.blob();
}

/* ---------- simplify the node tree to what we need ---------- */

const CONTAINER = new Set(['FRAME', 'GROUP', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET', 'SECTION']);

function rel(bb, fb) {
  return { x: bb.x - fb.x, y: bb.y - fb.y, w: bb.width, h: bb.height };
}

function solidColor(node) {
  const fills = Array.isArray(node.fills) ? node.fills.filter((f) => f.visible !== false) : [];
  if (!fills.length) return null;
  const f = fills[fills.length - 1];
  if (f.type !== 'SOLID' || !f.color) return { gradient: true };
  const a = (f.color.a ?? 1) * (f.opacity ?? 1) * (node.opacity ?? 1);
  return {
    r: Math.round(f.color.r * 255),
    g: Math.round(f.color.g * 255),
    b: Math.round(f.color.b * 255),
    a: Math.round(a * 100) / 100,
  };
}

function qualifyingChildren(node, fb) {
  return (node.children || [])
    .filter((c) => c.visible !== false && CONTAINER.has(c.type) && c.absoluteBoundingBox)
    .filter((c) => c.absoluteBoundingBox.width >= fb.width * 0.6 && c.absoluteBoundingBox.height >= 24);
}

export function simplify(frame) {
  const fb = frame.node.absoluteBoundingBox;

  // Top-level sections; descend through single full-height wrappers.
  let parent = frame.node;
  let kids = qualifyingChildren(parent, fb);
  for (let i = 0; i < 4 && kids.length === 1 && kids[0].absoluteBoundingBox.height > fb.height * 0.85; i++) {
    parent = kids[0];
    kids = qualifyingChildren(parent, fb);
  }
  let sections = kids
    .map((c) => ({ id: c.id, name: c.name || c.type, ...rel(c.absoluteBoundingBox, fb) }))
    .sort((a, b) => a.y - b.y);
  // Drop sections fully contained in an earlier one (backgrounds etc.).
  sections = sections.filter((s, i) => !sections.some((o, j) => j !== i
    && o.y <= s.y && o.y + o.h >= s.y + s.h && o.h > s.h));
  if (!sections.length) sections = [{ id: frame.node.id, name: frame.node.name, x: 0, y: 0, w: fb.width, h: fb.height }];

  // Text nodes.
  const texts = [];
  const walk = (n) => {
    if (n.visible === false) return;
    if (n.type === 'TEXT' && n.absoluteBoundingBox && n.characters && n.characters.trim()) {
      const r = rel(n.absoluteBoundingBox, fb);
      if (r.y + r.h < 0 || r.y > fb.height || r.x > fb.width || r.x + r.w < 0) return;
      const st = n.style || {};
      const overrides = Array.isArray(n.characterStyleOverrides) && n.characterStyleOverrides.some((v) => v !== 0);
      texts.push({
        id: n.id,
        name: n.name,
        chars: n.characters,
        ...r,
        fontFamily: st.fontFamily || '',
        fontWeight: st.fontWeight || 400,
        fontSize: st.fontSize || 0,
        italic: !!st.italic,
        lineHeightPx: st.lineHeightPx || 0,
        lineHeightAuto: st.lineHeightUnit === 'INTRINSIC_%',
        letterSpacing: st.letterSpacing || 0,
        textCase: st.textCase || 'ORIGINAL',
        align: st.textAlignHorizontal || 'LEFT',
        color: solidColor(n),
        mixed: overrides,
      });
      return;
    }
    (n.children || []).forEach(walk);
  };
  walk(frame.node);

  return {
    name: frame.node.name,
    fileName: frame.fileName,
    lastModified: frame.lastModified,
    width: Math.round(fb.width),
    height: Math.round(fb.height),
    sections,
    texts,
  };
}
