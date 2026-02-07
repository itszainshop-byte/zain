import mongoose from 'mongoose';

const checkoutDraftSchema = new mongoose.Schema({
  draftKey: { type: String, required: true, unique: true, index: true },
  source: { type: String, enum: ['web', 'mobile', 'unknown'], default: 'unknown' },
  contact: {
    name: { type: String },
    firstName: { type: String },
    lastName: { type: String },
    mobile: { type: String },
    email: { type: String }
  },
  address: {
    address: { type: String },
    line1: { type: String },
    line2: { type: String },
    city: { type: String },
    state: { type: String },
    zip: { type: String },
    country: { type: String },
    countryCode: { type: String },
    phoneCode: { type: String },
    pickup: { type: Boolean }
  },
  payload: { type: mongoose.Schema.Types.Mixed },
  reminderCount: { type: Number, default: 0 },
  lastReminderAt: { type: Date },
  lastReminderChannel: { type: String },
  reminderNote: { type: String },
  lastSeenAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 1000 * 60 * 60 * 24 * 14) }
}, {
  timestamps: true
});

checkoutDraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const CheckoutDraft = mongoose.model('CheckoutDraft', checkoutDraftSchema);
export default CheckoutDraft;
