import asyncHandler from 'express-async-handler';
import PaymentSession from '../models/PaymentSession.js';
import { createPaymentSessionDocument, finalizePaymentSessionToOrder } from '../services/paymentSessionService.js';
import {
  loadMeshulamSettings,
  requestMeshulamPaymentProcess,
  buildMeshulamCreateForm,
  buildMeshulamApprovePayload,
  approveMeshulamTransaction,
  getMeshulamCallbackSessionId,
  findMissingApproveFields
} from '../services/meshulamService.js';

function deriveOrigin(req) {
  const headers = req?.headers || {};
  if (headers.origin) return headers.origin.replace(/\/$/, '');
  if (headers.referer) {
    try {
      const url = new URL(headers.referer);
      return `${url.protocol}//${url.host}`;
    } catch {}
  }
  const host = headers['x-forwarded-host'] || headers.host;
  if (!host) return '';
  const proto = (headers['x-forwarded-proto'] || '').split(',')[0] || (req?.protocol || 'https');
  return `${proto}://${host}`.replace(/\/$/, '');
}

function sanitizeCheckoutItems(items) {
  if (!Array.isArray(items)) return [];
  const isHex24 = (s) => typeof s === 'string' && /^[0-9a-fA-F]{24}$/.test(s);
  return items.map((it) => ({
    product: isHex24(it.product) ? it.product : undefined,
    quantity: Number(it.quantity) || 0,
    price: Number(it.price) || 0,
    size: it.size,
    color: typeof it.color === 'string' ? it.color : (it.color?.name || it.color?.code || undefined),
    variantId: isHex24(it.variantId) ? it.variantId : undefined,
    sku: it.sku,
    variants: Array.isArray(it.variants)
      ? it.variants.map((v) => ({
        attributeId: isHex24(v.attributeId || v.attribute) ? (v.attributeId || v.attribute) : undefined,
        attributeName: v.attributeName || v.name || undefined,
        valueId: isHex24(v.valueId || v.value) ? (v.valueId || v.value) : undefined,
        valueName: v.valueName || v.valueLabel || v.label || undefined
      }))
      : undefined
  }));
}

function parseGiftCardPayload(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const code = String(raw.code || '').trim();
  const amount = Number(raw.amount);
  if (!code || !Number.isFinite(amount) || amount <= 0) return undefined;
  return { code, amount };
}

export const createMeshulamSessionFromCartHandler = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { items, shippingAddress, customerInfo, currency, shippingFee, coupon, pageType, pageCode } = body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'items required' });
  if (!shippingAddress?.street || !shippingAddress?.city || !shippingAddress?.country) return res.status(400).json({ message: 'invalid_shipping' });
  if (!customerInfo?.email || !customerInfo?.mobile) return res.status(400).json({ message: 'invalid_customer' });
  if (!currency) return res.status(400).json({ message: 'currency required' });

  const settings = await loadMeshulamSettings();
  if (!settings.enabled) return res.status(400).json({ message: 'meshulam_disabled' });
  if (!settings.pageCode || !settings.userId) return res.status(400).json({ message: 'meshulam_missing_credentials' });

  const sessionGiftCard = parseGiftCardPayload(body?.giftCard);

  const ps = await createPaymentSessionDocument({
    gateway: 'meshulam',
    status: 'created',
    reference: `MSH-${Date.now()}`,
    items: sanitizeCheckoutItems(items),
    shippingAddress: {
      street: shippingAddress.street,
      city: shippingAddress.city,
      country: shippingAddress.country,
      areaGroup: shippingAddress.areaGroup || ''
    },
    customerInfo: {
      firstName: customerInfo.firstName,
      lastName: customerInfo.lastName,
      email: customerInfo.email,
      mobile: customerInfo.mobile,
      secondaryMobile: customerInfo.secondaryMobile
    },
    coupon: coupon && coupon.code ? { code: coupon.code, discount: Number(coupon.discount) || 0 } : undefined,
    giftCard: sessionGiftCard,
    currency,
    shippingFee: Number(shippingFee) || 0,
    totalWithShipping: Number(body?.totalWithShipping) || undefined,
    cardChargeAmount: Number(body?.cardChargeAmount) || undefined
  });

  const origin = deriveOrigin(req);

  try {
    const data = await requestMeshulamPaymentProcess({
      session: ps,
      settings,
      origin,
      overrides: {
        description: body?.description,
        pageType,
        pageCode
      }
    });

    ps.paymentDetails = {
      meshulam: {
        processId: data?.data?.processId,
        processToken: data?.data?.processToken,
        url: data?.data?.url,
        pageCode: data?.pageCode || pageCode || settings.pageCode
      }
    };
    await ps.save();

    return res.json({
      ok: true,
      sessionId: String(ps._id),
      orderNumber: ps.reference,
      processId: data?.data?.processId,
      processToken: data?.data?.processToken,
      url: data?.data?.url,
      pageCode: data?.pageCode || pageCode || settings.pageCode
    });
  } catch (e) {
    try { console.error('[meshulam][session-from-cart] error', e?.message || e); } catch {}
    return res.status(400).json({
      message: 'meshulam_create_failed',
      detail: e?.message || String(e),
      payload: e?.payload || undefined
    });
  }
});

