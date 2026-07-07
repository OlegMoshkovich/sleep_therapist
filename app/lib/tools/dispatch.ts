import { registerAsyncJobRuntimeStoreSupabaseFactory } from "@airlab/orchestration-runtime/async-job-runtime-store";
import { registerDatasetToolSupabaseFactory } from "@airlab/orchestration-runtime/dataset-store";
import {
  registerToolDispatchInProcessMcpHandler,
  registerToolDispatchServerResolver,
} from "@airlab/orchestration-runtime/dispatch";
import { registerSandboxToolLoggingSupabaseFactory } from "@airlab/orchestration-runtime/sandbox-logging";

import { callMemoryTool } from "../memory/handler";
import { createSupabaseAdminClient } from "../supabase-admin";
import { resolveServer } from "./servers";

registerAsyncJobRuntimeStoreSupabaseFactory(createSupabaseAdminClient);
registerDatasetToolSupabaseFactory(createSupabaseAdminClient);
registerSandboxToolLoggingSupabaseFactory(createSupabaseAdminClient);
registerToolDispatchServerResolver(resolveServer);
registerToolDispatchInProcessMcpHandler("memory", callMemoryTool);

export * from "@airlab/orchestration-runtime/dispatch";
