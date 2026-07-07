import { createClient } from "@supabase/supabase-js";
import {
  registerMemorySupabaseClientFactory,
  type MemorySupabaseClient,
} from "@airlab/orchestration-runtime/memory-supabase";

import { createSupabaseAdminClient } from "../supabase-admin";

registerMemorySupabaseClientFactory((): MemorySupabaseClient => {
  const url = process.env.MEMORY_SUPABASE_URL?.trim();
  const key = process.env.MEMORY_SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (url && key) {
    return createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  return createSupabaseAdminClient();
});

export * from "@airlab/orchestration-runtime/memory-supabase";
