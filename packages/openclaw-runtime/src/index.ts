import { z } from "zod";

export type DelegatedTaskMode = "sync" | "async";
export type DelegatedTaskResponseFormat = "text" | "json";
export const DEFAULT_OPENCLAW_BRIDGE_PATH = "/api/openclaw/tasks";
export const DEFAULT_OPENCLAW_RUNTIME_TASKS_PATH = "/api/openclaw/runtime/tasks";

export interface DelegatedTaskInput extends Record<string, unknown> {
  task?: string;
  goal?: string;
  context?: string;
  mode?: DelegatedTaskMode;
  allowedSkills?: string[];
  allowedTools?: string[];
  timeoutMs?: number;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  responseFormat?: DelegatedTaskResponseFormat;
}

export interface DelegatedTaskQueuedResult extends Record<string, unknown> {
  status: "queued" | "running";
  jobId?: string;
  preview?: string;
  summary?: string;
}

export interface DelegatedTaskPollUpdate extends DelegatedTaskQueuedResult {
  jobId: string;
  pollCount: number;
}

export interface DelegatedTaskCompletedResult extends Record<string, unknown> {
  status: "completed";
  answer?: string;
  output?: string;
  artifacts?: Record<string, unknown>;
  trace?: string[];
  summary?: string;
}

export interface DelegatedTaskFailedResult extends Record<string, unknown> {
  status: "failed";
  error: string;
  summary?: string;
}

export type DelegatedTaskResult =
  | DelegatedTaskQueuedResult
  | DelegatedTaskCompletedResult
  | DelegatedTaskFailedResult;

export interface AgentBackend {
  runTask(input: DelegatedTaskInput): Promise<DelegatedTaskResult>;
}

export interface OpenClawDispatchConfig {
  agentId?: string;
  mode?: DelegatedTaskMode;
  /**
   * Bearer token or "env:VAR_NAME" reference resolved server-side.
   */
  bearerToken?: string;
  responseFormat?: DelegatedTaskResponseFormat;
}

export interface ToolDispatchContext {
  configId?: string;
  canvasId?: string;
  conversationId?: string;
  setupId?: string;
}

export type ToolTransport = "mcp" | "rest" | "internal" | "openclaw";

export interface ToolDispatchResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  transport?: ToolTransport;
  transportNote?: string;
}

export function resolveRuntimeBaseUrl(): string | null {
  const explicitBaseUrl =
    process.env.AIRLAB_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicitBaseUrl) {
    const normalizedBaseUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(explicitBaseUrl)
      ? explicitBaseUrl
      : `https://${explicitBaseUrl}`;
    try {
      return new URL(normalizedBaseUrl).toString();
    } catch {
      return explicitBaseUrl;
    }
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) {
    return `https://${vercelUrl.replace(/^https?:\/\//, "")}`;
  }

  const port = process.env.PORT?.trim();
  if (port) {
    return `http://127.0.0.1:${port}`;
  }

  return process.env.NODE_ENV === "production" ? null : "http://127.0.0.1:3000";
}

const MAX_RESPONSE_BYTES = 64_000;
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_POLL_TIMEOUT_MS = 20_000;
const MAX_POLL_TIMEOUT_MS = 120_000;

function resolveConfigValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("env:")) {
    const fromEnv = process.env[trimmed.slice(4)]?.trim();
    return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
  }

  return trimmed;
}

function resolveEndpoint(rawEndpoint: string): string {
  const trimmed = rawEndpoint.trim();
  if (!trimmed) {
    return trimmed;
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    // Relative internal routes are supported below.
  }

  if (trimmed.startsWith("/")) {
    const baseUrl = resolveRuntimeBaseUrl();
    if (!baseUrl) {
      throw new Error(
        `OpenClaw endpoint "${trimmed}" is relative and no runtime base URL is configured. ` +
          "Set AIRLAB_BASE_URL or use an absolute URL."
      );
    }
    return new URL(trimmed, baseUrl).toString();
  }

  return trimmed;
}

function buildTaskPayload(
  defaults: OpenClawDispatchConfig | undefined,
  args: Record<string, unknown>,
  context?: ToolDispatchContext
): DelegatedTaskInput {
  const payload: DelegatedTaskInput = { ...args };

  if (defaults?.agentId && payload.agentId === undefined) {
    payload.agentId = defaults.agentId;
  }

  if (defaults?.mode && payload.mode === undefined) {
    payload.mode = defaults.mode;
  }

  if (defaults?.responseFormat && payload.responseFormat === undefined) {
    payload.responseFormat = defaults.responseFormat;
  }

  if (!hasExplicitSessionTarget(payload)) {
    const derivedSessionKey = deriveSessionKey(payload, context);
    if (derivedSessionKey) {
      payload.sessionKey = derivedSessionKey;
    }
  }

  return payload;
}

