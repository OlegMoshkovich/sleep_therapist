import { DEFAULT_OPENCLAW_BRIDGE_PATH } from "./agent-backends/types";
import type { CanvasDoc, CanvasEntry, CanvasNodeRecord } from "../components/canvas/types";
import {
  createEmptyOrchestrationAgentConnection,
  createEmptyOrchestrationProject,
  makeOrchestrationId,
  slugify,
  syncAgentConnectionDerivedPrompts,
  syncDerivedPrompts,
  type OrchestrationAgentConnection,
  type OrchestrationProject,
  type OrchestrationSkill,
} from "./general-orchestration";
import { ensureDaemonConversationProject } from "./general-orchestration-daemon-drafts";
import type { OpenClawImportPreview } from "./openclaw-import";

export const EXTERNAL_CAPABILITY_CATALOG_STORAGE_KEY =
  "general-orchestration-daemon.externalCapabilityCatalog.v1";

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

export type ExternalCapabilityKindFilter = ExternalCapabilityKind | "all";

const DEFAULT_TASK_INPUT_SCHEMA = {
  task: {
    type: "string",
    description: "The concrete task or request to delegate.",
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => asString(item)).filter(Boolean)
    : [];
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
    tags: Array.from(
      new Set(
        [
          provider,
          externalKind,
          ...asStringArray(record.tags),
          ...name.split(/\s+/),
        ]
          .map(normalizeTag)
          .filter(Boolean)
      )
    ),
    auth: {
      type: normalizeAuthType(asRecord(record.auth)?.type),
      status: normalizeAuthStatus(asRecord(record.auth)?.status),
      label: asString(asRecord(record.auth)?.label) || undefined,
    },
    verification: verificationStatus
      ? {
          status: verificationStatus,
          checkedAt:
            asString(rawVerification?.checkedAt) ||
            asString(record.verificationCheckedAt) ||
            undefined,
          source:
            asString(rawVerification?.source) ||
            asString(record.verificationSource) ||
            undefined,
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
    const kindSort = a.externalKind.localeCompare(b.externalKind);
    return kindSort || a.name.localeCompare(b.name);
  });
}

export function readExternalCapabilityCatalogFromStorage(
  storage?: Storage | null
): ExternalCapabilityRecord[] {
  const targetStorage =
    storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!targetStorage) {
    return [];
  }
  try {
    const raw = targetStorage.getItem(EXTERNAL_CAPABILITY_CATALOG_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
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
  storage?: Storage | null
) {
  const targetStorage =
    storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!targetStorage) {
    return;
  }
  targetStorage.setItem(
    EXTERNAL_CAPABILITY_CATALOG_STORAGE_KEY,
    JSON.stringify(sortExternalCapabilities(capabilities))
  );
}

export function upsertExternalCapabilities(
  current: ExternalCapabilityRecord[],
  incoming: ExternalCapabilityRecord[]
): ExternalCapabilityRecord[] {
  const byId = new Map(current.map((capability) => [capability.id, capability]));
  const now = new Date().toISOString();
  incoming.forEach((capability) => {
    const previous = byId.get(capability.id);
    byId.set(capability.id, {
      ...previous,
      ...capability,
      createdAt: previous?.createdAt ?? capability.createdAt,
      updatedAt: now,
    });
  });
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
  const haystack = [
    capability.name,
    capability.description,
    capability.provider,
    capability.sourceLabel,
    capability.externalKind,
    capability.externalId,
    capability.endpoint,
    capability.version ?? "",
    capability.verification?.status ?? "",
    capability.verification?.source ?? "",
    capability.verification?.details ?? "",
    capability.tags.join(" "),
  ]
    .join(" ")
    .toLowerCase();
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => haystack.includes(part));
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

export function buildExternalCapabilitiesFromOpenClawPreview(args: {
  preview: OpenClawImportPreview;
  sourceId?: string;
  sourceLabel?: string;
}): ExternalCapabilityRecord[] {
  const sourceId =
    args.sourceId?.trim() ||
    slugify(args.sourceLabel || args.preview.title || "openclaw-source");
  const sourceLabel =
    args.sourceLabel?.trim() || args.preview.title || "OpenClaw source";
  const now = new Date().toISOString();

  return args.preview.artifacts.flatMap((artifact) => {
    const externalKind = normalizeKind(artifact.kind);
    const externalId =
      externalKind === "agent"
        ? artifact.agentId || artifact.id || artifact.name
        : artifact.id || artifact.name;
    const record = normalizeExternalCapabilityRecord({
      provider: "openclaw",
      sourceId,
      sourceLabel,
      externalKind,
      externalId,
      externalAgentId: artifact.agentId,
      name: artifact.name,
      description: artifact.description,
      endpoint: artifact.endpoint,
      executionMode: artifact.executionMode ?? "async",
      inputSchema: artifact.inputSchema,
      tags: [artifact.kind, artifact.mappedAs],
      auth: {
        type: "bearer",
        status: "unknown",
        label: "OpenClaw bridge token",
      },
      createdAt: now,
      updatedAt: now,
    });
    return record ? [record] : [];
  });
}

