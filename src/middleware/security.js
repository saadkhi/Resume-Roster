import fs from 'fs';
import rateLimit from 'express-rate-limit';
import { isAdminRequest } from './admin.js';

const isProduction = process.env.NODE_ENV === 'production';

export function getSafeErrorMessage(err, fallback = 'An unexpected error occurred.') {
  if (!isProduction && err?.message) return err.message;
  return fallback;
}

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false },
  skip: (req) => isAdminRequest(req),
  handler: (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.status(429).json({ success: false, error: 'Too many requests. Please slow down.' });
  }
});

export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false },
  skip: (req) => isAdminRequest(req),
  handler: (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.status(429).json({ success: false, error: 'Too many upload requests. Please wait a moment.' });
  }
});

export function validatePdfMagicBytes(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    fs.closeSync(fd);
    return buf.toString('ascii') === '%PDF-';
  } catch {
    return false;
  }
}

export function cleanupFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup
  }
}
