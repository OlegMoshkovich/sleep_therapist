import {
  registerOrchestrationRunOpenAiModel,
  registerOrchestrationRunToolDispatchExecutor,
} from "@airlab/orchestration-runtime/orchestration-run-runtime";

import { OPENAI_MODEL } from "./openai-config";

registerOrchestrationRunOpenAiModel(OPENAI_MODEL);
registerOrchestrationRunToolDispatchExecutor((config, args, context) =>
  import("./tools/dispatch").then(({ dispatchTool }) =>
    dispatchTool(config, args, context)
  )
);

export * from "@airlab/orchestration-runtime/orchestration-run-runtime";
