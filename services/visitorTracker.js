const visitors = new Map();
const events = [];
const MAX_EVENTS = Number.parseInt(process.env.VISITOR_EVENTS_MAX || '200', 10);

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

const toSafeString = (value, max = 256) => (value == null ? '' : String(value).slice(0, max));

export function trackEvent({ id, type, path, meta, ip, ua }) {
  const visitorId = normalizeId(id);
  if (!visitorId) return { ok: false };
  const now = Date.now();
  const event = {
    id: `${visitorId}:${now}:${Math.random().toString(36).slice(2, 8)}`,
    visitorId,
    type: toSafeString(type, 64),
    path: toSafeString(path, 256),
    meta: meta && typeof meta === 'object' ? meta : undefined,
    ip: toSafeString(ip, 64),
    ua: toSafeString(ua, 256),
    ts: now
  };
  events.unshift(event);
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }
  trackVisitor({ id: visitorId, ip, ua, path, referrer: undefined });
  return { ok: true, event };
}

export function getRecentEvents(limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, MAX_EVENTS));
  return events.slice(0, safeLimit);
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