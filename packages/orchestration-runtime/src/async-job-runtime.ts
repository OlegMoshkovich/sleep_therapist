import type {
  PolicyRuntimeOperationExecutionStep,
  PromptValueSnapshot,
  StateSnapshot,
} from "@airlab/canvas-planner/canvas-hybrid-runtime";
import {
  isAttachedAsyncContinuationPolicy,
  normalizeCanvasAsyncContinuationPolicy,
  shouldYieldForAsyncContinuationPolicy,
  type CanvasAsyncContinuationPolicy,
} from "@airlab/canvas-core/lib/canvas-async-job-config";
import type {
  ToolDispatchConfig,
  ToolDispatchContext,
  ToolDispatchResult,
} from "@airlab/canvas-compiler/tool-types";
import {
  canResumeStoredAsyncRuntimeJob,
  claimStoredAsyncRuntimeJob,
  createStoredAsyncRuntimeJob,
  finalizeStoredAsyncRuntimeJob,
  loadStoredAsyncRuntimeJob,
  type AsyncRuntimeJobKind,
  type StoredAsyncRuntimeJobRecord,
} from "./async-job-runtime-store";

const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_POLL_TIMEOUT_MS = 20_000;
const MAX_POLL_TIMEOUT_MS = 120_000;

export interface AsyncToolDispatchJobInput extends Record<string, unknown> {
  kind: "tool_dispatch";
  config: ToolDispatchConfig;
  args: Record<string, unknown>;
  context: SerializableToolDispatchContext;
  timeoutMs?: number;
  continuationPolicy?: CanvasAsyncContinuationPolicy;
}

export interface SerializableToolDispatchContext {
  configId?: string;
  canvasId?: string;
  conversationId?: string;
  toolName: string;
  setupTable?: string;
  setupId?: string;
  /** Scopes dataset tools to an environment agent's datasets. */
  environmentPlayerId?: string;
}

export interface AsyncDaemonRuntimeOperationJobInput
  extends Record<string, unknown> {
  kind: "daemon_runtime_operation";
  step: PolicyRuntimeOperationExecutionStep;
  incomingOutput: string;
  promptValues: PromptValueSnapshot;
  currentState: StateSnapshot;
  workflowProject: unknown;
  messages: unknown[];
  runtimeConfig: unknown;
  canonicalCurrentBuild?: unknown;
  parsedPlan?: unknown;
  patchResult?: unknown;
  workflowAppliedChanges?: string[];
  finalizedAssistantMessage?: string | null;
}

export interface AsyncChatRuntimeOperationJobInput
  extends Record<string, unknown> {
  kind: "chat_runtime_operation";
  step: PolicyRuntimeOperationExecutionStep;
  incomingOutput: string;
  promptValues: PromptValueSnapshot;
  currentState: StateSnapshot;
  stateSchema: unknown[];
}

export type AsyncRuntimeOperationJobInput =
  | AsyncDaemonRuntimeOperationJobInput
  | AsyncChatRuntimeOperationJobInput;

export interface AsyncRuntimeOperationCompletionPayload
  extends Record<string, unknown> {
  kind: "airlab_runtime_operation_result";
  runtime: "daemon" | "chat";
  operation: string;
  output: string;
  promptValues?: PromptValueSnapshot | null;
  contextSnapshot?: Record<string, unknown> | null;
}

export type DaemonRuntimeOperationExecutor = (
  input: AsyncDaemonRuntimeOperationJobInput
) => Promise<AsyncRuntimeOperationCompletionPayload>;

export type ChatRuntimeOperationExecutor = (
  input: AsyncChatRuntimeOperationJobInput
) => Promise<AsyncRuntimeOperationCompletionPayload>;

export type AsyncJobToolDispatchExecutor = (
  config: ToolDispatchConfig,
  args: Record<string, unknown>,
  context: ToolDispatchContext
) => Promise<ToolDispatchResult>;

let daemonRuntimeOperationExecutor: DaemonRuntimeOperationExecutor | null = null;
let chatRuntimeOperationExecutor: ChatRuntimeOperationExecutor | null = null;
let toolDispatchExecutor: AsyncJobToolDispatchExecutor | null = null;

