import rateLimit from 'express-rate-limit';

const isProduction = process.env.NODE_ENV === 'production';

export function getSafeErrorMessage(err, fallback = 'An unexpected error occurred.') {
  if (!isProduction && err?.message) return err.message;
  return fallback;
}

function limiter(max, message) {
  return rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false, xForwardedForHeader: false },
    handler: (req, res) => res.status(429).json({ success: false, error: message })
  });
}

export const apiLimiter = limiter(120, 'Too many requests. Please slow down.');
export const uploadLimiter = limiter(20, 'Too many uploads. Please wait a moment and try again.');
export const authLimiter = limiter(10, 'Too many sign-in attempts. Please wait a minute and try again.');

/** True when the buffer starts with the PDF magic number. */
export function isPdfBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-';
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests: if the
 * browser sent an Origin header it must match the host being served.
 */
export function sameOriginGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try {
    if (new URL(origin).host === host) return next();
  } catch { /* fall through */ }
  return res.status(403).json({ success: false, error: 'Cross-origin request blocked.' });
}
