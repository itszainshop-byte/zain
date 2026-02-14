import Settings from '../models/Settings.js';

const DEFAULT_USER_ID = process.env.GROW_USER_ID || '4d405ec9bd740efd';
const DEFAULT_PAGE_CODE = process.env.GROW_PAGE_CODE || '76195ea4fc1a';
const API_BASE = (process.env.GROW_API_BASE || 'https://sandbox.meshulam.co.il').replace(/\/$/, '');
const CREATE_PATH = '/api/light/server/1.0/createPaymentProcess';
const APPROVE_PATH = '/api/light/server/1.0/approveTransaction';

function ensureFormData() {
  if (typeof FormData === 'undefined') {
    throw new Error('FormData is not available in this runtime. Node 18+ is required.');
  }
}

function pickPaymentUrl(data) {
  const candidates = [
    data?.resultData?.url,
    data?.resultData?.redirectUrl,
    data?.resultData?.lightboxUrl,
    data?.data?.url,
    data?.data?.redirectUrl,
    data?.data?.lightboxUrl,
    data?.redirectUrl,
    data?.lightboxUrl,
    data?.url
  ].filter((v) => typeof v === 'string');
  for (const u of candidates) {
    if (/^https?:\/\//i.test(u)) return u;
  }
  return '';
}

async function postForm(url, form) {
  ensureFormData();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: form
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    const err = new Error(`Grow API error: ${msg}`);
    err.response = data;
    err.status = res.status;
    throw err;
  }
  return { data, status: res.status };
}

export function resolveGrowConfig(settings) {
  const s = settings || {};
  const cfg = s?.payments?.grow || {};
  const userId = cfg.userId || DEFAULT_USER_ID;
  const pageCode = cfg.pageCode || DEFAULT_PAGE_CODE;
  const apiBase = (cfg.apiBase || API_BASE).replace(/\/$/, '');
  return { userId, pageCode, apiBase };
}

export async function loadGrowConfig() {
  const settings = await Settings.findOne();
  return resolveGrowConfig(settings || {});
}

export async function createGrowPayment({
  userId,
  pageCode,
  sum,
  successUrl,
  cancelUrl,
  description,
  fullName,
  phone,
  email,
  cField1,
  notifyUrl,
  customFields = {},
  apiBase
}) {
  ensureFormData();
  const amount = Number(sum);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error('sum must be a positive number');
    err.status = 400;
    throw err;
  }
  const cfgBase = (apiBase || API_BASE).replace(/\/$/, '');
  const url = `${cfgBase}${CREATE_PATH}`;
  const form = new FormData();
  form.append('pageCode', pageCode || DEFAULT_PAGE_CODE);
  form.append('userId', userId || DEFAULT_USER_ID);
  form.append('sum', amount);
  if (successUrl) form.append('successUrl', successUrl);
  if (cancelUrl) form.append('cancelUrl', cancelUrl);
  if (description) form.append('description', description);
  if (fullName) form.append('pageField[fullName]', fullName);
  if (phone) form.append('pageField[phone]', phone);
  if (email) form.append('pageField[email]', email);
  if (cField1) form.append('cField1', cField1);
  if (notifyUrl) form.append('notifyUrl', notifyUrl);
  Object.entries(customFields || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      form.append(k, v);
    }
  });
  const resp = await postForm(url, form);
  return { paymentUrl: pickPaymentUrl(resp.data), raw: resp.data };
}

export async function approveGrowTransaction(payload = {}, { pageCode, userId, apiBase } = {}) {
  ensureFormData();
  const cfgBase = (apiBase || API_BASE).replace(/\/$/, '');
  const url = `${cfgBase}${APPROVE_PATH}`;
  const form = new FormData();
  form.append('pageCode', pageCode || payload.pageCode || DEFAULT_PAGE_CODE);
  form.append('userId', userId || payload.userId || DEFAULT_USER_ID);

  const fields = [
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
  fields.forEach((key) => {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') {
      form.append(key, payload[key]);
    }
  });

  return postForm(url, form);
}

export default {
  resolveGrowConfig,
  loadGrowConfig,
  createGrowPayment,
  approveGrowTransaction,
  pickPaymentUrl
};
