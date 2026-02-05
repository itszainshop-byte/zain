import Order from '../models/Order.js';
import Product from '../models/Product.js';
import PaymentSession from '../models/PaymentSession.js';
import { getPayPalClient, paypalSdk } from '../services/paypalClient.js';
import { createPaymentSessionDocument, finalizePaymentSessionToOrder } from '../services/paymentSessionService.js';

const isHex24 = (s) => typeof s === 'string' && /^[0-9a-fA-F]{24}$/.test(s);

function sanitizeCheckoutItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it) => ({
    product: isHex24(it.product) ? it.product : undefined,
    quantity: Number(it.quantity) || 0,
    price: Number(it.price) || undefined,
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

async function calculateCatalogSubtotal(items) {
  let subtotal = 0;
  for (const item of items) {
    const qty = Number(item.quantity) || 0;
    if (qty <= 0) {
      throw new Error('invalid_quantity');
    }
    if (!item.product) {
      throw new Error('missing_product');
    }
    const product = await Product.findById(item.product);
    if (!product) {
      throw new Error(`Product not found: ${item.product}`);
    }
    const price = Number(product.price);
    if (!Number.isFinite(price)) {
      throw new Error(`Invalid price for product ${product._id}`);
    }
    subtotal += price * qty;
  }
  return subtotal;
}

// Create a PayPal order based on a local Order document
export const createPayPalOrder = async (req, res) => {
  try {
    try {
      console.log('[PayPal][create-order] incoming', {
        time: new Date().toISOString(),
        ip: req.ip,
        ua: req.headers['user-agent'] || '',
        hasAuth: !!req.headers.authorization,
        orderId: req.body?.orderId || null
      });
    } catch {}
    const body = req.body || {};
    const items = sanitizeCheckoutItems(body.items);
    const shippingAddress = body.shippingAddress || {};
    const customerInfo = body.customerInfo || {};
    const currency = String(body.currency || process.env.STORE_CURRENCY || 'USD');

    if (!items.length) return res.status(400).json({ message: 'items are required' });
    if (!customerInfo?.email || !customerInfo?.mobile) return res.status(400).json({ message: 'Customer email and mobile number are required' });
    if (!shippingAddress?.street || !shippingAddress?.city || !shippingAddress?.country) {
      return res.status(400).json({ message: 'Complete shipping address is required' });
    }

    const couponInfo = body?.coupon?.code
      ? { code: String(body.coupon.code).trim(), discount: Math.max(0, Number(body.coupon.discount) || 0) }
      : undefined;
    const giftCardInfo = parseGiftCardPayload(body?.giftCard);

    const subtotal = await calculateCatalogSubtotal(items);
    const discount = couponInfo?.discount ? Math.max(0, Number(couponInfo.discount) || 0) : 0;
    const discountedSubtotal = Math.max(0, subtotal - discount);
    const rawShippingFee = Number(body.shippingFee);
    const shippingFee = Number.isFinite(rawShippingFee) && rawShippingFee >= 0 ? rawShippingFee : 0;
    const totalWithShipping = discountedSubtotal + shippingFee;

    if (!(totalWithShipping > 0)) {
      return res.status(400).json({ message: 'total must be positive' });
    }

    const orderNumber = body?.orderNumber?.trim?.() ? String(body.orderNumber).trim() : `ORD${Date.now()}`;
    const session = await createPaymentSessionDocument({
      gateway: 'paypal',
      status: 'created',
      reference: `PP-${Date.now()}`,
      orderNumber,
      items,
      shippingAddress: {
        street: shippingAddress.street,
        city: shippingAddress.city,
        country: shippingAddress.country,
        areaGroup: typeof shippingAddress.areaGroup === 'string' ? shippingAddress.areaGroup.trim() : ''
      },
      customerInfo: {
        firstName: customerInfo.firstName,
        lastName: customerInfo.lastName,
        email: customerInfo.email,
        mobile: customerInfo.mobile,
        secondaryMobile: customerInfo.secondaryMobile
      },
      coupon: couponInfo,
      giftCard: giftCardInfo,
      currency,
      shippingFee,
      totalWithShipping
    });

    const client = await getPayPalClient();

    const request = new paypalSdk.orders.OrdersCreateRequest();
    request.prefer('return=representation');

    const amount = {
      currency_code: currency || 'USD',
      value: totalWithShipping.toFixed(2)
    };

    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: session._id.toString(),
          description: `Order ${orderNumber}`,
          amount
        }
      ]
    });

    const response = await client.execute(request);
    try {
      console.log('[PayPal][create-order] success', {
        sessionId: session._id.toString(),
        paypalOrderId: response?.result?.id || null,
        status: response?.result?.status || null
      });
    } catch {}

    session.reference = response.result.id;
    await session.save();

    res.json({ id: response.result.id, status: response.result.status, links: response.result.links, sessionId: session._id });
  } catch (err) {
    const debugId = err?.response?.headers?.['paypal-debug-id'] || err?.response?.headers?.['PayPal-Debug-Id'];
    console.error('[PayPal][create-order] error', {
      message: err?.message,
      statusCode: err?.statusCode || err?.response?.status,
      name: err?.name,
      debugId
    });
    res.status(500).json({ message: 'Failed to create PayPal order', debugId });
  }
};

