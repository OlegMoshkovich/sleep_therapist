import { registerSandboxToolLoggingSupabaseFactory } from "@airlab/orchestration-runtime/sandbox-logging";

import { createSupabaseAdminClient } from "../supabase-admin";

registerSandboxToolLoggingSupabaseFactory(createSupabaseAdminClient);

export * from "@airlab/orchestration-runtime/sandbox-logging";
