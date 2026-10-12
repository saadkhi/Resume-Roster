/**
 * Vercel Serverless Function: /api/create-checkout-session
 * Fully unlocked: Platform is 100% free with unlimited scans
 */
import '../src/polyfills.js';
import app from '../server.js';

export default async function handler(req, res) {
  if (res.setHeader && !res.headersSent) {
    res.setHeader('Content-Type', 'application/json');
  }

  const protocol = req.headers?.['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers?.host || req.get?.('host') || 'localhost:3000';
  const hostUrl = `${protocol}://${host}`;

  const freeResponse = {
    success: true,
    isFree: true,
    isPro: true,
    unrestrictedAccess: true,
    plan: 'free_unlimited',
    message: 'Resume Rater is completely 100% free with unlimited scans. No subscription or checkout required.',
    checkoutUrl: `${hostUrl}/#features`
  };

  if (res.json) return res.json(freeResponse);
  res.statusCode = 200;
  return res.end(JSON.stringify(freeResponse));
}
