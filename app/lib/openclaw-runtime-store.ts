import { configureOpenClawRuntimeStore } from "@airlab/openclaw-runtime";
import { createSupabaseAdminClient } from "./supabase-admin";

configureOpenClawRuntimeStore({ createSupabaseAdminClient });

export {
  OPENCLAW_RUNTIME_JOB_MIGRATION,
  OPENCLAW_RUNTIME_JOB_TABLE,
  canResumeStoredOpenClawJob,
  claimStoredOpenClawJob,
  configureOpenClawRuntimeStore,
  createStoredOpenClawJob,
  finalizeStoredOpenClawJob,
  loadStoredOpenClawJob,
} from "@airlab/openclaw-runtime";
export type {
  OpenClawRuntimeStoreConfig,
  OpenClawRuntimeSupabaseClient,
  RuntimeJobStatus,
  StoredOpenClawJobRecord,
} from "@airlab/openclaw-runtime";
