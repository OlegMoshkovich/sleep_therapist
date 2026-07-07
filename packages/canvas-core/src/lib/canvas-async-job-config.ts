export type CanvasAsyncExecutionMode = "sync" | "async";
export type CanvasAsyncContinuationPolicy =
  | "await_now"
  | "fork_continue"
  | "fork_yield"
  | "detach";

export const ASYNC_JOB_RUNTIME_OPERATIONS = [
  "read_async_job",
  "await_async_job",
] as const;

export const SYNC_ONLY_RUNTIME_OPERATIONS = [
  "read_async_job",
  "await_async_job",
  "apply_structured_patch",
  "raise_error",
] as const;

export type AsyncJobRuntimeOperationName =
  (typeof ASYNC_JOB_RUNTIME_OPERATIONS)[number];

function readNodeData(
  value: unknown
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isAsyncJobRuntimeOperation(
  value: string
): value is AsyncJobRuntimeOperationName {
  return value === "read_async_job" || value === "await_async_job";
}

export function canRuntimeOperationQueueAsAsync(
  value: string
): boolean {
  return !SYNC_ONLY_RUNTIME_OPERATIONS.includes(
    value as (typeof SYNC_ONLY_RUNTIME_OPERATIONS)[number]
  );
}

export function getAsyncRuntimeOperationResultVariableFallback(
  value: string
): string {
  const normalized = value.trim();
  return normalized ? `${normalized}_job` : "async_job";
}

export function readCanvasAsyncExecutionMode(
  value: unknown
): CanvasAsyncExecutionMode {
  const data = readNodeData(value);
  return data?.executionMode === "async" ? "async" : "sync";
}

export function normalizeCanvasAsyncContinuationPolicy(
  value: unknown,
  fallback: CanvasAsyncContinuationPolicy = "fork_continue"
): CanvasAsyncContinuationPolicy {
  return value === "await_now" ||
    value === "fork_continue" ||
    value === "fork_yield" ||
    value === "detach"
    ? value
    : fallback;
}

export function readCanvasAsyncContinuationPolicy(
  value: unknown,
  fallback: CanvasAsyncContinuationPolicy = "fork_continue"
): CanvasAsyncContinuationPolicy {
  const data = readNodeData(value);
  return normalizeCanvasAsyncContinuationPolicy(
    data?.asyncContinuationPolicy,
    fallback
  );
}

export function isAttachedAsyncContinuationPolicy(
  policy: CanvasAsyncContinuationPolicy
): boolean {
  return policy !== "detach";
}

export function shouldYieldForAsyncContinuationPolicy(
  policy: CanvasAsyncContinuationPolicy
): boolean {
  return policy === "fork_yield";
}

export function readAsyncJobSourceVariable(
  value: unknown
): string {
  const data = readNodeData(value);
  return typeof data?.jobSourceVariable === "string"
    ? data.jobSourceVariable.trim()
    : "";
}

export function readAsyncJobResultVariable(
  value: unknown,
  fallback = "async_job"
): string {
  const data = readNodeData(value);
  const explicit =
    typeof data?.resultVariable === "string" ? data.resultVariable.trim() : "";
  return explicit || fallback;
}

export function readAsyncJobTimeoutMs(value: unknown): number | undefined {
  const data = readNodeData(value);
  const raw = data?.timeoutMs;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.trunc(raw)
    : undefined;
}

export function readAsyncJobPollIntervalMs(value: unknown): number | undefined {
  const data = readNodeData(value);
  const raw = data?.pollIntervalMs;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.trunc(raw)
    : undefined;
}

export interface AsyncJobDeclaredOutputField {
  name: string;
  type: string;
  origin: string;
}

export function describeAsyncJobDeclaredOutputFields(
  baseName: string,
  origin = "async job"
): AsyncJobDeclaredOutputField[] {
  const base = baseName.trim() || "async_job";
  return [
    {
      name: base,
      type: "json",
      origin,
    },
    {
      name: `${base}_job_id`,
      type: "string",
      origin,
    },
    {
      name: `${base}_status`,
      type: "string",
      origin,
    },
    {
      name: `${base}_completed`,
      type: "boolean",
      origin,
    },
    {
      name: `${base}_failed`,
      type: "boolean",
      origin,
    },
    {
      name: `${base}_active`,
      type: "boolean",
      origin,
    },
    {
      name: `${base}_attached`,
      type: "boolean",
      origin,
    },
    {
      name: `${base}_detached`,
      type: "boolean",
      origin,
    },
    {
      name: `${base}_continuation_policy`,
      type: "string",
      origin,
    },
    {
      name: `${base}_should_yield`,
      type: "boolean",
      origin,
    },
    {
      name: `${base}_summary`,
      type: "string",
      origin,
    },
    {
      name: `${base}_preview`,
      type: "string",
      origin,
    },
    {
      name: `${base}_result`,
      type: "json",
      origin,
    },
    {
      name: `${base}_error`,
      type: "string",
      origin,
    },
  ];
}
