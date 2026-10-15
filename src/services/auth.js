/**
 * Server-side verification of Supabase access tokens.
 *
 * Uses the public anon key: `auth.getUser(token)` asks Supabase Auth to
 * validate the token, so no service-role key is needed on this server.
 */
import { createClient } from '@supabase/supabase-js';

let client = null;
let verifier = null;

export function authConfigured() {
  return !!(verifier || (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY));
}

/** Test seam: replace the token verifier. Pass null to restore the default. */
export function setTokenVerifier(fn) {
  verifier = fn;
}

function getClient() {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
  }
  return client;
}

/**
 * @param {string} token Supabase access token (JWT)
 * @returns {Promise<{id:string,email:string,name:string,avatar:string,emailConfirmed:boolean}|null>}
 */
export async function verifyAccessToken(token) {
  if (!token || typeof token !== 'string') return null;
  if (verifier) return verifier(token);
  if (!authConfigured()) return null;
  try {
    const { data, error } = await getClient().auth.getUser(token);
    if (error || !data?.user?.email) return null;
    const u = data.user;
    const meta = u.user_metadata || {};
    return {
      id: u.id,
      email: u.email.toLowerCase(),
      name: String(meta.full_name || meta.name || u.email.split('@')[0]).slice(0, 100),
      avatar: String(meta.avatar_url || '').slice(0, 512),
      emailConfirmed: !!(u.email_confirmed_at || u.confirmed_at)
    };
  } catch {
    return null;
  }
}

export function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}
