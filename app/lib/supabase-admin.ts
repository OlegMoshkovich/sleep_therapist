import { createClient } from "@supabase/supabase-js";
import { isTestMode, createTestSupabaseClient } from "./test-mode";

export function createSupabaseAdminClient() {
  if (isTestMode()) {
    // Casting through unknown — the in-memory shim satisfies the surface used
    // by app code (from().select/insert/update/eq/in/order/single/...).
    return createTestSupabaseClient() as unknown as ReturnType<typeof createClient>;
  }
  return createClient(
    process.env.NEXT_PUBLIC_AIRLAB_SUPABASE_URL!,
    process.env.AIRLAB_SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
