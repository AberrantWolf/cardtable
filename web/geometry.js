// geometry.js — group-outline geometry: convex hull → Chaikin smoothing → chalk strokes.
// Pure functions, no DOM. Reused as-is when this moves into the extension.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Andrew's monotone-chain convex hull. Convex → always smooth turns, never a tight
// concave pinch between cards, which is exactly the "favor smooth over tight fit" look.
export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts.slice();
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// Chaikin corner-cutting on a closed polygon → rounded blob.
export function chaikin(points, iterations = 3) {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % n];
      out.push({ x: p0.x * 0.75 + p1.x * 0.25, y: p0.y * 0.75 + p1.y * 0.25 });
      out.push({ x: p0.x * 0.25 + p1.x * 0.75, y: p0.y * 0.25 + p1.y * 0.75 });
    }
    pts = out;
  }
  return pts;
}

// Rounded, generously-padded closed outline around a set of rects {x,y,w,h}.
export function groupOutline(rects, pad = 50) {
  const corners = [];
  for (const r of rects) {
    corners.push({ x: r.x - pad, y: r.y - pad });
    corners.push({ x: r.x + r.w + pad, y: r.y - pad });
    corners.push({ x: r.x + r.w + pad, y: r.y + r.h + pad });
    corners.push({ x: r.x - pad, y: r.y + r.h + pad });
  }
  return chaikin(convexHull(corners), 3);
}

export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const hit = (yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

export function bbox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// N jittered closed SVG path strings for a hand-drawn / chalk look. Deterministic
// per seed so the outline doesn't shimmer when re-rendered (only changes when cards move).
export function chalkPaths(points, seed, passes = 2, jitter = 2.4) {
  const out = [];
  for (let s = 0; s < passes; s++) {
    const rnd = mulberry32(seed + s * 9173);
    let d = "";
    points.forEach((p, i) => {
      const x = p.x + (rnd() - 0.5) * jitter * 2;
      const y = p.y + (rnd() - 0.5) * jitter * 2;
      d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
    });
    out.push(d + "Z");
  }
  return out;
}
