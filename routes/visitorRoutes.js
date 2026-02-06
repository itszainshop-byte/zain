import express from 'express';
import { adminAuth } from '../middleware/auth.js';
import { trackVisitor, getVisitorStats, trackEvent, getRecentEvents, getEventsCount } from '../services/visitorTracker.js';

const router = express.Router();

router.post('/ping', (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').toString();
    const { visitorId, path, referrer } = req.body || {};
    const result = trackVisitor({ id: visitorId, ip, ua, path, referrer });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, message: 'visitor_ping_failed' });
  }
});

router.post('/event', (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').toString();
    const { visitorId, type, path, meta } = req.body || {};
    const allowed = new Set([
      'page_view',
      'click',
      'cart_add',
      'cart_remove',
      'cart_update_qty',
      'cart_clear',
      'search',
      'checkout_start',
      'checkout_step',
      'checkout_shipping_submit',
      'checkout_complete',
      'wishlist_add_to_cart',
      'wishlist_remove'
    ]);
    const safeType = allowed.has(String(type)) ? String(type) : 'unknown';
    const result = trackEvent({ id: visitorId, type: safeType, path, meta, ip, ua });
    if (result?.event) {
      try {
        const broadcaster = req.app?.get('broadcastToClients');
        if (typeof broadcaster === 'function') {
          broadcaster({ type: 'visitor_event', data: result.event });
        }
      } catch {}
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: 'visitor_event_failed' });
  }
});

router.get('/active', adminAuth, (req, res) => {
  try {
    const windowSec = Number.parseInt(String(req.query?.windowSec || ''), 10);
    const windowMs = Number.isFinite(windowSec) ? windowSec * 1000 : undefined;
    const stats = getVisitorStats(windowMs);
    res.json({ count: stats.count, windowMs: stats.windowMs, windowSec: Math.round(stats.windowMs / 1000) });
  } catch (e) {
    res.status(500).json({ message: 'visitor_stats_failed' });
  }
});

router.get('/events', adminAuth, (req, res) => {
  try {
    const limit = Number.parseInt(String(req.query?.limit || '50'), 10);
    const data = getRecentEvents(limit).map((event) => ({
      id: event.id,
      visitorId: event.visitorId,
      visitorShortId: String(event.visitorId || '').slice(0, 8),
      type: event.type,
      path: event.path,
      meta: event.meta,
      ts: event.ts
    }));
    res.json({ data, total: getEventsCount() });
  } catch (e) {
    res.status(500).json({ message: 'visitor_events_failed' });
  }
});

export default router;