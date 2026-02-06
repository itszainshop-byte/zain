import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Product from '../models/Product.js';

const visitors = new Map();
const events = [];
const MAX_EVENTS_RAW = Number.parseInt(process.env.VISITOR_EVENTS_MAX || '0', 10);
const MAX_EVENTS = Number.isFinite(MAX_EVENTS_RAW) ? MAX_EVENTS_RAW : 0;
const HAS_EVENT_CAP = MAX_EVENTS > 0;
const SAVE_DEBOUNCE_MS = Number.parseInt(process.env.VISITOR_SAVE_DEBOUNCE_MS || '1000', 10);
const productViewQueue = new Map();
const lastPageViewByVisitor = new Map();
const PAGE_VIEW_DEDUPE_MS = Number.parseInt(process.env.VISITOR_PAGE_VIEW_DEDUPE_MS || '60000', 10);
let productFlushTimer = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../data');
const dataFile = path.join(dataDir, 'visitor-state.json');
let saveTimer = null;

const safeJsonParse = (raw) => {
  try { return JSON.parse(raw); } catch { return null; }
};

const loadState = () => {
  try {
    if (!fs.existsSync(dataFile)) return;
    const raw = fs.readFileSync(dataFile, 'utf8');
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    const list = Array.isArray(parsed.visitors) ? parsed.visitors : [];
    list.forEach((v) => {
      if (v && v.id) visitors.set(String(v.id), v);
    });
    const evts = Array.isArray(parsed.events) ? parsed.events : [];
    events.length = 0;
    if (HAS_EVENT_CAP) {
      evts.slice(0, MAX_EVENTS).forEach((e) => events.push(e));
    } else {
      evts.forEach((e) => events.push(e));
    }
  } catch {}
};

const saveState = () => {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const payload = {
      visitors: Array.from(visitors.values()),
      events: HAS_EVENT_CAP ? events.slice(0, MAX_EVENTS) : events
    };
    fs.writeFileSync(dataFile, JSON.stringify(payload));
  } catch {}
};

const scheduleSave = () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, Math.max(200, SAVE_DEBOUNCE_MS));
};

loadState();

const DEFAULT_WINDOW_SEC = Number.parseInt(process.env.VISITOR_WINDOW_SEC || '300', 10);
const DEFAULT_WINDOW_MS = Number.isFinite(DEFAULT_WINDOW_SEC) ? DEFAULT_WINDOW_SEC * 1000 : 300000;
const DEFAULT_STREAM_URL = (process.env.VISITOR_STREAM_URL || 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8').toString();

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

export function trackVisitor({ id, ip, ua, path, referrer, streamUrl }) {
  const visitorId = normalizeId(id);
  if (!visitorId) return { ok: false };
  const now = Date.now();
  const prev = visitors.get(visitorId) || {};
  const nextStreamUrl = streamUrl ? toSafeString(streamUrl, 512) : prev.streamUrl;
  visitors.set(visitorId, {
    id: visitorId,
    lastSeen: now,
    ip: (ip || '').toString().slice(0, 64),
    ua: (ua || '').toString().slice(0, 256),
    path: (path || '').toString().slice(0, 256),
    referrer: (referrer || '').toString().slice(0, 256),
    streamUrl: nextStreamUrl || ''
  });
  cleanup();
  scheduleSave();
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
  if (HAS_EVENT_CAP && events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }
  trackVisitor({ id: visitorId, ip, ua, path, referrer: undefined });
  if (event.type === 'page_view') {
    const match = /^\/product\/([^/?#]+)/.exec(String(event.path || ''));
    if (match) {
      const productId = match[1];
      const entry = productViewQueue.get(productId) || { count: 0, lastSeen: 0 };
      entry.count += 1;
      if (now > entry.lastSeen) entry.lastSeen = now;
      productViewQueue.set(productId, entry);
      scheduleProductFlush();
    }
  }
  scheduleSave();
  return { ok: true, event };
}

const scheduleProductFlush = () => {
  if (productFlushTimer) return;
  productFlushTimer = setTimeout(async () => {
    productFlushTimer = null;
    if (!productViewQueue.size) return;
    const ops = [];
    for (const [productId, entry] of productViewQueue.entries()) {
      if (!productId || !entry?.count) continue;
      ops.push({
        updateOne: {
          filter: { _id: productId },
          update: {
            $inc: { visitorViewCount: entry.count },
            $set: { visitorLastViewAt: new Date(entry.lastSeen || Date.now()) }
          }
        }
      });
    }
    productViewQueue.clear();
    if (!ops.length) return;
    try {
      await Product.bulkWrite(ops, { ordered: false });
    } catch {}
  }, Math.max(500, SAVE_DEBOUNCE_MS));
};

export function trackPageView({ id, path, meta, ip, ua }) {
  const visitorId = normalizeId(id);
  if (!visitorId) return { ok: false };
  const now = Date.now();
  const currentPath = (path || '').toString();
  const prev = lastPageViewByVisitor.get(visitorId);
  if (prev && prev.path === currentPath && now - prev.ts < PAGE_VIEW_DEDUPE_MS) {
    return { ok: false, suppressed: true };
  }
  lastPageViewByVisitor.set(visitorId, { path: currentPath, ts: now });
  return trackEvent({ id: visitorId, type: 'page_view', path: currentPath, meta, ip, ua });
}

export function getRecentEvents(limit = 50) {
  const parsed = Number(limit) || 50;
  const maxAllowed = HAS_EVENT_CAP ? MAX_EVENTS : events.length || parsed;
  const safeLimit = Math.max(1, Math.min(parsed, maxAllowed));
  return events.slice(0, safeLimit);
}

export function getEventsCount() {
  return events.length;
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

export function getActiveVisitorList(windowMs = DEFAULT_WINDOW_MS) {
  cleanup(windowMs);
  const cutoff = Date.now() - windowMs;
  const list = [];
  for (const record of visitors.values()) {
    if (!record || record.lastSeen < cutoff) continue;
    list.push({
      id: record.id,
      shortId: String(record.id || '').slice(0, 8),
      lastSeen: record.lastSeen,
      path: record.path || '',
      referrer: record.referrer || '',
      ua: record.ua || '',
      streamUrl: record.streamUrl || DEFAULT_STREAM_URL
    });
  }
  list.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return list;
}

export function getActiveVisitorsByProduct(windowMs = DEFAULT_WINDOW_MS) {
  cleanup(windowMs);
  const cutoff = Date.now() - windowMs;
  const map = new Map();
  for (const record of visitors.values()) {
    if (!record || record.lastSeen < cutoff) continue;
    const path = (record.path || '').toString();
    const match = /^\/product\/([^/?#]+)/.exec(path);
    if (!match) continue;
    const productId = match[1];
    if (!productId) continue;
    const entry = map.get(productId) || { count: 0, lastSeen: 0 };
    entry.count += 1;
    if (record.lastSeen > entry.lastSeen) entry.lastSeen = record.lastSeen;
    map.set(productId, entry);
  }
  return Object.fromEntries(map.entries());
}