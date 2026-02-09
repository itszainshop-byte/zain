import express from 'express';
import multer from 'multer';
import {
  createMeshulamSessionFromCartHandler,
  meshulamCallbackHandler,
  confirmMeshulamSessionHandler,
  getMeshulamSessionOrderHandler
} from '../controllers/meshulamController.js';

const router = express.Router();
const upload = multer();

// Create Meshulam payment session from cart payload
router.post('/session-from-cart', createMeshulamSessionFromCartHandler);

// Grow/Meshulam server-to-server callback
router.post('/callback', upload.none(), meshulamCallbackHandler);

// Confirm a paid session (idempotent)
router.post('/session/confirm', confirmMeshulamSessionHandler);

// Fetch session + order linkage
router.get('/session/:sessionId/order', getMeshulamSessionOrderHandler);

export default router;
