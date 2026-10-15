/**
 * Signed, httpOnly session cookies.
 *
 * Identity only ever comes from this cookie, which is minted after the server
 * has verified a password (see POST /api/auth/login). Nothing client-controlled
 * (headers, plain cookies, body fields) is trusted as identity.
 */
import crypto from 'crypto';

export const SESSION_COOKIE = 'rr_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const isProduction = () => process.env.NODE_ENV === 'production';
const devSecret = crypto.randomBytes(32).toString('hex');

function secret() {
  return process.env.SESSION_SECRET || (isProduction() ? null : devSecret);
}

/** Sessions can only be issued when a signing secret is available. */
export function sessionsEnabled() {
  const s = secret();
  return !!s && s.length >= 16;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

export function signSession(payload, now = Date.now()) {
  if (!sessionsEnabled()) throw new Error('SESSION_SECRET is not configured.');
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS }));
  return `${body}.${hmac(body)}`;
}

export function verifySession(token, now = Date.now()) {
  if (!token || typeof token !== 'string' || !sessionsEnabled()) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(hmac(body));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload?.uid || typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const key = part.slice(0, i).trim();
    let val = part.slice(i + 1).trim();
    try { val = decodeURIComponent(val); } catch { /* keep raw value */ }
    out[key] = val;
  }
  return out;
}

/** Populates req.cookies and req.user (null for anonymous visitors). */
export function sessionMiddleware(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  const payload = verifySession(req.cookies[SESSION_COOKIE]);
  req.user = payload ? { id: payload.uid, email: payload.email, name: payload.name } : null;
  next();
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction() || req.secure,
    path: '/'
  };
}

export function setSessionCookie(req, res, user) {
  const token = signSession({ uid: user.id, email: user.email, name: user.name });
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_TTL_SECONDS * 1000 });
}

export function clearSessionCookie(req, res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
}