function normalizeToolName(value: string, fallback: string): string {
  const candidate =
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_") || fallback;
  return /^[a-z_]/.test(candidate) ? candidate : `tool_${candidate}`;
}

function makeNode(
  type: string,
  label: string,
  x: number,
  y: number,
  data: Record<string, unknown> = {}
): CanvasNodeRecord {
  return {
    id: makeOrchestrationId(),
    type,
    position: { x, y },
    data: {
      label,
      ...data,
    },
  };
}

function makeExternalCapabilityRef(capability: ExternalCapabilityRecord) {
  return {
    id: capability.id,
    provider: capability.provider,
    sourceId: capability.sourceId,
    externalKind: capability.externalKind,
    externalId: capability.externalId,
    version: capability.version,
  };
}

function buildExternalToolCanvas(
  capability: ExternalCapabilityRecord,
  index: number
): CanvasEntry {
  const start = makeNode("start", "Start", 0, 0);
  const prepare = makeNode(
    "prompt",
    `Prepare the request for ${capability.name}.`,
    0,
    140,
    {
      actionType: "prompt",
      actionTypeSource: "external_capability_wrapper",
    }
  );
  const toolName = normalizeToolName(
    capability.name,
    `external_${capability.externalKind}_${index + 1}`
  );
  const tool = makeNode(
    "tool_call",
    `Use external ${capability.externalKind}: ${capability.name}`,
    0,
    300,
    {
      actionType: "tool_call",
      actionTypeSource: "external_capability_wrapper",
      toolName,
      description: capability.description,
      resultVariable: `${toolName}_result`,
      sourceType: capability.provider === "openclaw" ? "openclaw" : "http",
      url: capability.endpoint,
      executionMode: capability.executionMode,
      ...(capability.executionMode === "async"
        ? { asyncContinuationPolicy: "fork_yield" }
        : {}),
      paramsSchema: JSON.stringify(capability.inputSchema, null, 2),
      externalCapability: makeExternalCapabilityRef(capability),
      ...(capability.provider === "openclaw"
        ? {
            openclaw: {
              agentId:
                capability.externalAgentId ||
                (capability.externalKind === "agent"
                  ? capability.externalId
                  : undefined),
              mode: capability.executionMode,
              responseFormat: "json",
            },
          }
        : {}),
    }
  );
  const yieldNode =
    capability.executionMode === "async"
      ? [
          makeNode(
            "yield",
            `${capability.name} is running externally; continue when the result is ready.`,
            0,
            460
          ),
        ]
      : [];

  return {
    id: `external_capability_${index + 1}`,
    name: capability.name,
    freeText: [
      `${capability.provider} ${capability.externalKind}: ${capability.externalId}`,
      capability.description,
      capability.version ? `Version: ${capability.version}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    graph: {
      nodes: [start, prepare, tool, ...yieldNode],
      edges: [
        { id: makeOrchestrationId(), source: start.id, target: prepare.id },
        { id: makeOrchestrationId(), source: prepare.id, target: tool.id },
        ...(yieldNode[0]
          ? [{ id: makeOrchestrationId(), source: tool.id, target: yieldNode[0].id }]
          : []),
      ],
    },
  };
}

function buildExternalAgentCallCanvas(
  capability: ExternalCapabilityRecord,
  index: number
): CanvasEntry {
  const start = makeNode("start", "Start", 0, 0);
  const callAgent = makeNode(
    "call_agent",
    `Ask ${capability.name} to handle the relevant external work.`,
    0,
    150,
    {
      actionType: "call_agent",
      actionTypeSource: "external_capability_wrapper",
      targetAgentId: capability.externalId,
      callAgentType: capability.provider,
      backendType: capability.provider,
      url: capability.endpoint,
      executionMode: capability.executionMode,
      backend: {
        mode: capability.executionMode,
        responseFormat: "json",
      },
      externalCapability: makeExternalCapabilityRef(capability),
    }
  );
  const yieldNode =
    capability.executionMode === "async"
      ? [
          makeNode(
            "yield",
            `${capability.name} is running externally; continue when the turn is ready.`,
            0,
            310
          ),
        ]
      : [];

  return {
    id: `external_agent_${index + 1}`,
    name: capability.name,
    freeText: [
      `${capability.provider} agent wrapper: ${capability.externalId}`,
      capability.description,
    ]
      .filter(Boolean)
      .join("\n\n"),
    graph: {
      nodes: [start, callAgent, ...yieldNode],
      edges: [
        { id: makeOrchestrationId(), source: start.id, target: callAgent.id },
        ...(yieldNode[0]
          ? [{ id: makeOrchestrationId(), source: callAgent.id, target: yieldNode[0].id }]
          : []),
      ],
    },
  };
}

function buildCanvasDoc(canvases: CanvasEntry[]): CanvasDoc | null {
  if (canvases.length === 0) {
    return null;
  }
  return {
    version: 2,
    activeId: canvases[0].id,
    canvases,
  };
}

function buildConditionCanvas(name: string, label: string): CanvasDoc {
  const start = makeNode("start", "Start", 0, 0);
  const condition = makeNode("condition", label, 0, 140);
  return {
    version: 2,
    activeId: `${slugify(name) || "condition"}_canvas`,
    canvases: [
      {
        id: `${slugify(name) || "condition"}_canvas`,
        name,
        freeText: "",
        graph: {
          nodes: [start, condition],
          edges: [{ id: makeOrchestrationId(), source: start.id, target: condition.id }],
        },
      },
    ],
  };
}

function buildExternalSkill(
  capability: ExternalCapabilityRecord,
  index: number
): OrchestrationSkill {
  const policyCanvas = buildExternalToolCanvas(capability, index);
  return {
    id: makeOrchestrationId(),
    name: capability.name,
    startConditionCanvases: buildConditionCanvas(
      `${capability.name} start condition`,
      `the user request needs ${capability.name}`
    ),
    policyPrompt: "",
    policyCanvases: buildCanvasDoc([policyCanvas]),
    terminationConditionCanvases: buildConditionCanvas(
      `${capability.name} termination condition`,
      `${capability.name} returned a sufficient result`
    ),
  };
}

function makeLocalAgentId(
  capability: ExternalCapabilityRecord,
  index: number,
  used: Set<string>
): string {
  const base =
    slugify(capability.name || capability.externalId)
      .replace(/-/g, "_")
      .replace(/^_+|_+$/g, "") || `external_agent_${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function buildExternalAgentConnection(args: {
  capability: ExternalCapabilityRecord;
  sourceAgentId: string;
  index: number;
  usedAgentIds: Set<string>;
}): OrchestrationAgentConnection {
  const canvas = buildExternalAgentCallCanvas(args.capability, args.index);
  const policyCanvases = buildCanvasDoc([canvas]);
  return syncAgentConnectionDerivedPrompts(
    createEmptyOrchestrationAgentConnection({
      sourceAgentId: args.sourceAgentId,
      targetAgentId: makeLocalAgentId(
        args.capability,
        args.index,
        args.usedAgentIds
      ),
      targetAgentTitle: args.capability.name,
      purpose: args.capability.description,
      invocationMode: args.capability.executionMode,
      sourcePolicyPrompt: args.capability.description,
      sourcePolicyCanvases: policyCanvases,
      targetPolicyPrompt: args.capability.description,
      targetPolicyCanvases: policyCanvases,
      policyPrompt: args.capability.description,
      policyCanvases,
    })
  );
}

export function buildExternalCapabilitySeedProject(args: {
  capabilities: ExternalCapabilityRecord[];
  title?: string;
}): OrchestrationProject {
  const base = ensureDaemonConversationProject(createEmptyOrchestrationProject());
  const capabilities = sortExternalCapabilities(args.capabilities);
  const sourceAgentId =
    slugify(args.title || capabilities[0]?.name || "external-capability-agent")
      .replace(/-/g, "_")
      .replace(/^_+|_+$/g, "") || base.agentId;
  const primaryCanvases = capabilities.flatMap((capability, index) => {
    if (capability.externalKind === "tool" || capability.externalKind === "task") {
      return [buildExternalToolCanvas(capability, index)];
    }
    if (capability.externalKind === "agent") {
      return [buildExternalAgentCallCanvas(capability, index)];
    }
    return [];
  });
  const skills = capabilities
    .filter((capability) => capability.externalKind === "skill")
    .map((capability, index) => buildExternalSkill(capability, index));
  const usedAgentIds = new Set<string>([sourceAgentId]);
  const agentConnections = capabilities
    .filter((capability) => capability.externalKind === "agent")
    .map((capability, index) =>
      buildExternalAgentConnection({
        capability,
        sourceAgentId,
        index,
        usedAgentIds,
      })
    );
  const title =
    args.title?.trim() ||
    (capabilities.length === 1
      ? capabilities[0].name
      : "External Capability Project");

  return syncDerivedPrompts(
    ensureDaemonConversationProject({
      ...base,
      agentId: sourceAgentId,
      meta: {
        ...base.meta,
        title,
        slug: slugify(title),
        summary:
          capabilities.length === 0
            ? "No external capabilities selected."
            : `Seeded from ${capabilities.length} external capability wrapper${
                capabilities.length === 1 ? "" : "s"
              }.`,
        policyIntent:
          capabilities.length === 0
            ? ""
            : `Use selected external capability wrappers directly: ${capabilities
                .map((capability) => capability.name)
                .join(", ")}.`,
        status: "Seeded from external capability wrappers.",
      },
      policyCanvases: buildCanvasDoc(primaryCanvases),
      policyPrompt: "",
      skills,
      agentConnections,
    })
  );
}
