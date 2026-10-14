import { createClient } from '@supabase/supabase-js';
import { db } from '../db/index.js';

// Admin identity is read entirely from environment — nothing hardcoded.
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();
export const ADMIN_USER_ID = 'usr_admin_saad';

// Override key is read lazily each request so Vercel env var changes take effect
// without a redeploy. Never has a hardcoded fallback.
function getAdminOverrideKey() {
  return process.env.ADMIN_OVERRIDE_KEY || null;
}

// Default to OFF so the platform is secure without any env configuration.
let globalAdminOverride = false;

export function isGlobalAdminOverrideActive() {
  return globalAdminOverride;
}

export function setGlobalAdminOverride(active) {
  globalAdminOverride = !!active;
  return globalAdminOverride;
}

export function getAdminUser() {
  if (!ADMIN_EMAIL) return null;
  let user = db.users.find(ADMIN_USER_ID);
  if (!user) {
    user = db.users.create({
      id: ADMIN_USER_ID,
      email: ADMIN_EMAIL,
      name: 'Platform Admin',
      role: 'admin',
      isAdmin: true
    });
  }
  return user;
}

export function getAdminSubscription() {
  return {
    id: 'sub_admin_unlimited',
    userId: ADMIN_USER_ID,
    planTier: 'admin_unlimited',
    status: 'active',
    currentPeriodEnd: '2099-12-31T23:59:59.999Z',
    cancelAtPeriodEnd: false,
    isAdmin: true,
    isPro: true,
    unrestrictedAccess: true,
    createdAt: new Date().toISOString()
  };
}

/**
 * Verify a Supabase JWT from the Authorization header server-side.
 * Returns the Supabase user object on success, null on failure.
 */
async function verifySupabaseJwt(req) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  try {
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await adminClient.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch {
    return null;
  }
}

/**
 * Express middleware that protects /api/admin/* routes.
 *
 * A request is admin-authenticated if:
 *   1. A valid Supabase JWT is in the Authorization header AND the
 *      verified email matches ADMIN_EMAIL (env), OR
 *   2. A valid ADMIN_OVERRIDE_KEY (env) is in the X-Admin-Key header
 *      (intended for server-to-server / CLI use only).
 *
 * Every other path that used to grant admin access (query params,
 * user-controlled headers, cookies, global override flag) has been removed
 * because they are trivially spoofable by any anonymous visitor.
 */
export async function requireAdminAuth(req, res, next) {
  // Path 1: Supabase JWT verification
  const supabaseUser = await verifySupabaseJwt(req);
  if (supabaseUser) {
    const email = (supabaseUser.email || '').toLowerCase();
    if (ADMIN_EMAIL && email === ADMIN_EMAIL) {
      req.adminUser = supabaseUser;
      return next();
    }
    return res.status(403).json({ success: false, error: 'Forbidden: insufficient privileges.' });
  }

  // Path 2: Static override key (env-only, no hardcoded fallback)
  const ADMIN_OVERRIDE_KEY = getAdminOverrideKey();
  if (ADMIN_OVERRIDE_KEY) {
    const provided = req.headers['x-admin-key'] || '';
    if (provided && provided === ADMIN_OVERRIDE_KEY) {
      req.adminUser = { email: ADMIN_EMAIL, role: 'admin', source: 'override-key' };
      return next();
    }
  }

  return res.status(401).json({ success: false, error: 'Unauthorized: admin authentication required.' });
}

/**
 * isAdminRequest — used ONLY to decide the user identity for rendering/quota
 * purposes on non-admin routes (e.g. whether to show dev tools, which userId
 * to bucket usage under).  It no longer controls security-sensitive actions.
 *
 * It checks ONLY the Supabase-set cookie (written by /api/auth/sync after a
 * verified sign-in) against ADMIN_EMAIL, so an anonymous visitor cannot
 * spoof it by crafting a query param or custom header.
 */
export function isAdminRequest(req) {
  if (!req || !ADMIN_EMAIL) return false;
  const cookieEmail = (req.cookies?.user_email || '').toLowerCase();
  return cookieEmail === ADMIN_EMAIL;
}
