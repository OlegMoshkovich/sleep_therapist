import { registerDatasetToolSupabaseFactory } from "@airlab/orchestration-runtime/dataset-store";

import { createSupabaseAdminClient } from "../supabase-admin";

registerDatasetToolSupabaseFactory(createSupabaseAdminClient);

export * from "@airlab/orchestration-runtime/knowledge-save";
