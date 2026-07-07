import { registerDaemonActionClassifierOpenAiConfig } from "@airlab/orchestration-runtime/general-orchestration-daemon-action-classifier";
import {
  registerDaemonRuntimeOpenAiConfig,
  registerDaemonRuntimeSupabaseFactory,
} from "@airlab/orchestration-runtime/general-orchestration-daemon-runtime";

import {
  DAEMON_ACTION_CLASSIFIER_MAX_COMPLETION_TOKENS,
  DAEMON_OPENING_MESSAGE_MAX_COMPLETION_TOKENS,
  OPENAI_MODEL,
  resolveOptionalOpenAiApiKey,
} from "./openai-config";
import { createSupabaseAdminClient } from "./supabase-admin";

registerDaemonRuntimeSupabaseFactory(createSupabaseAdminClient);
registerDaemonRuntimeOpenAiConfig({
  model: OPENAI_MODEL,
  openingMessageMaxCompletionTokens: DAEMON_OPENING_MESSAGE_MAX_COMPLETION_TOKENS,
  resolveOptionalApiKey: resolveOptionalOpenAiApiKey,
});
registerDaemonActionClassifierOpenAiConfig({
  model: OPENAI_MODEL,
  maxCompletionTokens: DAEMON_ACTION_CLASSIFIER_MAX_COMPLETION_TOKENS,
});

export * from "@airlab/orchestration-runtime/general-orchestration-daemon-runtime";
