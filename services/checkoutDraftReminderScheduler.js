import CheckoutDraft from '../models/CheckoutDraft.js';
import Settings from '../models/Settings.js';

const REMINDER_DELAY_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 1000;
const SETTINGS_CACHE_MS = 60 * 1000;

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
      const template = settings?.reminderMessageTemplate || '';
      const checkoutUrl = settings?.reminderCheckoutUrl || '';
      const discountCode = settings?.reminderDiscountCode || '';

      for (const draft of due) {
        try {
          const phone = resolvePhone(draft);
          const message = buildMessage(template, resolveName(draft), discountCode, checkoutUrl);
          const link = buildWhatsappLink(phone, message);
          if (!link) continue;

          const note = `Auto WhatsApp reminder: ${link}`;
          draft.lastReminderAt = new Date();
          draft.lastReminderChannel = 'whatsapp-auto';
          draft.reminderCount = Number(draft.reminderCount || 0) + 1;
          draft.reminderNote = draft.reminderNote ? `${draft.reminderNote}\n${note}` : note;
          await draft.save();

          console.log('[reminder] WhatsApp link generated', { id: draft._id, link });
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
