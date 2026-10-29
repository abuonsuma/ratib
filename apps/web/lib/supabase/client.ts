import { createBrowserClient } from '@supabase/ssr';

/** Browser client. Used only for direct file uploads; everything else goes through server actions. */
export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
