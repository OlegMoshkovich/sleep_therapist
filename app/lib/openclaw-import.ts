import { DEFAULT_OPENCLAW_BRIDGE_PATH } from "./agent-backends/types";
import type { CanvasDoc, CanvasEntry, CanvasNodeRecord } from "../components/canvas/types";
import {
  createEmptyOrchestrationAgentConnection,
  createEmptyOrchestrationProject,
  makeOrchestrationId,
  slugify,
  syncDerivedPrompts,
  type OrchestrationProject,
  type OrchestrationSkill,
} from "./general-orchestration";
import { ensureDaemonConversationProject } from "./general-orchestration-daemon-drafts";

export type OpenClawImportArtifactKind =
  | "tool"
  | "task"
  | "skill"
  | "agent"
  | "unknown";

export interface OpenClawImportArtifactPreview {
  id: string;
  kind: OpenClawImportArtifactKind;
  name: string;
  description: string;
  agentId?: string;
  endpoint: string;
  executionMode: "sync" | "async";
  inputSchema: Record<string, unknown>;
  mappedAs: "tool_call" | "skill" | "agent" | "canvas_note";
}

export interface OpenClawImportPreview {
  title: string;
  summary: string;
  artifacts: OpenClawImportArtifactPreview[];
  warnings: string[];
  project: OrchestrationProject;
}

interface NormalizedOpenClawArtifact {
  id: string;
  kind: OpenClawImportArtifactKind;
  name: string;
  description: string;
  endpoint: string;
  agentId: string;
  mode: "sync" | "async";
  inputProperties: Record<string, unknown>;
  raw: Record<string, unknown>;
}

const DEFAULT_OPENCLAW_TOOL_PROPERTIES = {
  task: {
    type: "string",
    description:
      "The concrete task or goal to delegate to the OpenClaw-compatible backend.",
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function readStringArray(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean);
    }
  }
  return [];
}

function normalizeKind(value: unknown, fallback: OpenClawImportArtifactKind): OpenClawImportArtifactKind {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    normalized === "tool" ||
    normalized === "task" ||
    normalized === "skill" ||
    normalized === "agent"
  ) {
    return normalized;
  }
  return fallback;
}

function makeStableName(
  record: Record<string, unknown>,
  fallbackKind: OpenClawImportArtifactKind,
  index: number
): string {
  const explicit = readString(record, [
    "name",
    "title",
    "id",
    "toolName",
    "tool_name",
    "skillName",
    "skill_name",
    "agentId",
    "agent_id",
  ]);
  if (explicit) {
    return explicit;
  }
  return `Imported OpenClaw ${fallbackKind === "unknown" ? "artifact" : fallbackKind} ${index + 1}`;
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

  return DEFAULT_OPENCLAW_TOOL_PROPERTIES;
}

function readEndpoint(record: Record<string, unknown>, fallback = DEFAULT_OPENCLAW_BRIDGE_PATH): string {
  return (
    readString(record, [
      "endpoint",
      "url",
      "taskEndpoint",
      "task_endpoint",
      "openclawEndpoint",
      "openclaw_endpoint",
    ]) || fallback
  );
}

function normalizeArtifact(
  raw: unknown,
  fallbackKind: OpenClawImportArtifactKind,
  index: number,
  inherited: {
    endpoint?: string;
    agentId?: string;
  } = {}
): NormalizedOpenClawArtifact | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const kind = normalizeKind(record.type ?? record.kind ?? record.artifactType, fallbackKind);
  const name = makeStableName(record, kind, index);
  const description =
    readString(record, [
      "description",
      "summary",
      "purpose",
      "instructions",
      "prompt",
      "task",
      "goal",
    ]) || `Imported OpenClaw ${kind}.`;
  const agentId =
    readString(record, ["agentId", "agent_id", "agent", "targetAgentId"]) ||
    inherited.agentId;
  const endpoint = readEndpoint(record, inherited.endpoint ?? DEFAULT_OPENCLAW_BRIDGE_PATH);
  const modeRaw = readString(record, ["mode", "executionMode", "execution_mode"]);
  const mode = modeRaw === "sync" ? "sync" : "async";

  return {
    id: readString(record, ["id", "key"]) || `${kind}-${index + 1}`,
    kind,
    name,
    description,
    endpoint,
    agentId: agentId ?? "",
    mode,
    inputProperties: extractInputProperties(record),
    raw: record,
  };
}

function pushArtifact(
  artifacts: NormalizedOpenClawArtifact[],
  raw: unknown,
  fallbackKind: OpenClawImportArtifactKind,
  inherited: { endpoint?: string; agentId?: string } = {}
) {
  const artifact = normalizeArtifact(raw, fallbackKind, artifacts.length, inherited);
  if (artifact) {
    artifacts.push(artifact);
  }
}

