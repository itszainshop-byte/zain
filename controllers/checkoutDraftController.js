import axios from 'axios';
import CheckoutDraft from '../models/CheckoutDraft.js';
import Settings from '../models/Settings.js';

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
  const fallback = [
    'היי {{name}} 👋',
    '',
    'שמנו לב שהתחלת הזמנה אבל לא השלמת אותה 🛒',
    'רק רצינו להזכיר לך – העגלה שלך עדיין מחכה ⏱️',
    '',
    '🎁 אם תסיים את ההזמנה עכשיו, תקבל:',
    '🚚 משלוח מהיר עד דלת הבית – מתנה',
    '💸 בנוסף, תוכל להשתמש בקוד {{discountCode}} ולקבל 10% הנחה על ההזמנה שלך',
    '',
    '⏳ המוצרים שמורים עבורך והקישור עדיין פעיל 👇',
    '{{checkoutUrl}}',
    '',
    'יש שאלה או משהו לא ברור?',
    'אני כאן בשבילך 😊'
  ].join('\n');
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

const VALID_SOURCES = new Set(['web', 'mobile', 'unknown']);

const resolveSource = (value) => {
  const s = String(value || '').toLowerCase();
  return VALID_SOURCES.has(s) ? s : 'unknown';
};

export const upsertCheckoutDraft = async (req, res) => {
  try {
    const { draftKey, source, contact, address, payload } = req.body || {};
    if (!draftKey || typeof draftKey !== 'string') {
      return res.status(400).json({ message: 'draftKey is required' });
    }

    const now = new Date();
    const update = {
      source: resolveSource(source),
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 1000 * 60 * 60 * 24 * 14)
    };
    if (contact && typeof contact === 'object') update.contact = contact;
    if (address && typeof address === 'object') update.address = address;
    if (payload && typeof payload === 'object') update.payload = payload;

    const draft = await CheckoutDraft.findOneAndUpdate(
      { draftKey },
      { $set: update, $setOnInsert: { draftKey } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return res.json({ ok: true, draft });
  } catch (error) {
    console.error('upsertCheckoutDraft failed', error);
    return res.status(500).json({ message: 'Failed to save draft' });
  }
};

export const getCheckoutDraft = async (req, res) => {
  try {
    const { draftKey } = req.params || {};
    if (!draftKey) {
      return res.status(400).json({ message: 'draftKey is required' });
    }
    const draft = await CheckoutDraft.findOne({ draftKey });
    return res.json({ ok: true, draft: draft || null });
  } catch (error) {
    console.error('getCheckoutDraft failed', error);
    return res.status(500).json({ message: 'Failed to load draft' });
  }
};

export const deleteCheckoutDraft = async (req, res) => {
  try {
    const { draftKey } = req.params || {};
    if (!draftKey) {
      return res.status(400).json({ message: 'draftKey is required' });
    }
    await CheckoutDraft.deleteOne({ draftKey });
    return res.json({ ok: true });
  } catch (error) {
    console.error('deleteCheckoutDraft failed', error);
    return res.status(500).json({ message: 'Failed to delete draft' });
  }
};

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const listCheckoutDrafts = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query?.page) || 1);
    const limit = Math.min(100, Math.max(5, Number(req.query?.limit) || 25));
    const search = String(req.query?.search || '').trim();
    const source = String(req.query?.source || '').trim();
    const reminded = String(req.query?.reminded || '').trim();
    const hasContact = String(req.query?.hasContact || '').trim();
    const sinceDays = Number(req.query?.sinceDays || 0);

    const filters = [];

    if (source) filters.push({ source });

    if (sinceDays > 0) {
      const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
      filters.push({ lastSeenAt: { $gte: since } });
    }

    if (reminded === '1') {
      filters.push({ reminderCount: { $gt: 0 } });
    } else if (reminded === '0') {
      filters.push({ $or: [{ reminderCount: { $exists: false } }, { reminderCount: 0 }] });
    }

    if (hasContact === '1') {
      filters.push({
        $or: [
          { 'contact.mobile': { $exists: true, $ne: '' } },
          { 'contact.email': { $exists: true, $ne: '' } },
          { 'payload.mobile': { $exists: true, $ne: '' } },
          { 'payload.email': { $exists: true, $ne: '' } },
          { 'payload.phone': { $exists: true, $ne: '' } }
        ]
      });
    }

    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      const searchFields = [
        'contact.name',
        'contact.firstName',
        'contact.lastName',
        'contact.mobile',
        'contact.email',
        'address.address',
        'address.line1',
        'address.city',
        'payload.firstName',
        'payload.lastName',
        'payload.mobile',
        'payload.phone',
        'payload.email',
        'payload.address',
        'payload.line1',
        'payload.city'
      ];
      filters.push({ $or: searchFields.map(field => ({ [field]: rx })) });
    }

    const query = filters.length ? { $and: filters } : {};

    const total = await CheckoutDraft.countDocuments(query);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const drafts = await CheckoutDraft.find(query)
      .sort({ lastSeenAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    return res.json({ drafts, page, totalPages, total });
  } catch (error) {
    console.error('listCheckoutDrafts failed', error);
    return res.status(500).json({ message: 'Failed to load drafts' });
  }
};

