import { registerAgentTemplateCatalogSupabaseFactory } from "@airlab/orchestration-core/agent-template-catalog";

import { createSupabaseAdminClient } from "./supabase-admin";

registerAgentTemplateCatalogSupabaseFactory(createSupabaseAdminClient);

export * from "@airlab/orchestration-core/agent-template-catalog";
