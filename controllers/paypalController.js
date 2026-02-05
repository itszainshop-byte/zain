import Order from '../models/Order.js';
import { getPayPalClient, paypalSdk } from '../services/paypalClient.js';

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
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ message: 'orderId is required' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // Only allow creating PayPal order for pending, unpaid orders
    if (order.paymentStatus === 'completed') {
      return res.status(400).json({ message: 'Order is already paid' });
    }

  const client = await getPayPalClient();

    const request = new paypalSdk.orders.OrdersCreateRequest();
    request.prefer('return=representation');

    const amount = {
      currency_code: order.currency || 'USD',
      value: (order.totalAmount).toFixed(2)
    };

    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: order._id.toString(),
          description: `Order ${order.orderNumber}`,
          amount
        }
      ]
    });

    const response = await client.execute(request);
    try {
      console.log('[PayPal][create-order] success', {
        orderId,
        paypalOrderId: response?.result?.id || null,
        status: response?.result?.status || null
      });
    } catch {}

    // Save PayPal order id reference
    order.paymentMethod = 'paypal';
    order.paymentReference = response.result.id;
    await order.save();

    res.json({ id: response.result.id, status: response.result.status, links: response.result.links });
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

    const order = await Order.findById(referenceId);
    if (!order) return res.status(404).json({ message: 'Local order not found' });

    if (status === 'COMPLETED') {
      order.paymentStatus = 'completed';
      order.status = order.status === 'pending' ? 'processing' : order.status;
      order.paymentDetails = capture.result;
      await order.save();
      try {
        console.log('[PayPal][capture-order] completed', {
          paypalOrderId,
          orderId: order?._id?.toString(),
          status
        });
      } catch {}
      return res.json({ message: 'Payment captured', orderId: order._id, status });
    }

    // Mark as failed if not completed
    order.paymentStatus = 'failed';
    order.paymentDetails = capture.result;
    await order.save();
    try {
      console.log('[PayPal][capture-order] not-completed', {
        paypalOrderId,
        orderId: order?._id?.toString(),
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
