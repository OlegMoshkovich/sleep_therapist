import "../../lib/async-job-policy-runtime";
import "../../lib/tools/dispatch";

import { auth } from "@clerk/nextjs/server";
import {
  createChatPostHandler,
  executeQueuedChatRuntimeOperationJob,
} from "@airlab/orchestration-runtime/chat-route";

import { clerkIdToUUID } from "../../lib/clerk-uuid";
import { createSupabaseAdminClient } from "../../lib/supabase-admin";

export { executeQueuedChatRuntimeOperationJob };

export const POST = createChatPostHandler({
  authenticate: async () => {
    const { userId } = await auth();
    return { userId };
  },
  clerkIdToUUID,
  createSupabaseAdminClient,
});
