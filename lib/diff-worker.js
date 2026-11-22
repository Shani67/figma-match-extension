/*
 * Pixel diff worker (runs off the panel's main thread).
 * Colour difference uses the YIQ metric (same idea as pixelmatch) with a
 * 1px shift tolerance so anti-aliasing and sub-pixel text rendering do not
 * flood the result.
 */

function blend(c, a) {
  return 255 + (c - 255) * a;
}

function delta(a, i, b, j) {
  const a1 = a[i + 3] / 255;
  const a2 = b[j + 3] / 255;
  const r1 = blend(a[i], a1); const g1 = blend(a[i + 1], a1); const b1 = blend(a[i + 2], a1);
  const r2 = blend(b[j], a2); const g2 = blend(b[j + 1], a2); const b2 = blend(b[j + 2], a2);
  const dr = r1 - r2; const dg = g1 - g2; const db = b1 - b2;
  const y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
  const iq = dr * 0.59597799 - dg * 0.2741761 - db * 0.32180189;
  const q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
  return 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
}

self.onmessage = (e) => {
  const { W, DH, PH, regions, threshold } = e.data;
  const d = new Uint8ClampedArray(e.data.design);
  const p = new Uint8ClampedArray(e.data.page);
  const mask = new Uint8ClampedArray(W * PH * 4);
  const maxDelta = 35215 * threshold * threshold;
  const stats = [];

  for (const r of regions) {
    const h = Math.min(r.fh, r.ph, DH - r.fy, PH - r.py);
    if (h <= 0 || r.fy < 0 || r.py < 0) {
      stats.push({ id: r.id, compared: 0, diff: 0 });
      continue;
    }
    let diff = 0;
    let compared = 0;
    for (let y = 0; y < h; y++) {
      const dy = r.fy + y;
      const py = r.py + y;
      for (let x = 0; x < W; x++) {
        const di = (dy * W + x) * 4;
        const pi = (py * W + x) * 4;
        compared++;
        if (delta(d, di, p, pi) <= maxDelta) continue;
        let ok = false;
        for (let oy = -1; oy <= 1 && !ok; oy++) {
          const yy = dy + oy;
          if (yy < 0 || yy >= DH) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const xx = x + ox;
            if ((ox === 0 && oy === 0) || xx < 0 || xx >= W) continue;
            if (delta(d, (yy * W + xx) * 4, p, pi) <= maxDelta) { ok = true; break; }
          }
        }
        if (ok) continue;
        diff++;
        mask[pi] = 255;
        mask[pi + 1] = 0;
        mask[pi + 2] = 80;
        mask[pi + 3] = 210;
      }
      if ((y & 255) === 0) self.postMessage({ progress: { id: r.id, y, h } });
    }
    stats.push({ id: r.id, compared, diff });
  }
  self.postMessage({ done: true, mask: mask.buffer, stats }, [mask.buffer]);
};
