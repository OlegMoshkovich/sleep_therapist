import { registerProjectAgentRuntimeSupabaseFactory } from "@airlab/orchestration-runtime/project-agent-runtime-resolver";

import { createSupabaseAdminClient } from "./supabase-admin";

registerProjectAgentRuntimeSupabaseFactory(createSupabaseAdminClient);

export * from "@airlab/orchestration-runtime/project-agent-runtime-resolver";
