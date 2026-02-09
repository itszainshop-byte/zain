import axios from 'axios';
import FormData from 'form-data';
import Settings from '../models/Settings.js';

const DEFAULT_CREATE_URL = 'https://sandbox.meshulam.co.il/api/light/server/1.0/createPaymentProcess';
const DEFAULT_APPROVE_URL = 'https://sandbox.meshulam.co.il/api/light/server/1.0/approveTransaction';

export async function loadMeshulamSettings() {
  const settings = await Settings.findOne().lean().exec();
  const cfg = settings?.payments?.meshulam || {};
  return {
    enabled: !!cfg.enabled,
    apiUrl: cfg.apiUrl || DEFAULT_CREATE_URL,
    approveUrl: cfg.approveUrl || DEFAULT_APPROVE_URL,
    pageCode: cfg.pageCode || '',
    userId: cfg.userId || '',
    apiKey: cfg.apiKey || '',
    successUrl: cfg.successUrl || '',
    cancelUrl: cfg.cancelUrl || '',
    notifyUrl: cfg.notifyUrl || ''
  };
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function normalizeMeshulamPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('972') && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.length === 9 && digits.startsWith('5')) return `0${digits}`;
  return digits;
}

function normalizeMeshulamFullName(fullNameRaw) {
  const safe = String(fullNameRaw || '').trim();
  const parts = safe.split(/\s+/).filter(Boolean);
  const validParts = parts.filter((p) => p.length >= 2);
  if (validParts.length >= 2) return `${validParts[0]} ${validParts[1]}`;
  return 'Customer Name';
}

function buildTotalAmount(session) {
  const itemsTotal = (session.items || []).reduce((sum, item) => {
    const qty = normalizeNumber(item.quantity, 0);
    const price = normalizeNumber(item.price, 0);
    return sum + price * qty;
  }, 0);
  const couponDiscount = normalizeNumber(session?.coupon?.discount, 0);
  const shippingFee = normalizeNumber(session?.shippingFee, 0);
  const giftAmount = normalizeNumber(session?.giftCard?.amount, 0);
  const totalWithShipping = normalizeNumber(session?.totalWithShipping, itemsTotal - couponDiscount + shippingFee);
  const cardChargeAmount = normalizeNumber(session?.cardChargeAmount, Math.max(0, totalWithShipping - giftAmount));
  return { itemsTotal, couponDiscount, shippingFee, totalWithShipping, cardChargeAmount };
}

export function buildMeshulamCreateForm({ session, settings, origin, overrides = {} }) {
  const fullNameRaw = `${session?.customerInfo?.firstName || ''} ${session?.customerInfo?.lastName || ''}`.trim();
  const fullName = normalizeMeshulamFullName(fullNameRaw || session?.customerInfo?.email || '');
  const phone = normalizeMeshulamPhone(session?.customerInfo?.mobile || '');
  const email = String(session?.customerInfo?.email || '').trim();

  const { cardChargeAmount } = buildTotalAmount(session);
  const sum = Number.isFinite(cardChargeAmount) ? cardChargeAmount : 0;

  const successUrl = overrides.successUrl || settings.successUrl || (origin ? `${origin}/payment/return?gateway=meshulam&session=${session._id}` : '');
  const cancelUrl = overrides.cancelUrl || settings.cancelUrl || (origin ? `${origin}/cart` : '');
  const notifyUrl = overrides.notifyUrl || settings.notifyUrl || (origin ? `${origin}/api/payments/meshulam/callback` : '');

  const description = overrides.description || `Order ${session.reference || session._id}`;

  const form = new FormData();
  form.append('pageCode', overrides.pageCode || settings.pageCode || '');
  form.append('userId', overrides.userId || settings.userId || '');
  if (settings.apiKey) form.append('apiKey', settings.apiKey);
  form.append('sum', String(sum));
  form.append('successUrl', successUrl || '');
  form.append('cancelUrl', cancelUrl || '');
  form.append('description', description);
  form.append('pageField[fullName]', fullName);
  form.append('pageField[phone]', phone);
  if (email) form.append('pageField[email]', email);
  form.append('cField1', String(session._id));
  if (notifyUrl) form.append('notifyUrl', notifyUrl);

  return { form, sum, successUrl, cancelUrl, notifyUrl };
}

export async function requestMeshulamPaymentProcess({ session, settings, origin, overrides = {} }) {
  const { form } = buildMeshulamCreateForm({ session, settings, origin, overrides });
  const url = settings.apiUrl || DEFAULT_CREATE_URL;
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const extraHeaders = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': ua
  };
  if (origin) {
    extraHeaders.Origin = origin;
    extraHeaders.Referer = origin;
  }
  const resp = await axios.post(url, form, {
    headers: {
      ...form.getHeaders(),
      ...extraHeaders
    },
    timeout: 20000,
    validateStatus: () => true
  });
  const data = resp?.data || {};
  const contentType = String(resp?.headers?.['content-type'] || '');
  const rawText = typeof data === 'string' ? data : '';
  const looksHtml = contentType.includes('text/html') || rawText.includes('<html') || rawText.includes('_Incapsula_Resource');
  if (looksHtml) {
    const snippet = rawText.replace(/\s+/g, ' ').slice(0, 300);
    try {
      console.warn('[meshulam][waf] blocked response', {
        status: resp.status,
        contentType,
        url,
        snippet
      });
    } catch {}
    const err = new Error('Meshulam request blocked by WAF (Incapsula).');
    err.status = resp.status || 502;
    err.payload = { kind: 'meshulam_waf_blocked' };
    throw err;
  }
  if (resp.status >= 400 || data?.status !== 1) {
    const err = new Error(data?.err || data?.message || `Meshulam error (status ${resp.status})`);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export async function approveMeshulamTransaction({ settings, payload }) {
  const url = settings.approveUrl || DEFAULT_APPROVE_URL;
  const form = new FormData();
  Object.entries(payload || {}).forEach(([key, value]) => {
    if (typeof value === 'undefined' || value === null) return;
    form.append(key, String(value));
  });
  const resp = await axios.post(url, form, {
    headers: form.getHeaders(),
    timeout: 20000,
    validateStatus: () => true
  });
  const data = resp?.data || {};
  if (resp.status >= 400 || data?.status !== 1) {
    const err = new Error(data?.err || data?.message || `Meshulam approve error (status ${resp.status})`);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export function buildMeshulamApprovePayload({ settings, session, callback }) {
  const processId = callback?.processId || callback?.processID || session?.paymentDetails?.meshulam?.processId || '';
  const processToken = callback?.processToken || callback?.processTOKEN || session?.paymentDetails?.meshulam?.processToken || '';
  const transactionId = callback?.transactionId || callback?.transactionID || callback?.tranId || callback?.transaction || '';
  const sum = callback?.sum || session?.cardChargeAmount || session?.totalWithShipping || '';

  return {
    userId: settings.userId || '',
    pageCode: settings.pageCode || '',
    processId: processId || undefined,
    processToken: processToken || undefined,
    transactionId: transactionId || undefined,
    sum: sum || undefined
  };
}

export function getMeshulamCallbackSessionId(payload) {
  const raw = payload || {};
  return String(raw.cField1 || raw.cfield1 || raw.customField1 || raw.sessionId || raw.sessionID || '').trim();
}
