import { createClient } from '@supabase/supabase-js';

/**
 * Service-role client. It bypasses Row Level Security, so it may only be used in server code that has already
 * authenticated its caller (for example the cron route). Never import this from a component or a client file.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase_admin_not_configured');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