function collectArtifactsFromManifest(raw: unknown): NormalizedOpenClawArtifact[] {
  const artifacts: NormalizedOpenClawArtifact[] = [];
  const root = asRecord(raw);

  if (Array.isArray(raw)) {
    raw.forEach((item) => pushArtifact(artifacts, item, "unknown"));
    return artifacts;
  }

  if (!root) {
    return artifacts;
  }

  asArray(root.tools).forEach((item) => pushArtifact(artifacts, item, "tool"));
  asArray(root.tasks).forEach((item) => pushArtifact(artifacts, item, "task"));
  asArray(root.skills).forEach((item) => pushArtifact(artifacts, item, "skill"));
  asArray(root.agents).forEach((item) => {
    const agent = normalizeArtifact(item, "agent", artifacts.length);
    if (!agent) {
      return;
    }
    artifacts.push(agent);
    const nested = asRecord(item);
    const inherited = { endpoint: agent.endpoint, agentId: agent.agentId || agent.id };
    asArray(nested?.tools).forEach((tool) => pushArtifact(artifacts, tool, "tool", inherited));
    asArray(nested?.tasks).forEach((task) => pushArtifact(artifacts, task, "task", inherited));
    asArray(nested?.skills).forEach((skill) => pushArtifact(artifacts, skill, "skill", inherited));
  });

  if (root.tool) {
    pushArtifact(artifacts, root.tool, "tool");
  }
  if (root.task) {
    pushArtifact(artifacts, root.task, "task");
  }
  if (root.skill) {
    pushArtifact(artifacts, root.skill, "skill");
  }
  if (root.agent) {
    pushArtifact(artifacts, root.agent, "agent");
  }

  if (artifacts.length === 0) {
    pushArtifact(artifacts, root, normalizeKind(root.type ?? root.kind, "task"));
  }

  return artifacts;
}

