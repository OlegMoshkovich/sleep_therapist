import { registerDaemonActionClassifierOpenAiConfig } from "@airlab/orchestration-runtime/general-orchestration-daemon-action-classifier";

import {
  DAEMON_ACTION_CLASSIFIER_MAX_COMPLETION_TOKENS,
  OPENAI_MODEL,
} from "./openai-config";

registerDaemonActionClassifierOpenAiConfig({
  model: OPENAI_MODEL,
  maxCompletionTokens: DAEMON_ACTION_CLASSIFIER_MAX_COMPLETION_TOKENS,
});

export * from "@airlab/orchestration-runtime/general-orchestration-daemon-action-classifier";
