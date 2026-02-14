import axios from 'axios';
import CheckoutDraft from '../models/CheckoutDraft.js';
import Settings from '../models/Settings.js';

const REMINDER_DELAY_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 1000;
const SETTINGS_CACHE_MS = 60 * 1000;
const envTwilio = {
  enabled: String(process.env.TWILIO_WHATSAPP_AUTO_ENABLED || '').trim() === '1',
  accountSid: process.env.TWILIO_ACCOUNT_SID || '',
  authToken: process.env.TWILIO_AUTH_TOKEN || '',
  from: process.env.TWILIO_WHATSAPP_FROM || '',
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || ''
};

// Default country code to rewrite local numbers (e.g. 059 -> +97259)
const DEFAULT_WHATSAPP_COUNTRY_CODE = (process.env.TWILIO_DEFAULT_COUNTRY_CODE || process.env.DEFAULT_COUNTRY_CODE || '972')
  .replace(/\D/g, '')
  .trim();

let timer = null;
let cachedSettings = null;
let cachedAt = 0;

const getSettings = async () => {
  const now = Date.now();
  if (cachedSettings && now - cachedAt < SETTINGS_CACHE_MS) return cachedSettings;
  cachedSettings = await Settings.findOne({}).lean();
  cachedAt = now;
  return cachedSettings;
};

const resolveName = (draft) => {
  const contactName = draft?.contact?.name || `${draft?.contact?.firstName || ''} ${draft?.contact?.lastName || ''}`.trim();
  if (contactName) return contactName;
  const payloadName = `${draft?.payload?.firstName || ''} ${draft?.payload?.lastName || ''}`.trim();
  return payloadName || 'Guest';
};

const resolvePhone = (draft) => {
  return draft?.contact?.mobile || draft?.payload?.mobile || draft?.payload?.phone || '';
};

const buildMessage = (template, name, discountCode, checkoutUrl) => {
  const fallback = 'Hi {{name}}, we saved your checkout details. Use code {{discountCode}} to finish here: {{checkoutUrl}}';
  const msg = (template && String(template).trim()) ? template : fallback;
  return msg
    .replace(/\{\{name\}\}/g, name || 'Guest')
    .replace(/\{\{discountCode\}\}/g, discountCode || '')
    .replace(/\{\{checkoutUrl\}\}/g, checkoutUrl || '');
};

const buildWhatsappLink = (phone, message) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
};

const normalizeE164 = (phone) => {
  const raw = String(phone || '').trim();
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  // Remove leading 00 (international dial prefix) if present
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  // If already starts with default country code (e.g. 972...), trust it
  if (DEFAULT_WHATSAPP_COUNTRY_CODE && digits.startsWith(DEFAULT_WHATSAPP_COUNTRY_CODE)) {
    return `+${digits}`;
  }

  // Convert local numbers that start with a leading 0 to E.164 using default country
  if (DEFAULT_WHATSAPP_COUNTRY_CODE && digits.startsWith('0')) {
    return `+${DEFAULT_WHATSAPP_COUNTRY_CODE}${digits.slice(1)}`;
  }

  // Handle local numbers missing the leading 0 (e.g. 598..., 2598...)
  if (DEFAULT_WHATSAPP_COUNTRY_CODE && digits.length >= 7 && digits.length <= 11) {
    return `+${DEFAULT_WHATSAPP_COUNTRY_CODE}${digits}`;
  }

  return `+${digits}`;
};

const normalizeWhatsAppAddress = (phone) => {
  const e164 = normalizeE164(phone);
  if (!e164) return '';
  return `whatsapp:${e164}`;
};

const normalizeFromAddress = (from) => {
  const raw = String(from || '').trim();
  if (!raw) return '';
  if (raw.startsWith('whatsapp:')) return raw;
  if (raw.startsWith('+')) return `whatsapp:${raw}`;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  return `whatsapp:+${digits}`;
};

const sendWhatsAppViaTwilio = async ({ accountSid, authToken, from, messagingServiceSid, to, body }) => {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const payload = new URLSearchParams();
  if (messagingServiceSid) {
    payload.set('MessagingServiceSid', messagingServiceSid);
  } else {
    payload.set('From', from);
  }
  payload.set('To', to);
  payload.set('Body', body);
  const response = await axios.post(url, payload.toString(), {
    auth: { username: accountSid, password: authToken },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return response?.data || null;
};

export function startCheckoutDraftReminderScheduler() {
  if (timer) return;

  const tick = async () => {
    try {
      const cutoff = new Date(Date.now() - REMINDER_DELAY_MS);
      const due = await CheckoutDraft.find({
        $and: [
          { lastSeenAt: { $lte: cutoff } },
          { $or: [{ reminderCount: { $exists: false } }, { reminderCount: 0 }] },
          {
            $or: [
              { 'contact.mobile': { $exists: true, $ne: '' } },
              { 'payload.mobile': { $exists: true, $ne: '' } },
              { 'payload.phone': { $exists: true, $ne: '' } }
            ]
          }
        ]
      })
        .sort({ lastSeenAt: 1 })
        .limit(10);

      if (!due.length) return;

      const settings = await getSettings();
      const cf = settings?.checkoutForm || {};
      const template = cf.reminderMessageTemplate || '';
      const checkoutUrl = cf.reminderCheckoutUrl || '';
      const discountCode = cf.reminderDiscountCode || '';
      const whatsappEnabled = cf.reminderWhatsAppEnabled != null
        ? !!cf.reminderWhatsAppEnabled
        : envTwilio.enabled;
      const accountSid = String(cf.twilioAccountSid || envTwilio.accountSid || '').trim();
      const authToken = String(cf.twilioAuthToken || envTwilio.authToken || '').trim();
      const from = normalizeFromAddress(cf.twilioWhatsAppFrom || envTwilio.from || '');
      const messagingServiceSid = String(cf.twilioMessagingServiceSid || envTwilio.messagingServiceSid || '').trim();

      if (!whatsappEnabled || !accountSid || !authToken || (!from && !messagingServiceSid)) {
        console.warn('[reminder] Twilio WhatsApp not configured; skipping auto reminders');
        return;
      }

      for (const draft of due) {
        try {
          const phone = resolvePhone(draft);
          const to = normalizeWhatsAppAddress(phone);
          if (!to) continue;
          const message = buildMessage(template, resolveName(draft), discountCode, checkoutUrl);

          const result = await sendWhatsAppViaTwilio({
            accountSid,
            authToken,
            from,
            messagingServiceSid,
            to,
            body: message
          });

          const link = buildWhatsappLink(phone, message);
          const note = `Auto WhatsApp sent (Twilio): ${result?.sid || 'unknown'}${link ? `\n${link}` : ''}`;
          draft.lastReminderAt = new Date();
          draft.lastReminderChannel = 'whatsapp-auto';
          draft.reminderCount = Number(draft.reminderCount || 0) + 1;
          draft.reminderNote = draft.reminderNote ? `${draft.reminderNote}\n${note}` : note;
          await draft.save();

          console.log('[reminder] WhatsApp sent via Twilio', { id: draft._id, sid: result?.sid || '' });
        } catch (e) {
          console.warn('[reminder] Failed to process draft', draft?._id, e?.message || e);
        }
      }
    } catch (e) {
      console.warn('[reminder] scheduler tick failed', e?.message || e);
    }
  };

  timer = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopCheckoutDraftReminderScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
