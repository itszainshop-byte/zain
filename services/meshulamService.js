import axios from 'axios';
import Settings from '../models/Settings.js';

const DEFAULT_CREATE_URL = 'https://sandbox.meshulam.co.il/api/light/server/1.0/createPaymentProcess';
const DEFAULT_APPROVE_URL = 'https://sandbox.meshulam.co.il/api/light/server/1.0/approveTransaction';

// Tenant defaults (provided by user, non-secret).
const DEFAULT_USER_ID = '4d405ec9bd740efd';
export const MESHULAM_PAGE_CODES = {
  sdkwallet: 'c34d1f4a546f',
  generic: 'b73ca07591f8',
  creditcard: '76195ea4fc1a',
  googlepay: '77a2993849cd',
  applepay: '9eeea7787d67',
  bit: 'e20c9458e9f3',
  bitqr: '39bf173ce7d0'
};

export async function loadMeshulamSettings() {
  const settings = await Settings.findOne().lean().exec();
  const cfg = settings?.payments?.meshulam || {};
  return {
    enabled: !!cfg.enabled,
    apiUrl: cfg.apiUrl || DEFAULT_CREATE_URL,
    approveUrl: cfg.approveUrl || DEFAULT_APPROVE_URL,
    pageCode: cfg.pageCode || MESHULAM_PAGE_CODES.creditcard,
    userId: cfg.userId || DEFAULT_USER_ID,
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

function isPublicHttpsUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return false;
    if (host.endsWith('.local')) return false;
    return true;
  } catch {
    return false;
  }
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

function normalizePageType(pageType) {
  if (!pageType) return '';
  return String(pageType).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function resolveMeshulamPageCode({ settings, overrides }) {
  const normalizedType = normalizePageType(overrides?.pageType);
  if (normalizedType) {
    const mapped = MESHULAM_PAGE_CODES[normalizedType];
    if (!mapped) throw new Error('meshulam_unknown_page_type');
    return mapped;
  }

  if (overrides?.pageCode) return overrides.pageCode;
  return settings?.pageCode || MESHULAM_PAGE_CODES.generic;
}

function pickFirst(raw, keys) {
  if (!raw) return undefined;
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'undefined' || v === null) continue;
    const s = String(v).trim();
    if (s.length === 0) continue;
    return v;
  }
  return undefined;
}

