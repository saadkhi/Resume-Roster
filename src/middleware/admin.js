import crypto from 'crypto';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Protects operator-only routes (/api/admin/*).
 *
 * Requires the ADMIN_OVERRIDE_KEY secret in the X-Admin-Key header. Accounts
 * are self-service and emails are not verified, so no user session (not even
 * one whose email matches an "admin" address) can grant operator access.
 */
export function requireAdminAuth(req, res, next) {
  const key = process.env.ADMIN_OVERRIDE_KEY;
  const provided = req.headers['x-admin-key'];
  if (key && key.length >= 16 && provided && safeEqual(provided, key)) {
    req.adminUser = { source: 'override-key' };
    return next();
  }
  return res.status(401).json({ success: false, error: 'Unauthorized: admin authentication required.' });
}
