import { db } from '../db/index.js';
import { isAdminRequest, getAdminUser, getAdminSubscription } from '../middleware/admin.js';

/**
 * Subscription & Quota Enforcement Middleware
 * All users have unlimited free access — no paywall.
 */
export function checkSubscriptionAndQuota(req, res, next) {
  const admin = isAdminRequest(req);
  const userId = admin ? 'usr_admin_saad' : (req.headers['x-user-id'] || req.cookies?.user_id || 'usr_demo_001');
  const adminEmail = process.env.ADMIN_EMAIL || '';

  let user = admin ? getAdminUser() : db.users.find(userId);
  if (!user) {
    user = db.users.create({
      id: userId,
      email: admin ? adminEmail : 'candidate@example.com',
      name: admin ? 'Platform Admin' : 'Candidate'
    });
  }

  req.user = user;
  req.isAdmin = admin;
  req.isPro = true;
  req.subscription = admin ? getAdminSubscription() : {
    id: 'sub_free_unlimited',
    userId,
    planTier: 'free_unlimited',
    status: 'active',
    currentPeriodEnd: '2099-12-31T23:59:59.999Z',
    isPro: true
  };
  req.usage = {
    scansUsed: 0,
    maxFreeScans: 999999,
    scansRemaining: 'unlimited',
    monthYear: new Date().toISOString().slice(0, 7)
  };
  req.consumeScanQuota = () => {};

  return next();
}
