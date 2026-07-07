import { createBrowserClient } from '@supabase/ssr';

export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_AIRLAB_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_AIRLAB_SUPABASE_ANON_KEY!
  );
}