function normalizeSessionKeySegment(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function hasExplicitSessionTarget(payload: DelegatedTaskInput): boolean {
  const sessionId =
    typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
  const sessionKey =
    typeof payload.sessionKey === "string" ? payload.sessionKey.trim() : "";
  return sessionId.length > 0 || sessionKey.length > 0;
}

function deriveSessionScope(context: ToolDispatchContext | undefined): string | null {
  const conversationId =
    typeof context?.conversationId === "string" ? context.conversationId.trim() : "";
  if (conversationId) {
    return `conversation-${normalizeSessionKeySegment(conversationId, "conversation")}`;
  }

  const canvasId = typeof context?.canvasId === "string" ? context.canvasId.trim() : "";
  if (canvasId) {
    return `canvas-${normalizeSessionKeySegment(canvasId, "canvas")}`;
  }

  const setupId = typeof context?.setupId === "string" ? context.setupId.trim() : "";
  if (setupId) {
    return `setup-${normalizeSessionKeySegment(setupId, "setup")}`;
  }

  const configId = typeof context?.configId === "string" ? context.configId.trim() : "";
  if (configId) {
    return `config-${normalizeSessionKeySegment(configId, "config")}`;
  }

  return null;
}

function deriveSessionKey(
  payload: DelegatedTaskInput,
  context: ToolDispatchContext | undefined
): string | undefined {
  const scope = deriveSessionScope(context);
  if (!scope) {
    return undefined;
  }

  const agentId =
    typeof payload.agentId === "string" && payload.agentId.trim().length > 0
      ? payload.agentId
      : "main";
  const agentSegment = normalizeSessionKeySegment(agentId, "main");
  return `airlab-${agentSegment}-${scope}`;
}

function normalizeFailure(
  payload: Record<string, unknown> | null
): DelegatedTaskResult | null {
  if (!payload) {
    return null;
  }

  if (payload.status === "failed") {
    return {
      ...payload,
      status: "failed",
      error:
        typeof payload.error === "string"
          ? payload.error
          : typeof payload.message === "string"
            ? payload.message
            : "OpenClaw task failed.",
    };
  }

  if (payload.ok === false) {
    const rawError = payload.error;
    const objectError =
      rawError && typeof rawError === "object"
        ? (rawError as { message?: unknown })
        : null;
    const message =
      typeof rawError === "string"
        ? rawError
        : objectError && typeof objectError.message === "string"
          ? objectError.message
          : typeof payload.message === "string"
            ? payload.message
            : "OpenClaw task failed.";
    return {
      ...payload,
      status: "failed",
      error: message,
    };
  }

  return null;
}

function normalizeSuccess(
  payload: Record<string, unknown> | null
): DelegatedTaskResult | null {
  if (!payload) {
    return null;
  }

  if (payload.status === "queued" || payload.status === "running") {
    return {
      ...payload,
      status: payload.status,
    };
  }

  if (payload.status === "completed") {
    return {
      ...payload,
      status: "completed",
    };
  }

  return null;
}

function parseJsonResult(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeDelegatedTaskResponse(response: Response, text: string): DelegatedTaskResult {
  const payload = parseJsonResult(text);
  const normalizedFailure = normalizeFailure(payload);

  if (!response.ok) {
    if (normalizedFailure) {
      return normalizedFailure;
    }
    return {
      status: "failed",
      error: `HTTP ${response.status}: ${text.slice(0, 500)}`,
    };
  }

  if (normalizedFailure) {
    return normalizedFailure;
  }

  const normalizedSuccess = normalizeSuccess(payload);
  if (normalizedSuccess) {
    return normalizedSuccess;
  }

  if (payload) {
    return {
      status: "completed",
      ...payload,
    };
  }

  return {
    status: "completed",
    output: text,
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function readPollingEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePollIntervalMs(): number {
  return readPollingEnv("AIRLAB_OPENCLAW_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS);
}

function resolvePollTimeoutMs(requested: number | undefined): number {
  const value = isPositiveInteger(requested)
    ? requested
    : readPollingEnv("AIRLAB_OPENCLAW_POLL_TIMEOUT_MS", DEFAULT_POLL_TIMEOUT_MS);
  return Math.min(value, MAX_POLL_TIMEOUT_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildJobStatusEndpoint(endpoint: string, jobId: string): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(jobId)}`;
  url.search = "";
  return url.toString();
}

export function isOpenClawTaskInProgress(
  value: unknown
): value is DelegatedTaskQueuedResult {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (((value as { status?: unknown }).status === "queued") ||
      ((value as { status?: unknown }).status === "running"))
  );
}

export interface AwaitOpenClawTaskOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  onStatus?: (update: DelegatedTaskPollUpdate) => void | Promise<void>;
}

export class OpenClawBackend implements AgentBackend {
  private readonly resolvedEndpoint: string;

  constructor(endpoint: string, private readonly config?: OpenClawDispatchConfig) {
    this.resolvedEndpoint = resolveEndpoint(endpoint);
  }

  private buildHeaders(includeContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (includeContentType) {
      headers["Content-Type"] = "application/json";
    }

    const token = resolveConfigValue(this.config?.bearerToken);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return headers;
  }

  private async parseResponse(response: Response): Promise<DelegatedTaskResult> {
    const rawText = await response.text();
    const text = rawText.slice(0, MAX_RESPONSE_BYTES);
    return normalizeDelegatedTaskResponse(response, text);
  }

  async runTask(input: DelegatedTaskInput): Promise<DelegatedTaskResult> {
    const response = await fetch(this.resolvedEndpoint, {
      method: "POST",
      headers: this.buildHeaders(true),
      body: JSON.stringify(input),
    });

    return this.parseResponse(response);
  }

  async getTask(jobId: string): Promise<DelegatedTaskResult> {
    const response = await fetch(buildJobStatusEndpoint(this.resolvedEndpoint, jobId), {
      method: "GET",
      headers: this.buildHeaders(false),
    });

    return this.parseResponse(response);
  }
}

export async function awaitOpenClawTaskCompletion(
  endpoint: string,
  config: OpenClawDispatchConfig | undefined,
  initialResult: DelegatedTaskQueuedResult,
  options: AwaitOpenClawTaskOptions = {}
): Promise<DelegatedTaskResult> {
  const jobId = typeof initialResult.jobId === "string" ? initialResult.jobId.trim() : "";
  if (!jobId) {
    return {
      status: "failed",
      error: "OpenClaw backend returned a queued/running task without a jobId.",
      summary:
        typeof initialResult.summary === "string" && initialResult.summary.trim().length > 0
          ? initialResult.summary
          : "Delegated OpenClaw task could not be polled because no job id was returned.",
    };
  }

  const backend = new OpenClawBackend(endpoint.trim() || DEFAULT_OPENCLAW_BRIDGE_PATH, config);
  const pollIntervalMs = isPositiveInteger(options.pollIntervalMs)
    ? options.pollIntervalMs
    : resolvePollIntervalMs();
  const timeoutMs = resolvePollTimeoutMs(options.timeoutMs);
  const startedAt = Date.now();
  let lastFingerprint = "";
  let latest: DelegatedTaskQueuedResult = { ...initialResult, jobId };

  const emitStatus = async (result: DelegatedTaskQueuedResult, pollCount: number) => {
    if (!options.onStatus) {
      return;
    }
    const update: DelegatedTaskPollUpdate = {
      ...result,
      jobId,
      pollCount,
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

  await emitStatus(latest, 0);

  let pollCount = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs);
    pollCount += 1;
    let next: DelegatedTaskResult;
    try {
      next = await backend.getTask(jobId);
    } catch (error) {
      return {
        status: "failed",
        error:
          error instanceof Error
            ? error.message
            : `Unknown OpenClaw polling error for job "${jobId}".`,
        summary: `Failed while polling delegated OpenClaw job "${jobId}".`,
        jobId,
        preview: latest.preview,
      };
    }
    if (isOpenClawTaskInProgress(next)) {
      latest = { ...next, jobId };
      await emitStatus(latest, pollCount);
      continue;
    }
    return next;
  }

  return {
    status: "failed",
    error: `OpenClaw job "${jobId}" did not complete within ${timeoutMs} ms.`,
    summary:
      typeof latest.summary === "string" && latest.summary.trim().length > 0
        ? latest.summary
        : `Last known OpenClaw job status: ${latest.status}.`,
    jobId,
    preview: latest.preview,
  };
}

export async function dispatchOpenClawTask(
  endpoint: string,
  config: OpenClawDispatchConfig | undefined,
  args: Record<string, unknown>,
  context?: ToolDispatchContext
): Promise<ToolDispatchResult> {
  const effectiveEndpoint = endpoint.trim() || DEFAULT_OPENCLAW_BRIDGE_PATH;
  const backend = new OpenClawBackend(effectiveEndpoint, config);
  const payload = buildTaskPayload(config, args, context);

  try {
    const result = await backend.runTask(payload);
    if (result.status === "failed") {
      return {
        ok: false,
        error: result.error,
        transport: "openclaw",
        transportNote: `Delegated to OpenClaw backend at ${effectiveEndpoint}.`,
      };
    }

    return {
      ok: true,
      data: result,
      transport: "openclaw",
      transportNote: `Delegated to OpenClaw backend at ${effectiveEndpoint}.`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown OpenClaw dispatch error",
      transport: "openclaw",
      transportNote: `Delegated to OpenClaw backend at ${effectiveEndpoint}.`,
    };
  }
}

export const OPENCLAW_RUNTIME_JOB_TABLE = "openclaw_task_jobs";
export const OPENCLAW_RUNTIME_JOB_MIGRATION =
  "supabase/migrations/20260605000000_openclaw_task_jobs.sql";

export type RuntimeJobStatus = "queued" | "running" | "completed" | "failed";

interface OpenClawTaskJobRow {
  id: string;
  status: RuntimeJobStatus;
  input: Record<string, unknown> | null;
  preview: string | null;
  summary: string | null;
  result: Record<string, unknown> | null;
  attempt_count: number | null;
  execution_token: string | null;
  lease_expires_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface StoredOpenClawJobRecord {
  jobId: string;
  status: RuntimeJobStatus;
  input: DelegatedTaskInput;
  preview: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  attemptCount: number;
  executionToken?: string;
  leaseExpiresAt?: string;
  result?: DelegatedTaskResult;
}

type SupabaseErrorLike = { message: string };
type SupabaseResult = {
  data: unknown;
  error: SupabaseErrorLike | null;
};

interface RuntimeSelectBuilder {
  eq(column: string, value: unknown): RuntimeSelectBuilder;
  maybeSingle(): Promise<SupabaseResult>;
  single(): Promise<SupabaseResult>;
}

interface RuntimeInsertBuilder {
  select(columns: string): RuntimeSelectBuilder;
}

interface RuntimeUpdateBuilder {
  eq(column: string, value: unknown): RuntimeUpdateBuilder;
  select(columns: string): RuntimeSelectBuilder;
}

interface RuntimeTableQuery {
  insert(value: Record<string, unknown>): RuntimeInsertBuilder;
  update(value: Record<string, unknown>): RuntimeUpdateBuilder;
  select(columns: string): RuntimeSelectBuilder;
}

export interface OpenClawRuntimeSupabaseClient {
  from(table: string): RuntimeTableQuery;
}

export type CreateOpenClawRuntimeSupabaseAdminClient = () => unknown;

export interface OpenClawRuntimeStoreConfig {
  createSupabaseAdminClient: CreateOpenClawRuntimeSupabaseAdminClient;
}

let configuredStore: OpenClawRuntimeStoreConfig | null = null;

export function configureOpenClawRuntimeStore(config: OpenClawRuntimeStoreConfig): void {
  configuredStore = config;
}

function createSupabaseAdminClient(): OpenClawRuntimeSupabaseClient {
  if (!configuredStore) {
    throw new Error(
      "OpenClaw runtime storage is not configured. Call configureOpenClawRuntimeStore() " +
        "with this app's Supabase admin client before queueing or loading jobs."
    );
  }
  return configuredStore.createSupabaseAdminClient() as OpenClawRuntimeSupabaseClient;
}

const SELECT_COLS = [
  "id",
  "status",
  "input",
  "preview",
  "summary",
  "result",
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

function normalizeInput(value: unknown): DelegatedTaskInput {
  return value && typeof value === "object" && !Array.isArray(value)
    ? ({ ...(value as Record<string, unknown>) } as DelegatedTaskInput)
    : {};
}

function normalizeResult(value: unknown): DelegatedTaskResult | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? ({ ...(value as Record<string, unknown>) } as DelegatedTaskResult)
    : undefined;
}

function coerceJobRow(value: unknown): OpenClawTaskJobRow {
  return value as OpenClawTaskJobRow;
}

function mapRow(row: OpenClawTaskJobRow): StoredOpenClawJobRecord {
  return {
    jobId: row.id,
    status: row.status,
    input: normalizeInput(row.input),
    preview: row.preview ?? "",
    summary: row.summary ?? "",
    createdAt: row.created_at ?? nowIso(),
    updatedAt: row.updated_at ?? nowIso(),
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    attemptCount: row.attempt_count ?? 0,
    executionToken: row.execution_token ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    result: normalizeResult(row.result),
  };
}

function formatStoreError(message: string): string {
  if (
    message.includes(OPENCLAW_RUNTIME_JOB_TABLE) ||
    (message.includes("relation") && message.includes("openclaw_task_jobs"))
  ) {
    return (
      "OpenClaw task storage is not provisioned yet. Run `" +
      OPENCLAW_RUNTIME_JOB_MIGRATION +
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

function resolveJobLeaseMs(input: DelegatedTaskInput): number {
  const requestedTimeout =
    typeof input.timeoutMs === "number" &&
    Number.isFinite(input.timeoutMs) &&
    input.timeoutMs > 0
      ? Math.trunc(input.timeoutMs) + LEASE_BUFFER_MS
      : readPositiveIntegerEnv("AIRLAB_OPENCLAW_JOB_LEASE_MS", DEFAULT_JOB_LEASE_MS);
  return Math.min(Math.max(requestedTimeout, DEFAULT_JOB_LEASE_MS), MAX_JOB_LEASE_MS);
}

function resolveLeaseExpiry(input: DelegatedTaskInput): string {
  const now = nowIso();
  return addMs(now, resolveJobLeaseMs(input));
}

function isExpired(iso: string | undefined): boolean {
  if (!iso) {
    return true;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) || ms <= Date.now();
}

export function canResumeStoredOpenClawJob(record: StoredOpenClawJobRecord): boolean {
  if (record.status === "queued") {
    return true;
  }
  return record.status === "running" && isExpired(record.leaseExpiresAt);
}

export async function createStoredOpenClawJob(args: {
  jobId: string;
  input: DelegatedTaskInput;
  preview: string;
  summary: string;
}): Promise<StoredOpenClawJobRecord> {
  const supabase = createSupabaseAdminClient();
  const now = nowIso();
  const { data, error } = await supabase
    .from(OPENCLAW_RUNTIME_JOB_TABLE)
    .insert({
      id: args.jobId,
      status: "queued",
      input: args.input,
      preview: args.preview,
      summary: args.summary,
      created_at: now,
      updated_at: now,
    })
    .select(SELECT_COLS)
    .single();

  if (error || !data) {
    throw storeError(error?.message ?? "Failed to create OpenClaw task job.");
  }

  return mapRow(coerceJobRow(data));
}

export async function loadStoredOpenClawJob(
  jobId: string
): Promise<StoredOpenClawJobRecord | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from(OPENCLAW_RUNTIME_JOB_TABLE)
    .select(SELECT_COLS)
    .eq("id", jobId)
    .maybeSingle();

  if (error) {
    throw storeError(error.message);
  }

  return data ? mapRow(coerceJobRow(data)) : null;
}

export async function claimStoredOpenClawJob(
  record: StoredOpenClawJobRecord,
  summary: string
): Promise<StoredOpenClawJobRecord | null> {
  const supabase = createSupabaseAdminClient();
  const now = nowIso();
  const { data, error } = await supabase
    .from(OPENCLAW_RUNTIME_JOB_TABLE)
    .update({
      status: "running",
      summary,
      updated_at: now,
      started_at: record.startedAt ?? now,
      attempt_count: record.attemptCount + 1,
      execution_token: makeExecutionToken(),
      lease_expires_at: resolveLeaseExpiry(record.input),
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

export async function finalizeStoredOpenClawJob(
  record: StoredOpenClawJobRecord,
  result: DelegatedTaskResult,
  summary: string
): Promise<StoredOpenClawJobRecord | null> {
  const executionToken = record.executionToken?.trim();
  if (!executionToken) {
    throw new Error(
      `OpenClaw task job "${record.jobId}" cannot be finalized without an execution token.`
    );
  }

  const supabase = createSupabaseAdminClient();
  const now = nowIso();
  const terminalStatus = result.status === "failed" ? "failed" : "completed";
  const { data, error } = await supabase
    .from(OPENCLAW_RUNTIME_JOB_TABLE)
    .update({
      status: terminalStatus,
      summary,
      result,
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

export const delegatedTaskSchema = z
  .object({
    task: z.string().optional(),
    goal: z.string().optional(),
    context: z.string().optional(),
    mode: z.enum(["sync", "async"]).optional(),
    allowedSkills: z.array(z.string()).optional(),
    allowedTools: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
    agentId: z.string().optional(),
    responseFormat: z.enum(["text", "json"]).optional(),
  })
  .catchall(z.unknown());

export type ParsedDelegatedTaskInput = z.infer<typeof delegatedTaskSchema>;

function truncateText(value: string | undefined, max = 240): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

function makeJobId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `openclaw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function asParsedInput(input: DelegatedTaskInput): ParsedDelegatedTaskInput {
  const parsed = delegatedTaskSchema.safeParse(input);
  return parsed.success ? parsed.data : {};
}

function buildPreview(input: ParsedDelegatedTaskInput): string {
  const task = truncateText(input.task, 140);
  if (task) {
    return task;
  }
  const goal = truncateText(input.goal, 140);
  if (goal) {
    return goal;
  }
  const context = truncateText(input.context, 140);
  if (context) {
    return context;
  }
  return "Delegated OpenClaw task";
}

function buildQueuedSummary(input: ParsedDelegatedTaskInput): string {
  const agentLabel = input.agentId?.trim() || "default-openclaw-agent";
  return `Queued delegated task for ${agentLabel}.`;
}

function buildRunningSummary(input: ParsedDelegatedTaskInput): string {
  const agentLabel = input.agentId?.trim() || "default-openclaw-agent";
  return `Running delegated task for ${agentLabel}.`;
}

function buildCompletedAnswer(input: ParsedDelegatedTaskInput): string {
  const pieces: string[] = [];
  const agentLabel = input.agentId?.trim() || "default-openclaw-agent";
  pieces.push(`Completed delegated task for ${agentLabel}.`);

  const task = truncateText(input.task, 280);
  if (task) {
    pieces.push(`Task: ${task}`);
  }

  const goal = truncateText(input.goal, 220);
  if (goal) {
    pieces.push(`Goal: ${goal}`);
  }

  const context = truncateText(input.context, 320);
  if (context) {
    pieces.push(`Context: ${context}`);
  }

  if (Array.isArray(input.allowedSkills) && input.allowedSkills.length > 0) {
    pieces.push(`Allowed skills: ${input.allowedSkills.join(", ")}.`);
  }

  if (Array.isArray(input.allowedTools) && input.allowedTools.length > 0) {
    pieces.push(`Allowed tools: ${input.allowedTools.join(", ")}.`);
  }

  if (pieces.length === 1) {
    pieces.push(
      "No standard task fields were provided, so the payload was captured as structured artifacts."
    );
  }

  return pieces.join(" ");
}

function buildCompletedSummary(input: ParsedDelegatedTaskInput): string {
  return truncateText(buildCompletedAnswer(input), 160) || "Delegated task completed.";
}

function asCompletedResult(input: ParsedDelegatedTaskInput): DelegatedTaskCompletedResult {
  const answer = buildCompletedAnswer(input);
  return {
    status: "completed",
    answer,
    output:
      input.responseFormat === "json"
        ? JSON.stringify(
            {
              answer,
              agentId: input.agentId ?? null,
              allowedSkills: input.allowedSkills ?? [],
              allowedTools: input.allowedTools ?? [],
              task: input.task ?? null,
              goal: input.goal ?? null,
            },
            null,
            2
          )
        : answer,
    artifacts: {
      runtime: "airlab-openclaw-local",
      receivedPayload: input,
      agentId: input.agentId ?? null,
      allowedSkills: input.allowedSkills ?? [],
      allowedTools: input.allowedTools ?? [],
    },
    trace: ["gateway.accepted", "executor.local.start", "executor.local.complete"],
    summary: buildCompletedSummary(input),
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeExecutorResult(
  responseOk: boolean,
  responseStatus: number,
  text: string
): DelegatedTaskResult {
  const payload = parseJsonObject(text);
  const message = truncateText(text, 500) || `HTTP ${responseStatus}`;

  if (payload?.status === "completed") {
    return { ...payload, status: "completed" };
  }
  if (payload?.status === "failed") {
    return {
      ...payload,
      status: "failed",
      error:
        typeof payload.error === "string" ? payload.error : "Delegated executor failed.",
    };
  }
  if (payload?.status === "queued" || payload?.status === "running") {
    return {
      status: "failed",
      error:
        "Configured OpenClaw executor returned an async status to the first-party runtime. " +
        "The runtime expects a terminal result from its executor.",
      summary:
        typeof payload.summary === "string"
          ? payload.summary
          : "Executor returned a non-terminal status.",
    };
  }
  if (!responseOk) {
    return {
      status: "failed",
      error: `HTTP ${responseStatus}: ${message}`,
      summary: "Configured OpenClaw executor returned a non-success response.",
    };
  }
  if (payload) {
    return {
      status: "completed",
      ...payload,
      summary:
        typeof payload.summary === "string"
          ? payload.summary
          : "Configured OpenClaw executor returned a JSON payload.",
    };
  }
  return {
    status: "completed",
    answer: text,
    output: text,
    artifacts: { runtime: "airlab-openclaw-http-executor" },
    trace: ["gateway.accepted", "executor.http.complete"],
    summary: truncateText(text, 160) || "Configured OpenClaw executor returned text.",
  };
}

async function runConfiguredExecutor(
  input: ParsedDelegatedTaskInput
): Promise<DelegatedTaskResult | null> {
  const executorUrl =
    readEnv("AIRLAB_OPENCLAW_EXECUTOR_URL") || readEnv("OPENCLAW_EXECUTOR_URL");
  if (!executorUrl) {
    return null;
  }

  const headers: Record<string, string> = {
    Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
    "Content-Type": "application/json",
  };
  const bearerToken =
    readEnv("AIRLAB_OPENCLAW_EXECUTOR_BEARER_TOKEN") ||
    readEnv("OPENCLAW_EXECUTOR_BEARER_TOKEN");
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  try {
    const response = await fetch(executorUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...input, mode: "sync" }),
    });
    const text = await response.text();
    return normalizeExecutorResult(response.ok, response.status, text);
  } catch (error) {
    return {
      status: "failed",
      error:
        error instanceof Error
          ? error.message
          : "Unknown configured OpenClaw executor error.",
      summary: `Failed to reach configured executor ${executorUrl}.`,
    };
  }
}

async function executeTask(input: ParsedDelegatedTaskInput): Promise<DelegatedTaskResult> {
  const proxied = await runConfiguredExecutor(input);
  if (proxied) {
    return proxied;
  }
  return asCompletedResult(input);
}

function cloneResult(result: DelegatedTaskResult): DelegatedTaskResult {
  return JSON.parse(JSON.stringify(result)) as DelegatedTaskResult;
}

function formatJob(record: StoredOpenClawJobRecord): DelegatedTaskResult {
  if (record.status === "queued" || record.status === "running") {
    const queuedResult: DelegatedTaskQueuedResult = {
      status: record.status,
      jobId: record.jobId,
      preview: record.preview,
      summary: record.summary,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    };
    return queuedResult;
  }

  const baseResult = record.result
    ? cloneResult(record.result)
    : ({
        status: "failed",
        error: "Delegated job is missing its terminal result.",
        summary: record.summary,
      } satisfies DelegatedTaskFailedResult);

  const summary =
    typeof baseResult.summary === "string" && baseResult.summary.trim().length > 0
      ? baseResult.summary
      : record.summary;

  if (record.status === "completed") {
    return {
      ...baseResult,
      status: "completed",
      jobId: record.jobId,
      preview: record.preview,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      summary,
    };
  }

  return {
    ...baseResult,
    status: "failed",
    error:
      "error" in baseResult && typeof baseResult.error === "string"
        ? baseResult.error
        : "Delegated task failed.",
    jobId: record.jobId,
    preview: record.preview,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    summary,
  };
}

async function continueStoredJob(record: StoredOpenClawJobRecord): Promise<void> {
  let result: DelegatedTaskResult;
  try {
    result = await executeTask({ ...asParsedInput(record.input), mode: "sync" });
  } catch (error) {
    result = {
      status: "failed",
      error:
        error instanceof Error
          ? error.message
          : "Unknown delegated job execution error.",
      summary: "The first-party OpenClaw runtime crashed while finishing the job.",
    };
  }

  const summary =
    typeof result.summary === "string" && result.summary.trim().length > 0
      ? result.summary
      : result.status === "completed"
        ? buildCompletedSummary(asParsedInput(record.input))
        : "Delegated task failed.";

  try {
    await finalizeStoredOpenClawJob(record, result, summary);
  } catch (error) {
    console.error(
      "[openclaw-runtime] failed to finalize delegated job:",
      error instanceof Error ? error.message : error
    );
  }
}

function scheduleStoredJob(record: StoredOpenClawJobRecord) {
  setTimeout(() => {
    void continueStoredJob(record);
  }, 0);
}

async function maybeStartStoredJob(
  record: StoredOpenClawJobRecord
): Promise<StoredOpenClawJobRecord> {
  if (!canResumeStoredOpenClawJob(record)) {
    return record;
  }

  const claimed = await claimStoredOpenClawJob(
    record,
    buildRunningSummary(asParsedInput(record.input))
  );
  if (!claimed) {
    return (await loadStoredOpenClawJob(record.jobId)) ?? record;
  }

  scheduleStoredJob(claimed);
  return claimed;
}

export async function executeDelegatedTaskSync(
  input: ParsedDelegatedTaskInput
): Promise<DelegatedTaskResult> {
  return executeTask({ ...input, mode: "sync" });
}

export async function queueDelegatedTask(
  input: ParsedDelegatedTaskInput
): Promise<DelegatedTaskQueuedResult> {
  const record = await createStoredOpenClawJob({
    jobId: makeJobId(),
    input,
    preview: buildPreview(input),
    summary: buildQueuedSummary(input),
  });

  void maybeStartStoredJob(record).catch((error) => {
    console.error(
      "[openclaw-runtime] failed to start delegated job:",
      error instanceof Error ? error.message : error
    );
  });

  return formatJob(record) as DelegatedTaskQueuedResult;
}

export async function getDelegatedTaskJob(
  jobId: string
): Promise<DelegatedTaskResult | null> {
  const record = await loadStoredOpenClawJob(jobId);
  if (!record) {
    return null;
  }

  const active = await maybeStartStoredJob(record);
  return formatJob(active);
}

export function getRuntimeBearerToken(): string | undefined {
  return readEnv("AIRLAB_OPENCLAW_RUNTIME_BEARER_TOKEN") || readEnv("OPENCLAW_RUNTIME_BEARER_TOKEN");
}

export type ResolvedBridgeUpstream =
  | {
      kind: "configured-backend";
      url: string;
    }
  | {
      kind: "builtin-runtime";
      url: string;
    };

export interface OpenClawBridgeRequest {
  nextUrl: {
    origin: string;
  };
}

function absolutizeUrl(rawUrl: string, request: OpenClawBridgeRequest): string {
  try {
    return new URL(rawUrl).toString();
  } catch {
    return new URL(rawUrl, request.nextUrl.origin).toString();
  }
}

export function readBearerToken(header: string | null): string | null {
  if (!header) {
    return null;
  }

  const match = header.trim().match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function getRequiredBridgeToken(): string | undefined {
  return readEnv("AIRLAB_OPENCLAW_BRIDGE_BEARER_TOKEN") || readEnv("OPENCLAW_BRIDGE_BEARER_TOKEN");
}

export function resolveBridgeTasksUpstream(
  request: OpenClawBridgeRequest
): ResolvedBridgeUpstream {
  const configuredUrl =
    readEnv("AIRLAB_OPENCLAW_BACKEND_URL") || readEnv("OPENCLAW_BACKEND_URL");
  if (configuredUrl) {
    return {
      kind: "configured-backend",
      url: absolutizeUrl(configuredUrl, request),
    };
  }

  return {
    kind: "builtin-runtime",
    url: new URL(DEFAULT_OPENCLAW_RUNTIME_TASKS_PATH, request.nextUrl.origin).toString(),
  };
}

export function resolveBridgeJobUpstream(
  request: OpenClawBridgeRequest,
  jobId: string
): ResolvedBridgeUpstream {
  const upstream = resolveBridgeTasksUpstream(request);
  const url = new URL(upstream.url);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(jobId)}`;
  url.search = "";
  return { ...upstream, url: url.toString() };
}

export function buildBridgeUpstreamAuthHeader(
  upstream: ResolvedBridgeUpstream,
  incomingAuthorization: string | null
): string | undefined {
  if (upstream.kind === "configured-backend") {
    const configuredToken =
      readEnv("AIRLAB_OPENCLAW_BACKEND_BEARER_TOKEN") ||
      readEnv("OPENCLAW_BACKEND_BEARER_TOKEN");
    if (configuredToken) {
      return `Bearer ${configuredToken}`;
    }
    const incomingToken = readBearerToken(incomingAuthorization);
    return incomingToken ? `Bearer ${incomingToken}` : undefined;
  }

  const runtimeToken = getRuntimeBearerToken();
  return runtimeToken ? `Bearer ${runtimeToken}` : undefined;
}
