import CheckoutDraft from '../models/CheckoutDraft.js';

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
