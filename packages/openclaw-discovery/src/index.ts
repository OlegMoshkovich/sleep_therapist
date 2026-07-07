export const EXTERNAL_CAPABILITY_CATALOG_STORAGE_KEY =
  "general-orchestration-daemon.externalCapabilityCatalog.v1";

export const DEFAULT_OPENCLAW_BRIDGE_PATH = "/api/openclaw/tasks";

export type ExternalCapabilityProvider = "openclaw" | "hermes" | "custom";
export type ExternalCapabilityKind = "tool" | "task" | "skill" | "agent" | "package";
export type ExternalCapabilityExecutionMode = "sync" | "async";
export type ExternalCapabilityAuthType = "none" | "api_key" | "oauth" | "bearer";
export type ExternalCapabilityAuthStatus = "ready" | "needs_setup" | "unknown";
export type ExternalCapabilityVerificationStatus =
  | "verified_live"
  | "registry"
  | "sample"
  | "unverified";
export type ExternalCapabilityKindFilter = ExternalCapabilityKind | "all";

export interface ExternalCapabilityRecord {
  id: string;
  provider: ExternalCapabilityProvider;
  sourceId: string;
  sourceLabel: string;
  externalKind: ExternalCapabilityKind;
  externalId: string;
  externalAgentId?: string;
  name: string;
  description: string;
  endpoint: string;
  executionMode: ExternalCapabilityExecutionMode;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  version?: string;
  tags: string[];
  auth: {
    type: ExternalCapabilityAuthType;
    status: ExternalCapabilityAuthStatus;
    label?: string;
  };
  verification?: {
    status: ExternalCapabilityVerificationStatus;
    checkedAt?: string;
    source?: string;
    details?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface OpenClawDiscoveryResult {
  capabilities: ExternalCapabilityRecord[];
  warnings: string[];
  sourceLabel: string;
  registryConfigured: boolean;
  verificationAvailable: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_DISCOVERY_TEXT_LENGTH = 500_000;
const DEFAULT_CLAWHUB_BASE_URL = "https://clawhub.ai";
const RETRYABLE_DISCOVERY_STATUS_CODES = new Set([429, 503]);
const MAX_DISCOVERY_RETRIES = 2;
const MAX_DISCOVERY_RETRY_DELAY_MS = 1500;
const DISCOVERY_FETCH_TIMEOUT_MS = 5000;

const DEFAULT_TASK_INPUT_SCHEMA = {
  task: {
    type: "string",
    description: "The concrete task or request to delegate.",
  },
};

const OPENCLAW_SAMPLE_ITEMS: Array<Record<string, unknown>> = [
  {
    sourceId: "openclaw-samples",
    sourceLabel: "OpenClaw samples",
    externalKind: "tool",
    externalId: "gmail_connection",
    externalAgentId: "gmail",
    name: "Gmail connection",
    description:
      "Sample connector shape for searching, summarizing, drafting, and sending Gmail messages.",
    executionMode: "async",
    inputSchema: {
      task: {
        type: "string",
        description: "The Gmail request to perform.",
      },
      operation: {
        type: "string",
        enum: ["search", "summarize", "draft", "send", "label"],
      },
    },
    tags: ["gmail", "email", "google", "sample"],
    auth: {
      type: "oauth",
      status: "needs_setup",
      label: "Google OAuth",
    },
    verification: {
      status: "sample",
      source: "OPENCLAW_DISCOVERY_INCLUDE_SAMPLES",
      details: "Sample entry only; not verified against a live registry.",
    },
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => asString(item)).filter(Boolean)
    : [];
}

function readString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readBooleanEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function readConfiguredRegistryUrl(): string {
  return (
    process.env.CLAWHUB_REGISTRY?.trim() ||
    process.env.OPENCLAW_REGISTRY_URL?.trim() ||
    process.env.OPENCLAW_DISCOVERY_MANIFEST_URL?.trim() ||
    ""
  );
}

function readVerificationUrl(): string {
  return process.env.OPENCLAW_REGISTRY_VERIFY_URL?.trim() || "";
}

function readClawHubSite(): string {
  return process.env.CLAWHUB_SITE?.trim() || DEFAULT_CLAWHUB_BASE_URL;
}

function readRegistryToken(): string {
  return (
    process.env.CLAWHUB_TOKEN?.trim() ||
    process.env.OPENCLAW_REGISTRY_TOKEN?.trim() ||
    process.env.OPENCLAW_DISCOVERY_TOKEN?.trim() ||
    ""
  );
}

function makeHeaders(): Record<string, string> {
  const token = readRegistryToken();
  return {
    accept: "application/json, text/plain;q=0.9, */*;q=0.1",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function normalizeProvider(value: unknown): ExternalCapabilityProvider {
  return value === "hermes" || value === "custom" ? value : "openclaw";
}

function normalizeKind(value: unknown): ExternalCapabilityKind {
  return value === "tool" ||
    value === "skill" ||
    value === "agent" ||
    value === "package"
    ? value
    : "task";
}

function normalizeExecutionMode(value: unknown): ExternalCapabilityExecutionMode {
  return value === "sync" ? "sync" : "async";
}

function normalizeAuthType(value: unknown): ExternalCapabilityAuthType {
  return value === "api_key" || value === "oauth" || value === "bearer"
    ? value
    : "none";
}

function normalizeAuthStatus(value: unknown): ExternalCapabilityAuthStatus {
  return value === "ready" || value === "needs_setup" ? value : "unknown";
}

function normalizeVerificationStatus(
  value: unknown
): ExternalCapabilityVerificationStatus | null {
  const normalized = asString(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (
    normalized === "verified_live" ||
    normalized === "verified" ||
    normalized === "live"
  ) {
    return "verified_live";
  }
  if (normalized === "registry" || normalized === "registry_listed") {
    return "registry";
  }
  if (normalized === "sample" || normalized === "example") {
    return "sample";
  }
  if (
    normalized === "unverified" ||
    normalized === "not_found" ||
    normalized === "failed"
  ) {
    return "unverified";
  }
  return null;
}

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  const schema = asRecord(value);
  return schema && Object.keys(schema).length > 0 ? schema : DEFAULT_TASK_INPUT_SCHEMA;
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function makeCatalogId(args: {
  provider: ExternalCapabilityProvider;
  sourceId: string;
  externalKind: ExternalCapabilityKind;
  externalId: string;
}) {
  return [
    args.provider,
    args.sourceId,
    args.externalKind,
    args.externalId,
  ]
    .map((part) => slugify(part).replace(/-/g, "_"))
    .filter(Boolean)
    .join("__");
}

function normalizeEndpoint(
  provider: ExternalCapabilityProvider,
  endpoint: string
): string {
  if (endpoint.trim()) {
    return endpoint.trim();
  }
  return provider === "openclaw" ? DEFAULT_OPENCLAW_BRIDGE_PATH : "";
}

export function normalizeExternalCapabilityRecord(
  raw: unknown
): ExternalCapabilityRecord | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const provider = normalizeProvider(record.provider);
  const externalKind = normalizeKind(record.externalKind ?? record.kind);
  const sourceId = asString(record.sourceId) || provider;
  const externalId =
    asString(record.externalId) ||
    asString(record.id) ||
    asString(record.name) ||
    `${externalKind}_${Date.now().toString(36)}`;
  const name = asString(record.name) || externalId;
  const now = new Date().toISOString();
  const rawVerification = asRecord(record.verification);
  const verificationStatus =
    normalizeVerificationStatus(rawVerification?.status) ??
    normalizeVerificationStatus(record.verificationStatus) ??
    (record.sample === true || record.example === true
      ? "sample"
      : record.verified === true || record.live === true
        ? "verified_live"
        : null);

  return {
    id:
      asString(record.id) ||
      makeCatalogId({ provider, sourceId, externalKind, externalId }),
    provider,
    sourceId,
    sourceLabel: asString(record.sourceLabel) || sourceId,
    externalKind,
    externalId,
    externalAgentId: asString(record.externalAgentId) || undefined,
    name,
    description: asString(record.description),
    endpoint: normalizeEndpoint(provider, asString(record.endpoint)),
    executionMode: normalizeExecutionMode(record.executionMode),
    inputSchema: normalizeInputSchema(record.inputSchema),
    outputSchema: asRecord(record.outputSchema) ?? undefined,
    version: asString(record.version) || undefined,
    tags: [
      ...asStringArray(record.tags),
      provider,
      externalKind,
      sourceId,
      externalId,
      name,
    ]
      .map(normalizeTag)
      .filter(Boolean),
    auth: {
      type: normalizeAuthType(asRecord(record.auth)?.type ?? record.authType),
      status: normalizeAuthStatus(
        asRecord(record.auth)?.status ?? record.authStatus
      ),
      label: asString(asRecord(record.auth)?.label ?? record.authLabel) || undefined,
    },
    verification: verificationStatus
      ? {
          status: verificationStatus,
          checkedAt: asString(rawVerification?.checkedAt) || undefined,
          source: asString(rawVerification?.source) || undefined,
          details:
            asString(rawVerification?.details) ||
            asString(record.verificationDetails) ||
            undefined,
        }
      : undefined,
    createdAt: asString(record.createdAt) || now,
    updatedAt: asString(record.updatedAt) || now,
  };
}

export function sortExternalCapabilities(
  capabilities: ExternalCapabilityRecord[]
): ExternalCapabilityRecord[] {
  return [...capabilities].sort((a, b) => {
    const providerCompare = a.provider.localeCompare(b.provider);
    if (providerCompare !== 0) return providerCompare;
    return a.name.localeCompare(b.name);
  });
}

export function readExternalCapabilityCatalogFromStorage(
  storage: Storage | undefined =
    typeof window !== "undefined" ? window.localStorage : undefined
): ExternalCapabilityRecord[] {
  if (!storage) {
    return [];
  }
  try {
    const parsed = JSON.parse(
      storage.getItem(EXTERNAL_CAPABILITY_CATALOG_STORAGE_KEY) || "[]"
    ) as unknown;
    return sortExternalCapabilities(
      Array.isArray(parsed)
        ? parsed.flatMap((item) => normalizeExternalCapabilityRecord(item) ?? [])
        : []
    );
  } catch {
    return [];
  }
}

export function writeExternalCapabilityCatalogToStorage(
  capabilities: ExternalCapabilityRecord[],
  storage: Storage | undefined =
    typeof window !== "undefined" ? window.localStorage : undefined
): void {
  if (!storage) {
    return;
  }
  storage.setItem(
    EXTERNAL_CAPABILITY_CATALOG_STORAGE_KEY,
    JSON.stringify(sortExternalCapabilities(capabilities))
  );
}

export function upsertExternalCapabilities(
  current: ExternalCapabilityRecord[],
  incoming: ExternalCapabilityRecord[]
): ExternalCapabilityRecord[] {
  const byId = new Map<string, ExternalCapabilityRecord>();
  current.forEach((capability) => byId.set(capability.id, capability));
  incoming.forEach((capability) =>
    byId.set(capability.id, {
      ...byId.get(capability.id),
      ...capability,
      createdAt: byId.get(capability.id)?.createdAt ?? capability.createdAt,
      updatedAt: new Date().toISOString(),
    })
  );
  return sortExternalCapabilities([...byId.values()]);
}

export function externalCapabilityMatchesQuery(
  capability: ExternalCapabilityRecord,
  query: string
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return [
    capability.name,
    capability.description,
    capability.externalId,
    capability.externalAgentId ?? "",
    capability.sourceLabel,
    capability.endpoint,
    ...capability.tags,
  ].some((value) => value.toLowerCase().includes(normalized));
}

export function filterExternalCapabilities(args: {
  capabilities: ExternalCapabilityRecord[];
  query: string;
  kind: ExternalCapabilityKindFilter;
}): ExternalCapabilityRecord[] {
  return args.capabilities.filter(
    (capability) =>
      (args.kind === "all" || capability.externalKind === args.kind) &&
      externalCapabilityMatchesQuery(capability, args.query)
  );
}

function makeRequestUrl(
  sourceUrl: string,
  args: { query?: string; kind?: ExternalCapabilityKindFilter; limit?: number }
): URL {
  const url = new URL(sourceUrl);
  const isSearchEndpoint = url.pathname.endsWith("/search");
  const isSkillsEndpoint = url.pathname.endsWith("/skills");
  const query =
    args.query?.trim() ||
    (isSearchEndpoint && args.kind && args.kind !== "all" ? args.kind : "");
  if (query) {
    url.searchParams.set("q", query);
  }
  if (args.kind && args.kind !== "all" && !isSearchEndpoint && !isSkillsEndpoint) {
    url.searchParams.set("kind", args.kind);
    url.searchParams.set("type", args.kind);
  }
  if (isSearchEndpoint || isSkillsEndpoint) {
    url.searchParams.set("nonSuspiciousOnly", "true");
  }
  if (args.limit) {
    url.searchParams.set("limit", String(args.limit));
  }
  return url;
}

function shouldVerifyDiscoveryResults(): boolean {
  return Boolean(readVerificationUrl()) || readBooleanEnv(process.env.OPENCLAW_VERIFY_DISCOVERY_RESULTS);
}

function readRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(Math.max(seconds * 1000, 250), MAX_DISCOVERY_RETRY_DELAY_MS);
    }
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) {
      return Math.min(Math.max(timestamp - Date.now(), 250), MAX_DISCOVERY_RETRY_DELAY_MS);
    }
  }
  return Math.min(300 * 2 ** attempt, MAX_DISCOVERY_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAbortLikeError(error: unknown): boolean {
  return (
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error &&
      (error.name === "AbortError" ||
        error.name === "TimeoutError" ||
        error.message === "This operation was aborted"))
  );
}

async function fetchWithDiscoveryRetry(
  url: URL,
  init: RequestInit
): Promise<Response> {
  const fetchOnce = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, DISCOVERY_FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw new Error("OpenClaw registry request timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  let response = await fetchOnce();
  for (let attempt = 0; attempt < MAX_DISCOVERY_RETRIES; attempt += 1) {
    if (!RETRYABLE_DISCOVERY_STATUS_CODES.has(response.status)) {
      return response;
    }
    await sleep(readRetryDelayMs(response, attempt));
    response = await fetchOnce();
  }
  return response;
}

function makeDefaultClawHubUrl(args: {
  query?: string;
  kind?: ExternalCapabilityKindFilter;
}): string {
  const baseUrl = readClawHubSite().replace(/\/$/, "");
  const query = args.query?.trim() ?? "";
  if (query) {
    return args.kind === "package"
      ? `${baseUrl}/api/v1/packages/search`
      : `${baseUrl}/api/v1/search`;
  }
  if (args.kind === "package") {
    return `${baseUrl}/api/v1/packages`;
  }
  if (args.kind === "tool" || args.kind === "task" || args.kind === "agent") {
    return `${baseUrl}/api/v1/search`;
  }
  return `${baseUrl}/api/v1/skills`;
}

function normalizeConfiguredRegistryUrl(
  sourceUrl: string,
  args: { query?: string; kind?: ExternalCapabilityKindFilter }
): string {
  const url = new URL(sourceUrl);
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (normalizedPath === "" || normalizedPath === "/api/v1") {
    const defaultUrl = new URL(makeDefaultClawHubUrl(args));
    url.pathname =
      normalizedPath === "/api/v1"
        ? `/api/v1${defaultUrl.pathname.replace(/^\/api\/v1/, "")}`
        : defaultUrl.pathname;
  }
  return url.toString();
}

function parseJsonOrText(sourceText: string): unknown {
  try {
    return JSON.parse(sourceText) as unknown;
  } catch {
    return sourceText;
  }
}

function readPayloadItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = asRecord(payload);
  if (!record) {
    return [];
  }
  return [
    ...asArray(record.capabilities),
    ...asArray(record.items),
    ...asArray(record.results),
  ];
}

function isManifestShape(payload: unknown): boolean {
  const record = asRecord(payload);
  return Boolean(
    record &&
      (Array.isArray(record.tools) ||
        Array.isArray(record.tasks) ||
        Array.isArray(record.skills) ||
        Array.isArray(record.agents) ||
        record.tool ||
        record.task ||
        record.skill ||
        record.agent)
  );
}

function normalizeRegistryItem(
  item: unknown,
  sourceUrl: string,
  checkedAt: string
): ExternalCapabilityRecord | null {
  const record = asRecord(item);
  if (!record) {
    return null;
  }
  const owner = asRecord(record.owner);
  const ownerHandle = asString(record.ownerHandle) || asString(owner?.handle);
  const slug = asString(record.slug) || asString(record.name);
  const family = asString(record.family).toLowerCase();
  const externalKind =
    family.includes("plugin") || family.includes("package")
      ? "package"
      : "skill";
  const latestVersion = asRecord(record.latestVersion);
  const tagsRecord = asRecord(record.tags);
  const normalized = normalizeExternalCapabilityRecord({
    ...record,
    provider: "openclaw",
    sourceId: asString(record.sourceId) || "clawhub",
    sourceLabel: asString(record.sourceLabel) || "ClawHub",
    externalKind: record.externalKind ?? record.kind ?? externalKind,
    externalId:
      asString(record.externalId) ||
      (ownerHandle && slug ? `@${ownerHandle}/${slug}` : slug),
    name:
      asString(record.name) ||
      asString(record.displayName) ||
      asString(record.title) ||
      slug,
    description:
      asString(record.description) ||
      asString(record.summary) ||
      asString(record.changelog),
    version:
      asString(record.version) ||
      asString(latestVersion?.version) ||
      undefined,
    tags: [
      ...asArray(record.topics).map(asString).filter(Boolean),
      ...Object.keys(tagsRecord ?? {}),
      ownerHandle,
      slug,
    ].filter(Boolean),
    verification:
      asRecord(record.verification) ??
      ({
        status: record.verified === true || record.live === true
          ? "verified_live"
          : "registry",
        checkedAt,
        source: sourceUrl,
        details:
          record.verified === true || record.live === true
            ? "Registry item declared itself live."
            : "Fetched from the configured OpenClaw registry.",
      } satisfies {
        status: ExternalCapabilityVerificationStatus;
        checkedAt: string;
        source: string;
        details: string;
      }),
  });
  return normalized;
}

function extractInputProperties(record: Record<string, unknown>): Record<string, unknown> {
  const schemaCandidates = [
    record.inputSchema,
    record.input_schema,
    record.parameters,
    record.params,
    record.schema,
  ];
  for (const candidate of schemaCandidates) {
    const schema = asRecord(candidate);
    if (!schema) {
      continue;
    }
    const nestedProperties =
      asRecord(schema.properties) ??
      asRecord(asRecord(schema.parameters)?.properties) ??
      asRecord(asRecord(schema.inputSchema)?.properties);
    if (nestedProperties && Object.keys(nestedProperties).length > 0) {
      return nestedProperties;
    }
    if (
      Object.values(schema).every(
        (value) => asRecord(value) && typeof asRecord(value)?.type === "string"
      )
    ) {
      return schema;
    }
  }
  return DEFAULT_TASK_INPUT_SCHEMA;
}

function collectManifestItems(payload: unknown): Array<{
  raw: Record<string, unknown>;
  fallbackKind: ExternalCapabilityKind;
}> {
  const root = asRecord(payload);
  if (!root) {
    return [];
  }
  const entries: Array<{ raw: Record<string, unknown>; fallbackKind: ExternalCapabilityKind }> = [];
  const pushItems = (items: unknown[], fallbackKind: ExternalCapabilityKind) => {
    for (const item of items) {
      const raw = asRecord(item);
      if (raw) {
        entries.push({ raw, fallbackKind });
      }
    }
  };
  pushItems(asArray(root.tools), "tool");
  pushItems(asArray(root.tasks), "task");
  pushItems(asArray(root.skills), "skill");
  pushItems(asArray(root.agents), "agent");
  for (const [key, fallbackKind] of [
    ["tool", "tool"],
    ["task", "task"],
    ["skill", "skill"],
    ["agent", "agent"],
  ] as const) {
    const raw = asRecord(root[key]);
    if (raw) {
      entries.push({ raw, fallbackKind });
    }
  }
  return entries;
}

function normalizeManifestItem(args: {
  raw: Record<string, unknown>;
  fallbackKind: ExternalCapabilityKind;
  sourceUrl: string;
  checkedAt: string;
  index: number;
}): ExternalCapabilityRecord | null {
  const kind = normalizeKind(args.raw.type ?? args.raw.kind ?? args.fallbackKind);
  const externalId =
    readString(args.raw, [
      "externalId",
      "id",
      "key",
      "name",
      "toolName",
      "tool_name",
      "skillName",
      "skill_name",
      "agentId",
      "agent_id",
    ]) || `${kind}_${args.index + 1}`;
  const name =
    readString(args.raw, ["name", "title", "displayName"]) || externalId;
  return normalizeExternalCapabilityRecord({
    provider: "openclaw",
    sourceId: "openclaw-registry",
    sourceLabel: "OpenClaw registry",
    externalKind: kind,
    externalId,
    externalAgentId: readString(args.raw, [
      "externalAgentId",
      "agentId",
      "agent_id",
      "agent",
      "targetAgentId",
    ]),
    name,
    description:
      readString(args.raw, [
        "description",
        "summary",
        "purpose",
        "instructions",
        "prompt",
        "task",
        "goal",
      ]) || `Imported OpenClaw ${kind}.`,
    endpoint: readString(args.raw, [
      "endpoint",
      "url",
      "taskEndpoint",
      "task_endpoint",
      "openclawEndpoint",
      "openclaw_endpoint",
    ]),
    executionMode: readString(args.raw, ["mode", "executionMode", "execution_mode"]),
    inputSchema: extractInputProperties(args.raw),
    tags: [
      ...asStringArray(args.raw.tags),
      ...asStringArray(args.raw.topics),
      "openclaw",
      kind,
    ],
    verification: {
      status: "registry",
      checkedAt: args.checkedAt,
      source: args.sourceUrl,
      details: "Fetched from a configured OpenClaw manifest.",
    },
  });
}

function normalizeCapabilitiesFromPayload(args: {
  payload: unknown;
  sourceUrl: string;
}): { capabilities: ExternalCapabilityRecord[]; warnings: string[] } {
  const checkedAt = new Date().toISOString();
  const items = readPayloadItems(args.payload);
  if (items.length > 0) {
    return {
      capabilities: items.flatMap((item) => {
        const normalized = normalizeRegistryItem(
          item,
          args.sourceUrl,
          checkedAt
        );
        return normalized ? [normalized] : [];
      }),
      warnings: [],
    };
  }

  if (isManifestShape(args.payload)) {
    return {
      capabilities: collectManifestItems(args.payload).flatMap((entry, index) => {
        const normalized = normalizeManifestItem({
          ...entry,
          sourceUrl: args.sourceUrl,
          checkedAt,
          index,
        });
        return normalized ? [normalized] : [];
      }),
      warnings: [],
    };
  }

  return {
    capabilities: [],
    warnings: ["OpenClaw registry response did not include recognizable capabilities."],
  };
}

function readClawHubSlug(capability: ExternalCapabilityRecord): string {
  const externalId = capability.externalId.trim();
  if (externalId.includes("/")) {
    return externalId.split("/").pop()?.trim() ?? externalId;
  }
  return externalId.replace(/^@/, "");
}

function verificationIsPositive(payload: unknown): boolean {
  const record = asRecord(payload);
  if (!record) {
    return true;
  }
  if (
    record.verified === true ||
    record.live === true ||
    record.exists === true ||
    record.ok === true
  ) {
    return true;
  }
  const status = asString(record.status).toLowerCase();
  return status === "verified" || status === "verified_live" || status === "live";
}

async function verifyCapability(
  capability: ExternalCapabilityRecord,
  verifyUrl: string
): Promise<ExternalCapabilityRecord> {
  const effectiveVerifyUrl =
    verifyUrl ||
    (capability.sourceId === "clawhub" && capability.externalKind === "skill"
      ? `${readClawHubSite().replace(/\/$/, "")}/api/v1/skills/${encodeURIComponent(
          readClawHubSlug(capability)
        )}/verify`
      : "");
  if (!effectiveVerifyUrl) {
    return capability;
  }

  const checkedAt = new Date().toISOString();
  try {
    const url = new URL(effectiveVerifyUrl);
    if (verifyUrl) {
      url.searchParams.set("provider", capability.provider);
      url.searchParams.set("sourceId", capability.sourceId);
      url.searchParams.set("kind", capability.externalKind);
      url.searchParams.set("externalId", capability.externalId);
      if (capability.externalAgentId) {
        url.searchParams.set("agentId", capability.externalAgentId);
      }
    }
    const response = await fetchWithDiscoveryRetry(url, {
      headers: makeHeaders(),
      cache: "no-store",
    });
    const sourceText = await response.text();
    const payload = sourceText ? parseJsonOrText(sourceText) : {};
    const verified = response.ok && verificationIsPositive(payload);
    return {
      ...capability,
      verification: {
        status: verified ? "verified_live" : "unverified",
        checkedAt,
        source: url.toString(),
        details: verified
          ? "Verified by the configured OpenClaw registry verification endpoint."
          : `Verification endpoint returned ${response.status}.`,
      },
    };
  } catch (error) {
    return {
      ...capability,
      verification: {
        status: "unverified",
        checkedAt,
        source: effectiveVerifyUrl,
        details:
          error instanceof Error
            ? error.message
            : "OpenClaw registry verification failed.",
      },
    };
  }
}

async function readRegistryCapabilities(args: {
  query?: string;
  kind?: ExternalCapabilityKindFilter;
  limit?: number;
}): Promise<{
  capabilities: ExternalCapabilityRecord[];
  warnings: string[];
  registryConfigured: boolean;
  verificationAvailable: boolean;
}> {
  const configuredSourceUrl = readConfiguredRegistryUrl();
  const verifyUrl = readVerificationUrl();

  let url: URL;
  try {
    const sourceUrl = configuredSourceUrl
      ? normalizeConfiguredRegistryUrl(configuredSourceUrl, args)
      : makeDefaultClawHubUrl(args);
    url = makeRequestUrl(sourceUrl, args);
  } catch {
    return {
      capabilities: [],
      warnings: ["Configured OpenClaw registry URL is not valid."],
      registryConfigured: true,
      verificationAvailable: Boolean(verifyUrl),
    };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      capabilities: [],
      warnings: ["Configured OpenClaw registry URL must use http or https."],
      registryConfigured: true,
      verificationAvailable: Boolean(verifyUrl),
    };
  }

  try {
    const response = await fetchWithDiscoveryRetry(url, {
      headers: makeHeaders(),
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        capabilities: [],
        warnings: [`OpenClaw registry returned ${response.status}.`],
        registryConfigured: true,
        verificationAvailable: Boolean(verifyUrl) || url.hostname === "clawhub.ai",
      };
    }
    const sourceText = await response.text();
    if (sourceText.length > MAX_DISCOVERY_TEXT_LENGTH) {
      return {
        capabilities: [],
        warnings: ["OpenClaw registry payload is too large."],
        registryConfigured: true,
        verificationAvailable: Boolean(verifyUrl) || url.hostname === "clawhub.ai",
      };
    }
    const normalized = normalizeCapabilitiesFromPayload({
      payload: parseJsonOrText(sourceText),
      sourceUrl: url.toString(),
    });
    const verifiedCapabilities = shouldVerifyDiscoveryResults()
      ? await Promise.all(
          normalized.capabilities.map((capability) =>
            verifyCapability(capability, verifyUrl)
          )
        )
      : normalized.capabilities;
    return {
      capabilities: verifiedCapabilities,
      warnings: normalized.warnings,
      registryConfigured: true,
      verificationAvailable: Boolean(verifyUrl) || url.hostname === "clawhub.ai",
    };
  } catch (error) {
    return {
      capabilities: [],
      warnings: [
        error instanceof Error
          ? error.message
          : "Failed to read OpenClaw registry.",
      ],
      registryConfigured: true,
      verificationAvailable: Boolean(verifyUrl) || url.hostname === "clawhub.ai",
    };
  }
}

function buildSampleCapabilities(): ExternalCapabilityRecord[] {
  if (!readBooleanEnv(process.env.OPENCLAW_DISCOVERY_INCLUDE_SAMPLES)) {
    return [];
  }
  return OPENCLAW_SAMPLE_ITEMS.flatMap((raw) => {
    const normalized = normalizeExternalCapabilityRecord({
      provider: "openclaw",
      ...raw,
    });
    return normalized ? [normalized] : [];
  });
}

export async function discoverOpenClawCapabilities(args: {
  query?: string;
  kind?: ExternalCapabilityKindFilter;
  limit?: number;
}): Promise<OpenClawDiscoveryResult> {
  const registry = await readRegistryCapabilities(args);
  const samples = buildSampleCapabilities();
  const byId = new Map<string, ExternalCapabilityRecord>();
  [...samples, ...registry.capabilities].forEach((capability) => {
    byId.set(capability.id, capability);
  });
  const sortedCapabilities = sortExternalCapabilities([...byId.values()]);
  const query = args.query ?? "";
  const kind = args.kind ?? "all";
  const filtered = filterExternalCapabilities({
    capabilities: sortedCapabilities,
    query,
    kind,
  });
  const shouldWidenSearch =
    filtered.length === 0 && query.trim() !== "" && kind !== "all";
  const widenedFiltered = shouldWidenSearch
    ? filterExternalCapabilities({
        capabilities: sortedCapabilities,
        query,
        kind: "all",
      })
    : filtered;
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(Math.floor(args.limit), 100))
      : DEFAULT_LIMIT;
  const sampleWarning =
    samples.length > 0
      ? ["Sample OpenClaw entries are enabled; they are not live registry objects."]
      : [];
  const widenedSearchWarning =
    shouldWidenSearch && widenedFiltered.length > 0
      ? [
          `No OpenClaw ${kind} results matched; showing matching results from other OpenClaw categories.`,
        ]
      : [];

  return {
    capabilities: widenedFiltered.slice(0, limit),
    warnings: [...registry.warnings, ...widenedSearchWarning, ...sampleWarning],
    sourceLabel: registry.registryConfigured
      ? "OpenClaw registry"
      : samples.length > 0
        ? "OpenClaw samples"
        : "ClawHub",
    registryConfigured: registry.registryConfigured,
    verificationAvailable: registry.verificationAvailable,
  };
}
