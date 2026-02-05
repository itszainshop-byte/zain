const visitors = new Map();

const DEFAULT_WINDOW_SEC = Number.parseInt(process.env.VISITOR_WINDOW_SEC || '300', 10);
const DEFAULT_WINDOW_MS = Number.isFinite(DEFAULT_WINDOW_SEC) ? DEFAULT_WINDOW_SEC * 1000 : 300000;

const normalizeId = (id) => {
  if (!id) return null;
  const str = String(id).trim();
  if (!str) return null;
  return str.slice(0, 128);
};

const cleanup = (windowMs = DEFAULT_WINDOW_MS) => {
  const cutoff = Date.now() - windowMs;
  for (const [id, record] of visitors.entries()) {
    if (!record || record.lastSeen < cutoff) {
      visitors.delete(id);
    }
  }
};

export function trackVisitor({ id, ip, ua, path, referrer }) {
  const visitorId = normalizeId(id);
  if (!visitorId) return { ok: false };
  const now = Date.now();
  visitors.set(visitorId, {
    id: visitorId,
    lastSeen: now,
    ip: (ip || '').toString().slice(0, 64),
    ua: (ua || '').toString().slice(0, 256),
    path: (path || '').toString().slice(0, 256),
    referrer: (referrer || '').toString().slice(0, 256)
  });
  cleanup();
  return { ok: true, lastSeen: now };
}

export function getActiveVisitorCount(windowMs = DEFAULT_WINDOW_MS) {
  cleanup(windowMs);
  const cutoff = Date.now() - windowMs;
  let count = 0;
  for (const record of visitors.values()) {
    if (record && record.lastSeen >= cutoff) count += 1;
  }
  return count;
}

export function getVisitorStats(windowMs = DEFAULT_WINDOW_MS) {
  const count = getActiveVisitorCount(windowMs);
  return { count, windowMs };
}