import express from 'express';
import { adminAuth } from '../middleware/auth.js';
import Product from '../models/Product.js';
import { trackVisitor, getVisitorStats, trackEvent, getRecentEvents, getEventsCount, getActiveVisitorsByProduct, trackPageView, getActiveVisitorList } from '../services/visitorTracker.js';

const router = express.Router();

router.post('/ping', (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').toString();
    const { visitorId, path, referrer, emitEvent, streamUrl } = req.body || {};
    const result = trackVisitor({ id: visitorId, ip, ua, path, referrer, streamUrl });
    if (emitEvent) {
      try { trackPageView({ id: visitorId, path, meta: { source: 'ping' }, ip, ua }); } catch {}
    }
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

router.get('/active/list', adminAuth, async (req, res) => {
  try {
    const windowSec = Number.parseInt(String(req.query?.windowSec || ''), 10);
    const windowMs = Number.isFinite(windowSec) ? windowSec * 1000 : undefined;
    const data = getActiveVisitorList(windowMs);
    const productIds = new Set();
    data.forEach((item) => {
      const match = /^\/product\/([^/?#]+)/.exec(String(item?.path || ''));
      if (match && match[1]) productIds.add(match[1]);
    });

    let productNameById = new Map();
    if (productIds.size > 0) {
      try {
        const products = await Product.find({ _id: { $in: Array.from(productIds) } })
          .select('_id name')
          .lean();
        productNameById = new Map(products.map((p) => [String(p._id), String(p.name || '')]));
      } catch {}
    }

    const enriched = data.map((item) => {
      const match = /^\/product\/([^/?#]+)/.exec(String(item?.path || ''));
      if (!match || !match[1]) return item;
      const productName = productNameById.get(match[1]);
      if (!productName) return item;
      return { ...item, productName };
    });

    res.json({ data: enriched, windowMs: windowMs || null, windowSec: windowMs ? Math.round(windowMs / 1000) : null });
  } catch (e) {
    res.status(500).json({ message: 'visitor_active_list_failed' });
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

router.get('/by-product', adminAuth, (req, res) => {
  try {
    const windowSec = Number.parseInt(String(req.query?.windowSec || ''), 10);
    const windowMs = Number.isFinite(windowSec) ? windowSec * 1000 : undefined;
    const data = getActiveVisitorsByProduct(windowMs);
    res.json({ data, windowMs: windowMs || null, windowSec: windowMs ? Math.round(windowMs / 1000) : null });
  } catch (e) {
    res.status(500).json({ message: 'visitor_by_product_failed' });
  }
});

export default router;