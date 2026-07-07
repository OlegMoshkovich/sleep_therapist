import { SEED_SERVERS } from "../../sandbox/seed";
import type { ServerRef } from "./types";
import { resolveRuntimeBaseUrl } from "../runtime-base-url";
import { createServerResolver } from "@airlab/orchestration-runtime/servers";

export type { ResolvedServer } from "@airlab/orchestration-runtime/servers";

export const resolveServer = createServerResolver({
  servers: SEED_SERVERS as Record<string, ServerRef>,
  resolveRuntimeBaseUrl,
});