// Capture a PayPal order and mark local order paid
export const capturePayPalOrder = async (req, res) => {
  try {
    try {
      console.log('[PayPal][capture-order] incoming', {
        time: new Date().toISOString(),
        ip: req.ip,
        ua: req.headers['user-agent'] || '',
        hasAuth: !!req.headers.authorization,
        paypalOrderId: req.body?.paypalOrderId || null
      });
    } catch {}
    const { paypalOrderId } = req.body;
    if (!paypalOrderId) return res.status(400).json({ message: 'paypalOrderId is required' });

  const client = await getPayPalClient();
    const request = new paypalSdk.orders.OrdersCaptureRequest(paypalOrderId);
    request.requestBody({});

    const capture = await client.execute(request);

    const referenceId = capture?.result?.purchase_units?.[0]?.reference_id;
    const status = capture?.result?.status;

    if (!referenceId) {
      return res.status(400).json({ message: 'Missing reference id from PayPal capture' });
    }

    let session = null;
    if (isHex24(referenceId)) {
      session = await PaymentSession.findById(referenceId);
    }
    if (!session) {
      session = await PaymentSession.findOne({ reference: paypalOrderId });
    }
    if (!session) return res.status(404).json({ message: 'Payment session not found' });

    if (status === 'COMPLETED') {
      const { order } = await finalizePaymentSessionToOrder(session, {
        paymentMethod: 'paypal',
        paymentStatus: 'completed',
        paymentDetails: capture.result
      });
      try {
        console.log('[PayPal][capture-order] completed', {
          paypalOrderId,
          sessionId: session?._id?.toString(),
          orderId: order?._id?.toString(),
          status
        });
      } catch {}
      return res.json({ message: 'Payment captured', orderId: order._id, orderNumber: order.orderNumber, status });
    }

    // Mark as failed if not completed
    session.status = 'failed';
    session.paymentDetails = capture.result;
    await session.save();
    try {
      console.log('[PayPal][capture-order] not-completed', {
        paypalOrderId,
        sessionId: session?._id?.toString(),
        status
      });
    } catch {}
    return res.status(400).json({ message: 'Payment not completed', status });
  } catch (err) {
    const debugId = err?.response?.headers?.['paypal-debug-id'] || err?.response?.headers?.['PayPal-Debug-Id'];
    console.error('[PayPal][capture-order] error', {
      message: err?.message,
      statusCode: err?.statusCode || err?.response?.status,
      name: err?.name,
      debugId
    });
    res.status(500).json({ message: 'Failed to capture PayPal order', debugId });
  }
};