function parseSourceText(sourceText: string): { raw: unknown; warnings: string[] } {
  const trimmed = sourceText.trim();
  if (!trimmed) {
    return {
      raw: {
        type: "task",
        name: "OpenClaw delegated task",
        task: "Delegate the user request to OpenClaw.",
      },
      warnings: ["No manifest text was provided, so a placeholder delegated task was generated."],
    };
  }

  try {
    return { raw: JSON.parse(trimmed) as unknown, warnings: [] };
  } catch {
    return {
      raw: {
        type: "task",
        name: "OpenClaw delegated task",
        task: trimmed,
      },
      warnings: [
        "The import text was not valid JSON. It was treated as a plain OpenClaw task description.",
      ],
    };
  }
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

function buildOpenClawPolicyCanvas(
  artifact: NormalizedOpenClawArtifact,
  index: number,
  nameSuffix = ""
): CanvasEntry {
  const start = makeNode("start", "Start", 0, 0);
  const prepare = makeNode(
    "prompt",
    `Prepare the OpenClaw task input for ${artifact.name}.`,
    0,
    140,
    {
      actionType: "prompt",
      actionTypeSource: "openclaw_import",
    }
  );
  const tool = makeNode(
    "tool_call",
    `Delegate to OpenClaw: ${artifact.name}`,
    0,
    300,
    {
      actionType: "tool_call",
      actionTypeSource: "openclaw_import",
      toolName: normalizeToolName(artifact.name, `openclaw_${artifact.kind}_${index + 1}`),
      description: artifact.description,
      resultVariable: `${normalizeToolName(artifact.name, `openclaw_${index + 1}`)}_job`,
      sourceType: "openclaw",
      url: artifact.endpoint,
      executionMode: "async",
      asyncContinuationPolicy: "fork_yield",
      paramsSchema: JSON.stringify(artifact.inputProperties, null, 2),
      openclaw: {
        agentId: artifact.agentId || undefined,
        mode: artifact.mode,
        responseFormat: "json",
      },
    }
  );
  const yieldNode = makeNode(
    "yield",
    "OpenClaw work started; continue when the delegated job is ready.",
    0,
    460
  );

  return {
    id: `openclaw_import_${index + 1}${nameSuffix}`,
    name: artifact.name,
    freeText: [
      `Imported OpenClaw ${artifact.kind}: ${artifact.name}`,
      artifact.description,
      artifact.agentId ? `Target OpenClaw agent: ${artifact.agentId}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    graph: {
      nodes: [start, prepare, tool, yieldNode],
      edges: [
        { id: makeOrchestrationId(), source: start.id, target: prepare.id },
        { id: makeOrchestrationId(), source: prepare.id, target: tool.id },
        { id: makeOrchestrationId(), source: tool.id, target: yieldNode.id },
      ],
    },
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

function buildSkillFromArtifact(
  artifact: NormalizedOpenClawArtifact,
  index: number
): OrchestrationSkill {
  const policyCanvas = buildOpenClawPolicyCanvas(artifact, index, "_skill");
  return {
    id: makeOrchestrationId(),
    name: artifact.name,
    startConditionCanvases: buildConditionCanvas(
      `${artifact.name} start condition`,
      "message contains request"
    ),
    policyPrompt: "",
    policyCanvases: {
      version: 2,
      activeId: policyCanvas.id,
      canvases: [policyCanvas],
    },
    terminationConditionCanvases: buildConditionCanvas(
      `${artifact.name} termination condition`,
      "delegated OpenClaw job is completed"
    ),
  };
}

function buildProjectFromArtifacts(
  artifacts: NormalizedOpenClawArtifact[],
  warnings: string[]
): OrchestrationProject {
  const base = ensureDaemonConversationProject(createEmptyOrchestrationProject());
  const primaryAgent = artifacts.find((artifact) => artifact.kind === "agent");
  const callableArtifacts = artifacts.filter(
    (artifact) => artifact.kind === "tool" || artifact.kind === "task"
  );
  const skillArtifacts = artifacts.filter((artifact) => artifact.kind === "skill");
  const title =
    primaryAgent?.name ||
    callableArtifacts[0]?.name ||
    skillArtifacts[0]?.name ||
    "Imported OpenClaw Project";
  const canvases = callableArtifacts.length > 0
    ? callableArtifacts.map((artifact, index) => buildOpenClawPolicyCanvas(artifact, index))
    : [
        buildOpenClawPolicyCanvas(
          {
            id: "openclaw_placeholder",
            kind: "task",
            name: "OpenClaw delegated task",
            description: "Delegate future user requests to OpenClaw.",
            endpoint: DEFAULT_OPENCLAW_BRIDGE_PATH,
            agentId: primaryAgent?.agentId || primaryAgent?.id || "",
            mode: "async",
            inputProperties: DEFAULT_OPENCLAW_TOOL_PROPERTIES,
            raw: {},
          },
          0
        ),
      ];
  const skills = skillArtifacts.map((artifact, index) =>
    buildSkillFromArtifact(artifact, callableArtifacts.length + index)
  );

  const additionalAgents = artifacts
    .filter((artifact) => artifact.kind === "agent")
    .slice(primaryAgent ? 1 : 0);
  const sourceAgentId = primaryAgent?.agentId || base.agentId;
  const agentConnections = additionalAgents.map((agent) => {
    const targetPolicyCanvas = buildOpenClawPolicyCanvas(agent, 0, "_agent");
    return createEmptyOrchestrationAgentConnection({
      sourceAgentId,
      targetAgentId: agent.agentId || slugify(agent.name).replace(/-/g, "_") || agent.id,
      targetAgentTitle: agent.name,
      purpose: agent.description,
      invocationMode: "async",
      targetPolicyCanvases: {
        version: 2,
        activeId: targetPolicyCanvas.id,
        canvases: [targetPolicyCanvas],
      },
      targetPolicyPrompt: agent.description,
    });
  });

  const project = ensureDaemonConversationProject({
    ...base,
    agentId: sourceAgentId,
    meta: {
      ...base.meta,
      title,
      slug: slugify(title) || base.meta.slug,
      summary: `Imported from OpenClaw with ${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}.`,
      policyIntent:
        primaryAgent?.description ||
        `Represent imported OpenClaw tools, skills, agents, and tasks as editable Airlab canvases.`,
      status: warnings.length > 0
        ? "Imported from OpenClaw with review warnings."
        : "Imported from OpenClaw preview.",
    },
    policyCanvases: {
      version: 2,
      activeId: canvases[0]?.id ?? "openclaw_import_1",
      canvases,
    },
    policyPrompt: "",
    skills,
    agentConnections,
  });

  return syncDerivedPrompts(project);
}

export function buildOpenClawImportPreview(args: {
  sourceText: string;
  sourceLabel?: string;
}): OpenClawImportPreview {
  const parsed = parseSourceText(args.sourceText);
  const artifacts = collectArtifactsFromManifest(parsed.raw);
  const warnings = [...parsed.warnings];

  if (artifacts.length === 0) {
    warnings.push("No OpenClaw artifacts were recognized.");
  }

  artifacts.forEach((artifact) => {
    if (artifact.endpoint === DEFAULT_OPENCLAW_BRIDGE_PATH) {
      warnings.push(
        `${artifact.name} uses the built-in OpenClaw bridge endpoint. Configure the bridge upstream before running it.`
      );
    }
    if (artifact.kind === "unknown") {
      warnings.push(`${artifact.name} has an unknown artifact kind and was imported as a canvas note.`);
    }
  });

  const project = buildProjectFromArtifacts(artifacts, warnings);
  const artifactPreviews: OpenClawImportArtifactPreview[] = artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    name: artifact.name,
    description: artifact.description,
    agentId: artifact.agentId || undefined,
    endpoint: artifact.endpoint,
    executionMode: artifact.mode,
    inputSchema: artifact.inputProperties,
    mappedAs:
      artifact.kind === "skill"
        ? "skill"
        : artifact.kind === "agent"
          ? "agent"
          : artifact.kind === "unknown"
            ? "canvas_note"
            : "tool_call",
  }));

  return {
    title: project.meta.title,
    summary:
      args.sourceLabel?.trim() ||
      `Preview import for ${artifactPreviews.length || 1} OpenClaw artifact${artifactPreviews.length === 1 ? "" : "s"}.`,
    artifacts: artifactPreviews,
    warnings: Array.from(new Set(warnings)),
    project,
  };
}
