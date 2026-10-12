import { db } from '../db/index.js';
import { isAdminRequest, getAdminUser, getAdminSubscription } from '../middleware/admin.js';

/**
 * Resume Rater - 100% Free & Open Platform
 * All subscription requirements and paywalls removed
 */
export const PLANS = {
  FREE: {
    id: 'free_unlimited',
    name: '100% Free Forever',
    price: 0,
    interval: 'forever',
    features: [
      'Unlimited PDF & DOCX ATS scans',
      'Full TF-IDF numerical similarity scoring',
      'Multi-dimensional Recharts competency radar',
      'Real-time keyword frequency gap analyzer',
      'All section parsers (Education, Experience, Skills, Projects)',
      'Job listings & tailored role matching',
      'Cloud data persistence powered by Supabase PostgreSQL',
      'Zero subscription fees or credit card requirements'
    ]
  }
};

export const billingService = {
  async createCheckoutSession(userId, plan = 'free_unlimited', hostUrl = 'http://localhost:3000') {
    return {
      success: true,
      isFree: true,
      message: 'Resume Rater is completely 100% free with unlimited scans. No payment or subscription required.',
      checkoutUrl: `${hostUrl}/#features`
    };
  },

  async createPortalSession(userId, returnUrl = 'http://localhost:3000') {
    return {
      success: true,
      isFree: true,
      message: 'Your account is on the 100% Free Unlimited plan.',
      url: returnUrl
    };
  },

  async handleWebhookEvent(rawBody, signatureHeader) {
    return { received: true, message: 'Platform operates in 100% free mode.' };
  }
};

/**
 * Subscription & Quota Enforcement Middleware
 * Fully unlocked: All users have 100% free, unlimited ATS scans.
 */
export function checkSubscriptionAndQuota(req, res, next) {
  const admin = isAdminRequest(req);
  const userId = admin ? 'usr_admin_saad' : (req.headers['x-user-id'] || req.cookies?.user_id || 'usr_demo_001');

  let user = admin ? getAdminUser() : db.users.find(userId);
  if (!user) {
    user = db.users.create({ id: userId, email: admin ? 'saadalioffic@gmail.com' : 'candidate@example.com', name: admin ? 'Saad Ali (Admin)' : 'Candidate' });
  }

  req.user = user;
  req.isAdmin = admin;
  req.isPro = true;
  req.isFreeForever = true;
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

  // Scan quota consumer: non-limiting pass-through
  req.consumeScanQuota = () => {};

  return next();
}