export const sendCheckoutDraftReminder = async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ message: 'id is required' });

    const draft = await CheckoutDraft.findById(id);
    if (!draft) return res.status(404).json({ message: 'Draft not found' });

    const settings = await Settings.findOne();
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

    if (!whatsappEnabled) return res.status(400).json({ message: 'WhatsApp reminders are disabled' });
    if (!accountSid || !authToken || (!from && !messagingServiceSid)) {
      return res.status(400).json({ message: 'Twilio credentials are not configured' });
    }

    const phone = resolvePhone(draft);
    const to = normalizeWhatsAppAddress(phone);
    if (!to) return res.status(400).json({ message: 'No phone number available for this draft' });

    const body = buildMessage(template, resolveName(draft), discountCode, checkoutUrl);

    const result = await sendWhatsAppViaTwilio({
      accountSid,
      authToken,
      from,
      messagingServiceSid,
      to,
      body
    });

    const customNote = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    const link = buildWhatsappLink(phone, body);
    const note = `Manual WhatsApp sent (Twilio): ${result?.sid || 'unknown'}${link ? `\n${link}` : ''}${customNote ? `\n${customNote}` : ''}`;

    draft.lastReminderAt = new Date();
    draft.lastReminderChannel = 'whatsapp-admin';
    draft.reminderCount = Number(draft.reminderCount || 0) + 1;
    draft.reminderNote = draft.reminderNote ? `${draft.reminderNote}\n${note}` : note;
    await draft.save();

    return res.json({ ok: true, sid: result?.sid || null, to, message: body });
  } catch (error) {
    const twilioData = error?.response?.data || {};
    const status = error?.response?.status || 500;
    const twilioMsg = twilioData?.message || twilioData?.more_info;
    const twilioCode = twilioData?.code || twilioData?.error_code;
    const detail = twilioMsg || error?.message || 'Unknown error';
    console.error('sendCheckoutDraftReminder failed', { status, twilioCode, detail, twilioData });
    return res.status(status).json({
      message: `Failed to send reminder: ${detail}`,
      code: twilioCode || null,
      status
    });
  }
};

export const updateCheckoutDraftAdmin = async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ message: 'id is required' });

    const { reminderNote, markReminded, reminderChannel } = req.body || {};

    const update = { $set: {}, $inc: {} };
    if (typeof reminderNote === 'string') update.$set.reminderNote = reminderNote;
    if (typeof reminderChannel === 'string' && reminderChannel.trim()) {
      update.$set.lastReminderChannel = reminderChannel.trim();
    }
    if (markReminded) {
      update.$set.lastReminderAt = new Date();
      update.$inc.reminderCount = 1;
    }

    if (!Object.keys(update.$set).length && !Object.keys(update.$inc).length) {
      return res.status(400).json({ message: 'No updates provided' });
    }

    const draft = await CheckoutDraft.findByIdAndUpdate(id, update, { new: true });
    if (!draft) return res.status(404).json({ message: 'Draft not found' });
    return res.json({ ok: true, draft });
  } catch (error) {
    console.error('updateCheckoutDraftAdmin failed', error);
    return res.status(500).json({ message: 'Failed to update draft' });
  }
};

export const deleteCheckoutDraftAdmin = async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ message: 'id is required' });
    await CheckoutDraft.deleteOne({ _id: id });
    return res.json({ ok: true });
  } catch (error) {
    console.error('deleteCheckoutDraftAdmin failed', error);
    return res.status(500).json({ message: 'Failed to delete draft' });
  }
};
