import express from 'express';
import { adminAuth } from '../middleware/auth.js';
import { upsertCheckoutDraft, getCheckoutDraft, deleteCheckoutDraft, listCheckoutDrafts, updateCheckoutDraftAdmin, deleteCheckoutDraftAdmin } from '../controllers/checkoutDraftController.js';

const router = express.Router();

router.get('/admin/list', adminAuth, listCheckoutDrafts);
router.patch('/admin/:id', adminAuth, updateCheckoutDraftAdmin);
router.delete('/admin/:id', adminAuth, deleteCheckoutDraftAdmin);

router.post('/', upsertCheckoutDraft);
router.get('/:draftKey', getCheckoutDraft);
router.delete('/:draftKey', deleteCheckoutDraft);

export default router;