function hasValue(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

const APPROVE_REQUIRED_FIELDS = [
  'pageCode',
  'userId',
  'transactionId',
  'transactionToken',
  'transactionTypeId',
  'paymentType',
  'sum',
  'firstPaymentSum',
  'periodicalPaymentSum',
  'paymentsNum',
  'allPaymentsNum',
  'paymentDate',
  'asmachta',
  'description',
  'fullName',
  'payerPhone',
  'payerEmail',
  'cardSuffix',
  'cardType',
  'cardTypeCode',
  'cardBrand',
  'cardBrandCode',
  'cardExp',
  'processId',
  'processToken'
];

export function findMissingApproveFields(payload = {}) {
  return APPROVE_REQUIRED_FIELDS.filter((k) => !hasValue(payload[k]));
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
  const notifyUrl = overrides.notifyUrl || settings.notifyUrl || (origin ? `${origin}/api/meshulam/callback` : '');

  if (!isPublicHttpsUrl(successUrl)) {
    throw new Error('meshulam_invalid_success_url');
  }
  if (!isPublicHttpsUrl(cancelUrl)) {
    throw new Error('meshulam_invalid_cancel_url');
  }
  if (!isPublicHttpsUrl(notifyUrl)) {
    throw new Error('meshulam_invalid_notify_url');
  }

  const pageCode = resolveMeshulamPageCode({ settings, overrides });

  const description = overrides.description || `Order ${session.reference || session._id}`;

  const payload = {
    pageCode,
    userId: overrides.userId || settings.userId || DEFAULT_USER_ID,
    apiKey: settings.apiKey || undefined,
    sum: String(sum),
    successUrl: successUrl || '',
    cancelUrl: cancelUrl || '',
    description,
    'pageField[fullName]': fullName,
    'pageField[phone]': phone,
    'pageField[email]': email || undefined,
    cField1: String(session._id),
    notifyUrl: notifyUrl || undefined
  };

  return { payload, sum, successUrl, cancelUrl, notifyUrl, pageCode };
}

export async function requestMeshulamPaymentProcess({ session, settings, origin, overrides = {} }) {
  const { payload, pageCode } = buildMeshulamCreateForm({ session, settings, origin, overrides });
  const url = settings.apiUrl || DEFAULT_CREATE_URL;
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const extraHeaders = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'User-Agent': ua
  };
  if (origin) {
    extraHeaders.Origin = origin;
    extraHeaders.Referer = origin;
  }
  const formBody = new URLSearchParams();
  Object.entries(payload || {}).forEach(([key, value]) => {
    if (typeof value === 'undefined' || value === null) return;
    formBody.append(key, String(value));
  });
  const resp = await axios.post(url, formBody.toString(), {
    headers: extraHeaders,
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
      if (String(process.env.MESHULAM_WAF_DEBUG || '') === '1') {
        console.warn('[meshulam][waf] headers', resp?.headers || {});
        console.warn('[meshulam][waf] body', rawText || '');
      }
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
  return { ...data, pageCode };
}

export async function approveMeshulamTransaction({ settings, payload }) {
  const url = settings.approveUrl || DEFAULT_APPROVE_URL;
  const formBody = new URLSearchParams();
  Object.entries(payload || {}).forEach(([key, value]) => {
    if (typeof value === 'undefined' || value === null) return;
    formBody.append(key, String(value));
  });
  const resp = await axios.post(url, formBody.toString(), {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    },
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
  const cb = callback || {};
  const processId = pickFirst(cb, ['processId', 'processID', 'processid']) || session?.paymentDetails?.meshulam?.processId || '';
  const processToken = pickFirst(cb, ['processToken', 'processTOKEN', 'processTOKEN', 'processtoken']) || session?.paymentDetails?.meshulam?.processToken || '';
  const transactionId = pickFirst(cb, ['transactionId', 'transactionID', 'tranId', 'transaction', 'tranid']) || '';
  const transactionToken = pickFirst(cb, ['transactionToken', 'transactionTOKEN', 'trantoken', 'transactiontoken', 'tranToken']) || '';
  const transactionTypeId = pickFirst(cb, ['transactionTypeId', 'transactiontypeid', 'transactionTypeID']);
  const paymentType = pickFirst(cb, ['paymentType', 'paymenttype', 'paymenttypeid']);
  const sum = pickFirst(cb, ['sum', 'amount']) || session?.cardChargeAmount || session?.totalWithShipping || '';
  const firstPaymentSum = pickFirst(cb, ['firstPaymentSum', 'firstPayment']);
  const periodicalPaymentSum = pickFirst(cb, ['periodicalPaymentSum', 'periodicalPayment', 'periodicPayment']);
  const paymentsNum = pickFirst(cb, ['paymentsNum', 'payments', 'paymentNumber']);
  const allPaymentsNum = pickFirst(cb, ['allPaymentsNum', 'totalPayments', 'paymentsTotal']);
  const paymentDate = pickFirst(cb, ['paymentDate', 'date']);
  const asmachta = pickFirst(cb, ['asmachta', 'approvalCode', 'authNumber']);
  const description = pickFirst(cb, ['description']) || `Order ${session?.reference || session?._id || ''}`;
  const fullName = normalizeMeshulamFullName(
    pickFirst(cb, ['fullName', 'fullname', 'payerName']) ||
      `${session?.customerInfo?.firstName || ''} ${session?.customerInfo?.lastName || ''}` ||
      session?.customerInfo?.email || ''
  );
  const payerPhone = normalizeMeshulamPhone(pickFirst(cb, ['payerPhone', 'phone']) || session?.customerInfo?.mobile || '');
  const payerEmail = pickFirst(cb, ['payerEmail', 'email']) || session?.customerInfo?.email || '';
  const cardSuffix = pickFirst(cb, ['cardSuffix', 'cardLast4', 'last4']);
  const cardType = pickFirst(cb, ['cardType', 'cardtype']);
  const cardTypeCode = pickFirst(cb, ['cardTypeCode', 'cardtypecode']);
  const cardBrand = pickFirst(cb, ['cardBrand', 'cardbrand', 'brand']);
  const cardBrandCode = pickFirst(cb, ['cardBrandCode', 'cardbrandcode']);
  const cardExp = pickFirst(cb, ['cardExp', 'cardexp', 'exp']);
  const pageCode =
    pickFirst(cb, ['pageCode', 'pagecode']) || session?.paymentDetails?.meshulam?.pageCode || settings?.pageCode || MESHULAM_PAGE_CODES.generic;

  return {
    userId: settings.userId || DEFAULT_USER_ID,
    pageCode: pageCode || undefined,
    transactionId: transactionId || undefined,
    transactionToken: transactionToken || undefined,
    transactionTypeId: normalizeNumber(transactionTypeId, undefined),
    paymentType: normalizeNumber(paymentType, undefined),
    sum: sum || undefined,
    firstPaymentSum: normalizeNumber(firstPaymentSum, undefined),
    periodicalPaymentSum: normalizeNumber(periodicalPaymentSum, undefined),
    paymentsNum: normalizeNumber(paymentsNum, undefined),
    allPaymentsNum: normalizeNumber(allPaymentsNum, undefined),
    paymentDate: paymentDate || undefined,
    asmachta: asmachta || undefined,
    description: description || undefined,
    fullName: fullName || undefined,
    payerPhone: payerPhone || undefined,
    payerEmail: payerEmail || undefined,
    cardSuffix: cardSuffix || undefined,
    cardType: cardType || undefined,
    cardTypeCode: normalizeNumber(cardTypeCode, undefined),
    cardBrand: cardBrand || undefined,
    cardBrandCode: normalizeNumber(cardBrandCode, undefined),
    cardExp: cardExp || undefined,
    processId: processId || undefined,
    processToken: processToken || undefined
  };
}

export function getMeshulamCallbackSessionId(payload) {
  const raw = payload || {};
  return String(raw.cField1 || raw.cfield1 || raw.customField1 || raw.sessionId || raw.sessionID || '').trim();
}
