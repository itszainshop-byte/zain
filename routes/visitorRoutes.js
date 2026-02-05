import express from 'express';
import { adminAuth } from '../middleware/auth.js';
import { trackVisitor, getVisitorStats } from '../services/visitorTracker.js';

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

export default router;