export function registerAsyncJobToolDispatchExecutor(
  executor: AsyncJobToolDispatchExecutor | null
): void {
  toolDispatchExecutor = executor;
}

export function registerChatRuntimeOperationExecutor(
  executor: ChatRuntimeOperationExecutor | null
): void {
  chatRuntimeOperationExecutor = executor;
}

export function registerDaemonRuntimeOperationExecutor(
  executor: DaemonRuntimeOperationExecutor | null
): void {
  daemonRuntimeOperationExecutor = executor;
}

export type AsyncRuntimeJobInput =
  | AsyncToolDispatchJobInput
  | AsyncRuntimeOperationJobInput;

export interface AsyncRuntimeJobQueuedResult extends Record<string, unknown> {
  kind: "airlab_async_job";
  status: "queued" | "running";
  jobId: string;
  jobKind: AsyncRuntimeJobKind;
  continuationPolicy?: CanvasAsyncContinuationPolicy;
  preview?: string;
  summary?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AsyncRuntimeJobCompletedResult extends Record<string, unknown> {
  kind: "airlab_async_job";
  status: "completed";
  jobId: string;
  jobKind: AsyncRuntimeJobKind;
  continuationPolicy?: CanvasAsyncContinuationPolicy;
  result?: unknown;
  summary?: string;
  preview?: string;
  transport?: string;
  transportNote?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AsyncRuntimeJobFailedResult extends Record<string, unknown> {
  kind: "airlab_async_job";
  status: "failed";
  jobId: string;
  jobKind: AsyncRuntimeJobKind;
  continuationPolicy?: CanvasAsyncContinuationPolicy;
  error: string;
  summary?: string;
  preview?: string;
  transport?: string;
  transportNote?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export type AsyncRuntimeJobResult =
  | AsyncRuntimeJobQueuedResult
  | AsyncRuntimeJobCompletedResult
  | AsyncRuntimeJobFailedResult;

export interface AsyncRuntimeJobPollUpdate extends AsyncRuntimeJobQueuedResult {
  jobId: string;
  pollCount: number;
}

export interface AwaitAsyncRuntimeJobOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  onStatus?: (update: AsyncRuntimeJobPollUpdate) => void | Promise<void>;
}

function readPositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePollIntervalMs(): number {
  return readPositiveInteger(
    process.env.AIRLAB_ASYNC_RUNTIME_POLL_INTERVAL_MS?.trim(),
    DEFAULT_POLL_INTERVAL_MS
  );
}

function resolvePollTimeoutMs(requested: number | undefined): number {
  const value =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.trunc(requested)
      : readPositiveInteger(
          process.env.AIRLAB_ASYNC_RUNTIME_POLL_TIMEOUT_MS?.trim(),
          DEFAULT_POLL_TIMEOUT_MS
        );
  return Math.min(value, MAX_POLL_TIMEOUT_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateText(value: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

function previewArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const rendered =
      typeof value === "string" ? JSON.stringify(truncateText(value, 40)) : JSON.stringify(value);
    parts.push(`${key}=${rendered}`);
    if (parts.join(", ").length > 120) {
      break;
    }
  }
  return parts.join(", ");
}

function makeJobId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `async-job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeToolDispatchContext(
  context: ToolDispatchContext | SerializableToolDispatchContext | undefined
): SerializableToolDispatchContext {
  return {
    configId:
      typeof context?.configId === "string" && context.configId.trim()
        ? context.configId.trim()
        : undefined,
    canvasId:
      typeof context?.canvasId === "string" && context.canvasId.trim()
        ? context.canvasId.trim()
        : undefined,
    conversationId:
      typeof context?.conversationId === "string" && context.conversationId.trim()
        ? context.conversationId.trim()
        : undefined,
    toolName:
      typeof context?.toolName === "string" && context.toolName.trim()
        ? context.toolName.trim()
        : "tool_call",
    setupTable:
      typeof context?.setupTable === "string" && context.setupTable.trim()
        ? context.setupTable.trim()
        : undefined,
    setupId:
      typeof context?.setupId === "string" && context.setupId.trim()
        ? context.setupId.trim()
        : undefined,
    environmentPlayerId:
      typeof context?.environmentPlayerId === "string" &&
      context.environmentPlayerId.trim()
        ? context.environmentPlayerId.trim()
        : undefined,
  };
}

function buildToolPreview(
  input: AsyncToolDispatchJobInput
): string {
  const argsPreview = previewArgs(input.args);
  return argsPreview
    ? `${input.context.toolName}(${argsPreview})`
    : `${input.context.toolName}()`;
}

function buildRuntimeOperationPreview(
  input: AsyncRuntimeOperationJobInput
): string {
  return input.step.operation.trim();
}

function buildQueuedSummary(input: AsyncRuntimeJobInput): string {
  if (input.kind === "tool_dispatch") {
    return `Queued async tool job for ${input.context.toolName}.`;
  }
  if (
    input.kind === "daemon_runtime_operation" ||
    input.kind === "chat_runtime_operation"
  ) {
    return `Queued async runtime operation "${input.step.operation}".`;
  }
  return "Queued async job.";
}

function buildRunningSummary(input: AsyncRuntimeJobInput): string {
  if (input.kind === "tool_dispatch") {
    return `Running async tool job for ${input.context.toolName}.`;
  }
  if (
    input.kind === "daemon_runtime_operation" ||
    input.kind === "chat_runtime_operation"
  ) {
    return `Running async runtime operation "${input.step.operation}".`;
  }
  return "Running async job.";
}

function parseAsyncRuntimeJobInput(value: Record<string, unknown>): AsyncRuntimeJobInput {
  return value as unknown as AsyncRuntimeJobInput;
}

function readStoredJobContinuationPolicy(
  record: StoredAsyncRuntimeJobRecord
): CanvasAsyncContinuationPolicy | undefined {
  const input = parseAsyncRuntimeJobInput(record.input);
  if (input.kind !== "tool_dispatch") {
    return undefined;
  }
  return normalizeCanvasAsyncContinuationPolicy(input.continuationPolicy);
}

function formatJob(record: StoredAsyncRuntimeJobRecord): AsyncRuntimeJobResult {
  const base = {
    kind: "airlab_async_job" as const,
    jobId: record.jobId,
    jobKind: record.jobKind,
    continuationPolicy: readStoredJobContinuationPolicy(record),
    preview: record.preview,
    summary: record.summary,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };

  if (record.status === "queued" || record.status === "running") {
    return {
      ...base,
      status: record.status,
    };
  }

  if (record.status === "completed") {
    return {
      ...base,
      status: "completed",
      result: record.result,
      transport: record.transport,
      transportNote: record.transportNote,
    };
  }

  return {
    ...base,
    status: "failed",
    error: record.error || "Async runtime job failed.",
    transport: record.transport,
    transportNote: record.transportNote,
  };
}

export function isAsyncRuntimeJobInProgress(
  value: unknown
): value is AsyncRuntimeJobQueuedResult {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "airlab_async_job" &&
    (((value as { status?: unknown }).status === "queued") ||
      ((value as { status?: unknown }).status === "running"))
  );
}

export function isAsyncRuntimeJobResult(
  value: unknown
): value is AsyncRuntimeJobResult {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "airlab_async_job"
  );
}

export function isAsyncRuntimeOperationCompletionPayload(
  value: unknown
): value is AsyncRuntimeOperationCompletionPayload {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "airlab_runtime_operation_result" &&
    typeof (value as { runtime?: unknown }).runtime === "string" &&
    typeof (value as { operation?: unknown }).operation === "string" &&
    typeof (value as { output?: unknown }).output === "string"
  );
}

export function extractAsyncRuntimeJobId(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const direct =
    typeof (value as { jobId?: unknown }).jobId === "string"
      ? (value as { jobId: string }).jobId.trim()
      : "";
  if (direct) {
    return direct;
  }
  const nestedValue = (value as { value?: unknown }).value;
  if (nestedValue && typeof nestedValue === "object" && !Array.isArray(nestedValue)) {
    const nested =
      typeof (nestedValue as { jobId?: unknown }).jobId === "string"
        ? (nestedValue as { jobId: string }).jobId.trim()
        : "";
    if (nested) {
      return nested;
    }
  }
  return "";
}

export function buildAsyncRuntimeJobPromptValueUpdates(
  baseName: string,
  result: AsyncRuntimeJobResult,
  continuationPolicy?: CanvasAsyncContinuationPolicy
): Record<string, unknown> {
  const base = baseName.trim() || "async_job";
  const status = result.status;
  const completed = status === "completed";
  const failed = status === "failed";
  const policy = normalizeCanvasAsyncContinuationPolicy(
    continuationPolicy ?? result.continuationPolicy
  );
  const attached = isAttachedAsyncContinuationPolicy(policy);
  const shouldYield = shouldYieldForAsyncContinuationPolicy(policy);
  const active = attached && !completed && !failed;

  return {
    [base]: result,
    [`${base}_job_id`]: result.jobId,
    [`${base}_status`]: status,
    [`${base}_completed`]: completed,
    [`${base}_failed`]: failed,
    [`${base}_active`]: active,
    [`${base}_attached`]: attached,
    [`${base}_detached`]: !attached,
    [`${base}_continuation_policy`]: policy,
    [`${base}_should_yield`]: shouldYield && active,
    [`${base}_summary`]: result.summary ?? "",
    [`${base}_preview`]: result.preview ?? "",
    [`${base}_result`]: completed && "result" in result ? result.result ?? null : null,
    [`${base}_error`]: failed && "error" in result ? result.error : "",
  };
}

async function runToolDispatchJob(
  input: AsyncToolDispatchJobInput
): Promise<{
  status: "completed" | "failed";
  summary: string;
  result?: unknown;
  error?: string;
  transport?: string;
  transportNote?: string;
}> {
  if (!toolDispatchExecutor) {
    const error = `No async tool dispatch executor is registered for "${input.context.toolName}".`;
    return {
      status: "failed",
      summary: error,
      error,
      transport: "internal",
      transportNote: "Async tool dispatch execution is unavailable in this app.",
    };
  }

  const result = await toolDispatchExecutor(input.config, input.args, {
    ...input.context,
    awaitOpenClawCompletion: true,
    disableAsyncJobQueue: true,
  });

  if (!result.ok) {
    return {
      status: "failed",
      summary: truncateText(
        result.error ?? `Async tool job ${input.context.toolName} failed.`,
        160
      ) || `Async tool job ${input.context.toolName} failed.`,
      error: result.error ?? `Async tool job ${input.context.toolName} failed.`,
      transport: result.transport,
      transportNote: result.transportNote,
    };
  }

  return {
    status: "completed",
    summary:
      truncateText(
        typeof result.transportNote === "string" ? result.transportNote : "",
        160
      ) || `Completed async tool job for ${input.context.toolName}.`,
    result: result.data ?? null,
    transport: result.transport,
    transportNote: result.transportNote,
  };
}

async function runDaemonRuntimeOperationJob(
  input: AsyncDaemonRuntimeOperationJobInput
): Promise<{
  status: "completed" | "failed";
  summary: string;
  result?: unknown;
  error?: string;
  transport?: string;
  transportNote?: string;
}> {
  if (!daemonRuntimeOperationExecutor) {
    const error = `No daemon runtime operation executor is registered for "${input.step.operation}".`;
    return {
      status: "failed",
      summary: error,
      error,
      transport: "internal",
      transportNote: "Daemon runtime operation execution is unavailable in this app.",
    };
  }

  const result = await daemonRuntimeOperationExecutor(input);
  return {
    status: "completed",
    summary: `Completed async runtime operation "${input.step.operation}".`,
    result,
    transport: "internal",
    transportNote: `Queued daemon runtime operation "${input.step.operation}" completed.`,
  };
}

async function runChatRuntimeOperationJob(
  input: AsyncChatRuntimeOperationJobInput
): Promise<{
  status: "completed" | "failed";
  summary: string;
  result?: unknown;
  error?: string;
  transport?: string;
  transportNote?: string;
}> {
  if (!chatRuntimeOperationExecutor) {
    const error = `No chat runtime operation executor is registered for "${input.step.operation}".`;
    return {
      status: "failed",
      summary: error,
      error,
      transport: "internal",
      transportNote: "Chat runtime operation execution is unavailable in this app.",
    };
  }

  const result = await chatRuntimeOperationExecutor(input);
  return {
    status: "completed",
    summary: `Completed async runtime operation "${input.step.operation}".`,
    result,
    transport: "internal",
    transportNote: `Queued chat runtime operation "${input.step.operation}" completed.`,
  };
}

async function executeAsyncRuntimeJob(
  input: AsyncRuntimeJobInput
): Promise<{
  status: "completed" | "failed";
  summary: string;
  result?: unknown;
  error?: string;
  transport?: string;
  transportNote?: string;
}> {
  if (input.kind === "tool_dispatch") {
    return runToolDispatchJob(input);
  }

  if (input.kind === "daemon_runtime_operation") {
    return runDaemonRuntimeOperationJob(input);
  }

  if (input.kind === "chat_runtime_operation") {
    return runChatRuntimeOperationJob(input);
  }

  return {
    status: "failed",
    summary: "Unsupported async runtime job type.",
    error: "Unsupported async runtime job type.",
  };
}

async function continueStoredAsyncRuntimeJob(
  record: StoredAsyncRuntimeJobRecord
): Promise<void> {
  const input = parseAsyncRuntimeJobInput(record.input);
  let terminal: {
    status: "completed" | "failed";
    summary: string;
    result?: unknown;
    error?: string;
    transport?: string;
    transportNote?: string;
  };

  try {
    terminal = await executeAsyncRuntimeJob(input);
  } catch (error) {
    terminal = {
      status: "failed",
      summary: "Async runtime job crashed while executing.",
      error:
        error instanceof Error
          ? error.message
          : "Unknown async runtime job execution error.",
    };
  }

  try {
    await finalizeStoredAsyncRuntimeJob(record, terminal);
  } catch (error) {
    console.error(
      "[async-job-runtime] failed to finalize async runtime job:",
      error instanceof Error ? error.message : error
    );
  }
}

function scheduleStoredAsyncRuntimeJob(record: StoredAsyncRuntimeJobRecord) {
  setTimeout(() => {
    void continueStoredAsyncRuntimeJob(record);
  }, 0);
}

async function maybeStartStoredAsyncRuntimeJob(
  record: StoredAsyncRuntimeJobRecord,
  timeoutMs?: number
): Promise<StoredAsyncRuntimeJobRecord> {
  if (!canResumeStoredAsyncRuntimeJob(record)) {
    return record;
  }

  const input = parseAsyncRuntimeJobInput(record.input);
  const claimed = await claimStoredAsyncRuntimeJob(
    record,
    buildRunningSummary(input),
    timeoutMs
  );
  if (!claimed) {
    return (await loadStoredAsyncRuntimeJob(record.jobId)) ?? record;
  }

  scheduleStoredAsyncRuntimeJob(claimed);
  return claimed;
}

export async function queueToolDispatchJob(args: {
  config: ToolDispatchConfig;
  dispatchArgs: Record<string, unknown>;
  context: ToolDispatchContext | SerializableToolDispatchContext | undefined;
  timeoutMs?: number;
  continuationPolicy?: CanvasAsyncContinuationPolicy;
}): Promise<AsyncRuntimeJobQueuedResult> {
  const input: AsyncToolDispatchJobInput = {
    kind: "tool_dispatch",
    config: args.config,
    args: args.dispatchArgs,
    context: normalizeToolDispatchContext(args.context),
    timeoutMs: args.timeoutMs,
    continuationPolicy: args.continuationPolicy,
  };

  const record = await createStoredAsyncRuntimeJob({
    jobId: makeJobId(),
    jobKind: "tool_dispatch",
    input,
    preview: buildToolPreview(input),
    summary: buildQueuedSummary(input),
    timeoutMs: args.timeoutMs,
  });

  void maybeStartStoredAsyncRuntimeJob(record, args.timeoutMs).catch((error) => {
    console.error(
      "[async-job-runtime] failed to start async runtime job:",
      error instanceof Error ? error.message : error
    );
  });

  return formatJob(record) as AsyncRuntimeJobQueuedResult;
}

export async function queueRuntimeOperationJob(args: {
  input: AsyncRuntimeOperationJobInput;
  timeoutMs?: number;
}): Promise<AsyncRuntimeJobQueuedResult> {
  const record = await createStoredAsyncRuntimeJob({
    jobId: makeJobId(),
    jobKind: "runtime_operation",
    input: args.input,
    preview: buildRuntimeOperationPreview(args.input),
    summary: buildQueuedSummary(args.input),
    timeoutMs: args.timeoutMs,
  });

  void maybeStartStoredAsyncRuntimeJob(record, args.timeoutMs).catch((error) => {
    console.error(
      "[async-job-runtime] failed to start async runtime job:",
      error instanceof Error ? error.message : error
    );
  });

  return formatJob(record) as AsyncRuntimeJobQueuedResult;
}

export async function getAsyncRuntimeJob(
  jobId: string
): Promise<AsyncRuntimeJobResult | null> {
  const record = await loadStoredAsyncRuntimeJob(jobId);
  if (!record) {
    return null;
  }

  const timeoutMsRaw = record.input.timeoutMs;
  const timeoutMs =
    typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.trunc(timeoutMsRaw)
      : undefined;
  const active = await maybeStartStoredAsyncRuntimeJob(record, timeoutMs);
  return formatJob(active);
}

export async function awaitAsyncRuntimeJobCompletion(
  jobId: string,
  options: AwaitAsyncRuntimeJobOptions = {}
): Promise<AsyncRuntimeJobResult> {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) {
    return {
      kind: "airlab_async_job",
      status: "failed",
      jobId: "",
      jobKind: "tool_dispatch",
      error: "Missing async job id.",
      summary: "No async job id was provided.",
    };
  }

  const pollIntervalMs =
    typeof options.pollIntervalMs === "number" &&
    Number.isFinite(options.pollIntervalMs) &&
    options.pollIntervalMs > 0
      ? Math.trunc(options.pollIntervalMs)
      : resolvePollIntervalMs();
  const timeoutMs = resolvePollTimeoutMs(options.timeoutMs);
  const startedAt = Date.now();
  let pollCount = 0;
  let lastFingerprint = "";
  let latest = await getAsyncRuntimeJob(normalizedJobId);

  if (!latest) {
    return {
      kind: "airlab_async_job",
      status: "failed",
      jobId: normalizedJobId,
      jobKind: "tool_dispatch",
      error: `Async runtime job "${normalizedJobId}" was not found.`,
      summary: "No async runtime job is stored under that id.",
    };
  }

  const emitStatus = async (result: AsyncRuntimeJobQueuedResult, nextPollCount: number) => {
    if (!options.onStatus) {
      return;
    }
    const update: AsyncRuntimeJobPollUpdate = {
      ...result,
      pollCount: nextPollCount,
      jobId: normalizedJobId,
    };
    const fingerprint = JSON.stringify([
      update.status,
      update.summary ?? "",
      update.preview ?? "",
    ]);
    if (fingerprint === lastFingerprint) {
      return;
    }
    lastFingerprint = fingerprint;
    await options.onStatus(update);
  };

  if (isAsyncRuntimeJobInProgress(latest)) {
    await emitStatus(latest, 0);
  } else {
    return latest;
  }

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs);
    pollCount += 1;
    latest = await getAsyncRuntimeJob(normalizedJobId);
    if (!latest) {
      return {
        kind: "airlab_async_job",
        status: "failed",
        jobId: normalizedJobId,
        jobKind: "tool_dispatch",
        error: `Async runtime job "${normalizedJobId}" disappeared while polling.`,
        summary: "Async runtime job was not found during polling.",
      };
    }
    if (isAsyncRuntimeJobInProgress(latest)) {
      await emitStatus(latest, pollCount);
      continue;
    }
    return latest;
  }

  return {
    kind: "airlab_async_job",
    status: "failed",
    jobId: normalizedJobId,
    jobKind: latest.jobKind,
    error: `Async runtime job "${normalizedJobId}" did not complete within ${timeoutMs} ms.`,
    summary:
      latest.summary ??
      `Last known async runtime job status: ${latest.status}.`,
    preview: latest.preview,
    createdAt: latest.createdAt,
    updatedAt: latest.updatedAt,
    startedAt: latest.startedAt,
    finishedAt: latest.finishedAt,
  };
}