export const meshulamCallbackHandler = asyncHandler(async (req, res) => {
  const payload = req.body || {};
  const sessionId = getMeshulamCallbackSessionId(payload);
  if (!sessionId) return res.status(400).json({ message: 'session_not_found' });

  const session = await PaymentSession.findById(sessionId);
  if (!session) return res.status(404).json({ message: 'session_not_found' });

  session.status = 'approved';
  session.paymentDetails = {
    ...(session.paymentDetails || {}),
    meshulam: {
      ...(session.paymentDetails?.meshulam || {}),
      callback: payload
    }
  };
  await session.save();

  try {
    const settings = await loadMeshulamSettings();
    const approvePayload = buildMeshulamApprovePayload({ settings, session, callback: payload });
    const missing = findMissingApproveFields(approvePayload);
    if (missing.length) {
      session.paymentDetails.meshulam.approveMissing = missing;
      await session.save();
      return res.json({ ok: true, missing });
    }
    try {
      const approveRes = await approveMeshulamTransaction({ settings, payload: approvePayload });
      session.paymentDetails.meshulam.approve = approveRes;
      await session.save();
    } catch (e) {
      try { console.warn('[meshulam][callback][approve] failed', e?.message || e); } catch {}
    }
  } catch {}

  return res.json({ ok: true });
});

export const confirmMeshulamSessionHandler = asyncHandler(async (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  if (!sessionId) return res.status(400).json({ message: 'sessionId required' });
  const ps = await PaymentSession.findById(sessionId);
  if (!ps) return res.status(404).json({ message: 'session_not_found' });

  const { order } = await finalizePaymentSessionToOrder(ps, {
    paymentMethod: 'card',
    paymentStatus: 'completed',
    paymentDetails: ps.paymentDetails || {}
  });

  return res.json({ ok: true, order: { _id: order._id, orderNumber: order.orderNumber, shippingFee: order.shippingFee || order.deliveryFee || 0 } });
});

export const getMeshulamSessionOrderHandler = asyncHandler(async (req, res) => {
  const sessionId = String(req.params?.sessionId || '').trim();
  if (!sessionId) return res.status(400).json({ message: 'sessionId required' });
  const session = await PaymentSession.findById(sessionId);
  if (!session) return res.status(404).json({ message: 'session_not_found' });
  if (!session.orderId) return res.json({ ok: true, order: null });
  return res.json({ ok: true, order: { _id: session.orderId, orderNumber: session.orderNumber, paymentStatus: session.status } });
});

export default {
  createMeshulamSessionFromCartHandler,
  meshulamCallbackHandler,
  confirmMeshulamSessionHandler,
  getMeshulamSessionOrderHandler
};
