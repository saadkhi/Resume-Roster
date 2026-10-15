import crypto from 'crypto';
import { verifyAccessToken, bearerToken } from '../services/auth.js';

// Admin identity comes from the environment only; nothing is hardcoded.
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

export function isAdminEmail(email, confirmed = true) {
  return !!ADMIN_EMAIL && confirmed && typeof email === 'string' && email.toLowerCase() === ADMIN_EMAIL;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Protects /api/admin/* and other operator-only routes.
 *
 * Accepts either:
 *   1. a Supabase access token (Authorization: Bearer ...) that the server
 *      verifies and whose confirmed email equals ADMIN_EMAIL, or
 *   2. the ADMIN_OVERRIDE_KEY env secret in X-Admin-Key (server-to-server / CLI).
 *
 * The signed session cookie alone is intentionally not enough for operator
 * routes, so a leaked cookie cannot be replayed cross-site as admin.
 */
export async function requireAdminAuth(req, res, next) {
  const token = bearerToken(req);
  if (token) {
    const user = await verifyAccessToken(token);
    if (user && isAdminEmail(user.email, user.emailConfirmed)) {
      req.adminUser = { email: user.email, source: 'supabase-jwt' };
      return next();
    }
    return res.status(user ? 403 : 401).json({
      success: false,
      error: user ? 'Forbidden: insufficient privileges.' : 'Unauthorized: invalid token.'
    });
  }

  const key = process.env.ADMIN_OVERRIDE_KEY;
  const provided = req.headers['x-admin-key'];
  if (key && provided && safeEqual(provided, key)) {
    req.adminUser = { email: ADMIN_EMAIL || null, source: 'override-key' };
    return next();
  }

  return res.status(401).json({ success: false, error: 'Unauthorized: admin authentication required.' });
}
