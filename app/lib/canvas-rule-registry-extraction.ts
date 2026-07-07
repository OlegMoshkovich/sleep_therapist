import type OpenAI from "openai";

import { refreshDerivedCanvasRuleRegistryWithConfig } from "@airlab/canvas-rules/canvas-rule-registry-extraction";
import {
  makeOrchestrationId,
  type OrchestrationProject,
} from "./general-orchestration";
import {
  DAEMON_BUILDER_MAX_COMPLETION_TOKENS,
  OPENAI_MODEL,
} from "./openai-config";

export async function refreshDerivedCanvasRuleRegistry(args: {
  openai: OpenAI;
  project: OrchestrationProject;
}): Promise<OrchestrationProject> {
  return refreshDerivedCanvasRuleRegistryWithConfig({
    openai: args.openai,
    project: args.project,
    model: OPENAI_MODEL,
    maxCompletionTokens: DAEMON_BUILDER_MAX_COMPLETION_TOKENS,
    makeId: makeOrchestrationId,
  });
}
