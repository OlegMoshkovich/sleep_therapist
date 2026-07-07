import {
  registerAsyncJobToolDispatchExecutor,
  registerChatRuntimeOperationExecutor,
} from "@airlab/orchestration-runtime/async-job-runtime";
import { registerAsyncJobRuntimeStoreSupabaseFactory } from "@airlab/orchestration-runtime/async-job-runtime-store";

import { createSupabaseAdminClient } from "./supabase-admin";

registerAsyncJobRuntimeStoreSupabaseFactory(createSupabaseAdminClient);
registerAsyncJobToolDispatchExecutor((config, args, context) =>
  import("./tools/dispatch").then(({ dispatchTool }) =>
    dispatchTool(config, args, context)
  )
);
registerChatRuntimeOperationExecutor((input) =>
  import("../api/chat/route").then(({ executeQueuedChatRuntimeOperationJob }) =>
    executeQueuedChatRuntimeOperationJob(input)
  )
);

export * from "@airlab/orchestration-runtime/async-job-runtime";
