export const ASYNC_RUNTIME_JOB_TABLE = "async_runtime_jobs";
export const ASYNC_RUNTIME_JOB_MIGRATION =
  "supabase/migrations/20260607000000_async_runtime_jobs.sql";

export interface AsyncJobRuntimeStoreSupabaseClient {
  from: (table: string) => any;
}

export type AsyncJobRuntimeStoreSupabaseFactory =
  () => AsyncJobRuntimeStoreSupabaseClient;

let supabaseFactory: AsyncJobRuntimeStoreSupabaseFactory | null = null;

export function registerAsyncJobRuntimeStoreSupabaseFactory(
  factory: AsyncJobRuntimeStoreSupabaseFactory | null
): void {
  supabaseFactory = factory;
}

function createAsyncJobRuntimeStoreSupabaseClient(): AsyncJobRuntimeStoreSupabaseClient {
  if (!supabaseFactory) {
    throw new Error(
      "Async job runtime store Supabase factory is not registered."
    );
  }
  return supabaseFactory();
}

export type AsyncRuntimeJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type AsyncRuntimeJobKind = "tool_dispatch" | "runtime_operation";

interface AsyncRuntimeJobRow {
  id: string;
  status: AsyncRuntimeJobStatus;
  job_kind: AsyncRuntimeJobKind;
  input: Record<string, unknown> | null;
  preview: string | null;
  summary: string | null;
  result: unknown;
  error: string | null;
  transport: string | null;
  transport_note: string | null;
  attempt_count: number | null;
  execution_token: string | null;
  lease_expires_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface StoredAsyncRuntimeJobRecord {
  jobId: string;
  status: AsyncRuntimeJobStatus;
  jobKind: AsyncRuntimeJobKind;
  input: Record<string, unknown>;
  preview: string;
  summary: string;
  result?: unknown;
  error?: string;
  transport?: string;
  transportNote?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  attemptCount: number;
  executionToken?: string;
  leaseExpiresAt?: string;
}

const SELECT_COLS = [
  "id",
  "status",
  "job_kind",
  "input",
  "preview",
  "summary",
  "result",
  "error",
  "transport",
  "transport_note",
  "attempt_count",
  "execution_token",
  "lease_expires_at",
  "created_at",
  "updated_at",
  "started_at",
  "finished_at",
].join(", ");

const DEFAULT_JOB_LEASE_MS = 5 * 60_000;
const MAX_JOB_LEASE_MS = 30 * 60_000;
const LEASE_BUFFER_MS = 30_000;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function normalizeInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function coerceJobRow(value: unknown): AsyncRuntimeJobRow {
  return value as AsyncRuntimeJobRow;
}

function mapRow(row: AsyncRuntimeJobRow): StoredAsyncRuntimeJobRecord {
  return {
    jobId: row.id,
    status: row.status,
    jobKind: row.job_kind,
    input: normalizeInput(row.input),
    preview: row.preview ?? "",
    summary: row.summary ?? "",
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    transport: row.transport ?? undefined,
    transportNote: row.transport_note ?? undefined,
    createdAt: row.created_at ?? nowIso(),
    updatedAt: row.updated_at ?? nowIso(),
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    attemptCount: row.attempt_count ?? 0,
    executionToken: row.execution_token ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
  };
}

function formatStoreError(message: string): string {
  if (
    message.includes(ASYNC_RUNTIME_JOB_TABLE) ||
    (message.includes("relation") && message.includes("async_runtime_jobs"))
  ) {
    return (
      "Async runtime job storage is not provisioned yet. Run `" +
      ASYNC_RUNTIME_JOB_MIGRATION +
      "` in Supabase, then retry."
    );
  }
  return message;
}

function storeError(message: string): Error {
  return new Error(formatStoreError(message));
}

function makeExecutionToken(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveJobLeaseMs(timeoutMs: number | undefined): number {
  const requestedTimeout =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.trunc(timeoutMs) + LEASE_BUFFER_MS
      : readPositiveIntegerEnv("AIRLAB_ASYNC_RUNTIME_JOB_LEASE_MS", DEFAULT_JOB_LEASE_MS);
  return Math.min(Math.max(requestedTimeout, DEFAULT_JOB_LEASE_MS), MAX_JOB_LEASE_MS);
}

function resolveLeaseExpiry(timeoutMs: number | undefined): string {
  const now = nowIso();
  return addMs(now, resolveJobLeaseMs(timeoutMs));
}

function isExpired(iso: string | undefined): boolean {
  if (!iso) {
    return true;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) || ms <= Date.now();
}

export function canResumeStoredAsyncRuntimeJob(
  record: StoredAsyncRuntimeJobRecord
): boolean {
  if (record.status === "queued") {
    return true;
  }
  return record.status === "running" && isExpired(record.leaseExpiresAt);
}

export async function createStoredAsyncRuntimeJob(args: {
  jobId: string;
  jobKind: AsyncRuntimeJobKind;
  input: Record<string, unknown>;
  preview: string;
  summary: string;
  timeoutMs?: number;
}): Promise<StoredAsyncRuntimeJobRecord> {
  const supabase = createAsyncJobRuntimeStoreSupabaseClient();
  const now = nowIso();
  const { data, error } = await supabase
    .from(ASYNC_RUNTIME_JOB_TABLE)
    .insert({
      id: args.jobId,
      status: "queued",
      job_kind: args.jobKind,
      input: args.input,
      preview: args.preview,
      summary: args.summary,
      lease_expires_at: resolveLeaseExpiry(args.timeoutMs),
      created_at: now,
      updated_at: now,
    })
    .select(SELECT_COLS)
    .single();

  if (error || !data) {
    throw storeError(error?.message ?? "Failed to create async runtime job.");
  }

  return mapRow(coerceJobRow(data));
}

export async function loadStoredAsyncRuntimeJob(
  jobId: string
): Promise<StoredAsyncRuntimeJobRecord | null> {
  const supabase = createAsyncJobRuntimeStoreSupabaseClient();
  const { data, error } = await supabase
    .from(ASYNC_RUNTIME_JOB_TABLE)
    .select(SELECT_COLS)
    .eq("id", jobId)
    .maybeSingle();

  if (error) {
    throw storeError(error.message);
  }

  return data ? mapRow(coerceJobRow(data)) : null;
}

export async function claimStoredAsyncRuntimeJob(
  record: StoredAsyncRuntimeJobRecord,
  summary: string,
  timeoutMs?: number
): Promise<StoredAsyncRuntimeJobRecord | null> {
  const supabase = createAsyncJobRuntimeStoreSupabaseClient();
  const now = nowIso();
  const { data, error } = await supabase
    .from(ASYNC_RUNTIME_JOB_TABLE)
    .update({
      status: "running",
      summary,
      updated_at: now,
      started_at: record.startedAt ?? now,
      attempt_count: record.attemptCount + 1,
      execution_token: makeExecutionToken(),
      lease_expires_at: resolveLeaseExpiry(timeoutMs),
    })
    .eq("id", record.jobId)
    .eq("updated_at", record.updatedAt)
    .select(SELECT_COLS)
    .maybeSingle();

  if (error) {
    throw storeError(error.message);
  }

  return data ? mapRow(coerceJobRow(data)) : null;
}

export async function finalizeStoredAsyncRuntimeJob(
  record: StoredAsyncRuntimeJobRecord,
  args: {
    status: "completed" | "failed";
    summary: string;
    result?: unknown;
    error?: string;
    transport?: string;
    transportNote?: string;
  }
): Promise<StoredAsyncRuntimeJobRecord | null> {
  const executionToken = record.executionToken?.trim();
  if (!executionToken) {
    throw new Error(
      `Async runtime job "${record.jobId}" cannot be finalized without an execution token.`
    );
  }

  const supabase = createAsyncJobRuntimeStoreSupabaseClient();
  const now = nowIso();
  const { data, error } = await supabase
    .from(ASYNC_RUNTIME_JOB_TABLE)
    .update({
      status: args.status,
      summary: args.summary,
      result: args.result ?? null,
      error: args.error ?? null,
      transport: args.transport ?? null,
      transport_note: args.transportNote ?? null,
      updated_at: now,
      finished_at: now,
      execution_token: null,
      lease_expires_at: null,
    })
    .eq("id", record.jobId)
    .eq("execution_token", executionToken)
    .select(SELECT_COLS)
    .maybeSingle();

  if (error) {
    throw storeError(error.message);
  }

  return data ? mapRow(coerceJobRow(data)) : null;
}
