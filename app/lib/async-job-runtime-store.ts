import { registerAsyncJobRuntimeStoreSupabaseFactory } from "@airlab/orchestration-runtime/async-job-runtime-store";

import { createSupabaseAdminClient } from "./supabase-admin";

registerAsyncJobRuntimeStoreSupabaseFactory(createSupabaseAdminClient);

export * from "@airlab/orchestration-runtime/async-job-runtime-store";
