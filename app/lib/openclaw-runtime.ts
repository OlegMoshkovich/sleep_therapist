import { configureOpenClawRuntimeStore } from "@airlab/openclaw-runtime";
import { createSupabaseAdminClient } from "./supabase-admin";

configureOpenClawRuntimeStore({ createSupabaseAdminClient });

export {
  DEFAULT_OPENCLAW_RUNTIME_TASKS_PATH,
  configureOpenClawRuntimeStore,
  delegatedTaskSchema,
  executeDelegatedTaskSync,
  getDelegatedTaskJob,
  getRuntimeBearerToken,
  queueDelegatedTask,
} from "@airlab/openclaw-runtime";
export type {
  ParsedDelegatedTaskInput,
  StoredOpenClawJobRecord,
} from "@airlab/openclaw-runtime";
