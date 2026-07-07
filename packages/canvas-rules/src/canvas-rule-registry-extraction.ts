import type { CanvasDoc, CanvasNodeRecord } from "@airlab/canvas-compiler/types";
import { getNodeActionSubtype } from "@airlab/canvas-core/components/canvas/action-subtype";
import {
  getSeededCanvasRuleDefinitions,
  replaceCanvasRuleRegistryDataset,
  type CanvasRuleDeclarativeCheck,
  type CanvasRuleDefinition,
  type CanvasRuleScope,
} from "@airlab/canvas-core/lib/canvas-rule-registry";

interface PolicyCanvasRuleSource {
  canvasId: string;
  canvasName: string;
  nodeId?: string;
  nodeLabel?: string;
  kind: "canvas_notes" | "prompt_node";
  text: string;
  sourceHash: string;
}

interface ExtractedRuleRecord {
  id?: unknown;
  title?: unknown;
  scope?: unknown;
  description?: unknown;
  repairGuidance?: unknown;
  repair_guidance?: unknown;
  check?: unknown;
  sourceCanvasId?: unknown;
  sourceCanvasName?: unknown;
  sourceNodeId?: unknown;
  sourceNodeLabel?: unknown;
}

const MAX_POLICY_RULE_SOURCES = 90;
const MAX_POLICY_RULE_SOURCE_TEXT_LENGTH = 1400;
const MAX_EXTRACTED_POLICY_RULES = 30;

type CanvasRuleRegistryDatasets = Parameters<typeof replaceCanvasRuleRegistryDataset>[0];

export interface CanvasRuleRegistryOpenAIClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        max_completion_tokens: number;
        messages: Array<{ role: "system" | "user"; content: string }>;
      }): Promise<{
        choices: Array<{ message?: { content?: string | null } | null }>;
      }>;
    };
  };
}

export interface CanvasRuleRegistryProjectShape {
  policyCanvases: CanvasDoc | null;
  datasets?: CanvasRuleRegistryDatasets | null;
}

export interface RefreshDerivedCanvasRuleRegistryConfig<
  TProject extends CanvasRuleRegistryProjectShape,
> {
  openai: CanvasRuleRegistryOpenAIClient;
  project: TProject;
  model: string;
  maxCompletionTokens: number;
  makeId: () => string;
}

function extractFirstJsonObject(text: string): string | null {
  const normalized = text.trim();
  const startIndex = normalized.indexOf("{");

  if (startIndex === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < normalized.length; index += 1) {
    const char = normalized[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return normalized.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}
function parseJsonObject<T>(text: string): T | null {
  const objectText = extractFirstJsonObject(text);
  if (!objectText) {
    return null;
  }

  try {
    return JSON.parse(objectText) as T;
  } catch {
    return null;
  }
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function stableSourceHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

function normalizeGeneratedRuleId(rawId: string, title: string): string {
  const base = normalizeId(rawId) || normalizeId(title);
  if (!base) {
    return "";
  }
  return base.startsWith("daemon_policy_") ? base : `daemon_policy_${base}`;
}

function normalizeScope(value: unknown): CanvasRuleScope {
  const normalized = asString(value).toLowerCase();
  if (
    normalized === "policy" ||
    normalized === "state" ||
    normalized === "workflow"
  ) {
    return normalized;
  }
  return "both";
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function parseScalarValue(value: unknown): string | number | boolean | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}

function parseDeclarativeCheck(
  value: unknown
): CanvasRuleDeclarativeCheck | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (asString(record.kind).toLowerCase() !== "node_count") {
    return undefined;
  }

  const nodeType = asString(record.nodeType || record.node_type);
  if (!nodeType) {
    return undefined;
  }

  const check: CanvasRuleDeclarativeCheck = {
    kind: "node_count",
    nodeType,
  };
  const equals = parseOptionalNumber(record.equals);
  const min = parseOptionalNumber(record.min);
  const max = parseOptionalNumber(record.max);
  if (equals !== undefined) {
    check.equals = equals;
  }
  if (min !== undefined) {
    check.min = min;
  }
  if (max !== undefined) {
    check.max = max;
  }

  const dataMatchesValue =
    record.dataMatches ?? record.data_matches ?? record.nodeData ?? record.node_data;
  if (Array.isArray(dataMatchesValue)) {
    const dataMatches = dataMatchesValue.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }
      const itemRecord = item as Record<string, unknown>;
      const key = asString(itemRecord.key || itemRecord.path);
      const equals = parseScalarValue(itemRecord.equals);
      const notEquals = parseScalarValue(
        itemRecord.notEquals ?? itemRecord.not_equals
      );
      return key && (equals !== undefined || notEquals !== undefined)
        ? [
            {
              key,
              ...(equals !== undefined ? { equals } : {}),
              ...(notEquals !== undefined ? { notEquals } : {}),
            },
          ]
        : [];
    });
    if (dataMatches.length > 0) {
      check.dataMatches = dataMatches;
    }
  }

  const whenStateFieldValue =
    record.whenStateField ?? record.when_state_field;
  if (
    whenStateFieldValue &&
    typeof whenStateFieldValue === "object" &&
    !Array.isArray(whenStateFieldValue)
  ) {
    const conditionRecord = whenStateFieldValue as Record<string, unknown>;
    const fieldNames = parseStringList(
      conditionRecord.fieldNames ??
        conditionRecord.field_names ??
        conditionRecord.fieldName ??
        conditionRecord.field_name
    );
    const fieldTypes = parseStringList(
      conditionRecord.fieldTypes ??
        conditionRecord.field_types ??
        conditionRecord.fieldType ??
        conditionRecord.field_type
    );
    if (fieldNames.length > 0 || fieldTypes.length > 0) {
      check.whenStateField = {
        ...(fieldNames.length > 0 ? { fieldNames } : {}),
        ...(fieldTypes.length > 0 ? { fieldTypes } : {}),
      };
    }
  }

  return check.equals === undefined &&
    check.min === undefined &&
    check.max === undefined
    ? undefined
    : check;
}

function isPolicyRuleSourceNode(node: CanvasNodeRecord): boolean {
  const subtype = getNodeActionSubtype(node);
  return (
    node.type === "prompt" ||
    subtype === "prompt" ||
    subtype === "prompt_transform"
  );
}

function collectPolicyCanvasRuleSources(
  doc: CanvasDoc | null
): PolicyCanvasRuleSource[] {
  if (!doc) {
    return [];
  }

  const sources: PolicyCanvasRuleSource[] = [];
  for (const canvas of doc.canvases) {
    const notes = normalizeWhitespace(canvas.freeText ?? "");
    if (notes) {
      sources.push({
        canvasId: canvas.id,
        canvasName: canvas.name,
        kind: "canvas_notes",
        text: truncate(notes, MAX_POLICY_RULE_SOURCE_TEXT_LENGTH),
        sourceHash: stableSourceHash(`${canvas.id}|notes|${notes}`),
      });
    }

    for (const node of canvas.graph.nodes) {
      if (!isPolicyRuleSourceNode(node)) {
        continue;
      }

      const label = normalizeWhitespace(
        typeof node.data?.label === "string" ? node.data.label : ""
      );
      if (!label) {
        continue;
      }

      sources.push({
        canvasId: canvas.id,
        canvasName: canvas.name,
        nodeId: node.id,
        nodeLabel: truncate(label, 160),
        kind: "prompt_node",
        text: truncate(label, MAX_POLICY_RULE_SOURCE_TEXT_LENGTH),
        sourceHash: stableSourceHash(`${canvas.id}|${node.id}|${label}`),
      });
    }
  }

  return sources.slice(0, MAX_POLICY_RULE_SOURCES);
}

function renderExistingRulesForExtraction(rules: readonly CanvasRuleDefinition[]): string {
  return rules
    .map((rule) => `- ${rule.id}: ${rule.title}`)
    .join("\n");
}

function buildRuleExtractionPrompt(args: {
  existingRules: readonly CanvasRuleDefinition[];
  sources: PolicyCanvasRuleSource[];
}): string {
  return [
    "Extract durable target-draft canvas/build rules from the daemon policy canvas source material.",
    "Return JSON only.",
    "",
    "Keep these existing rules. Do not emit duplicates of them:",
    renderExistingRulesForExtraction(args.existingRules) || "- (none)",
    "",
    "Extraction guidance:",
    "- Extract only reusable rules that should guide how the daemon builds, inspects, or repairs target-agent policy/state canvases or workflow canvases.",
    "- Prefer durable invariants and repairable authoring constraints over one-off routing workflow steps.",
    "- Do not extract generic implementation mechanics like 'return JSON only' unless they are a durable rule for target drafts.",
    "- Set scope to policy, state, workflow, or both based on which target canvas type the rule applies to. Use workflow only for rules that govern editable workflow canvases; both means policy and state, not workflow.",
    "- Use ids that start with daemon_policy_ and are lowercase snake_case.",
    "- Keep each description and repairGuidance specific enough for a later model repair pass to apply.",
    "- Set check to null unless the rule can be represented exactly by the safe declarative node-count shape { kind: \"node_count\", nodeType: string, equals?: number, min?: number, max?: number, dataMatches?: [{ key: string, equals?: string|number|boolean, notEquals?: string|number|boolean }], whenStateField?: { fieldNames?: string[], fieldTypes?: string[] } }.",
    "- Use sourceCanvasId/sourceNodeId from the source item that best supports the extracted rule.",
    "",
    "Source items:",
    JSON.stringify(
      args.sources.map((source) => ({
        canvasId: source.canvasId,
        canvasName: source.canvasName,
        nodeId: source.nodeId ?? null,
        nodeLabel: source.nodeLabel ?? null,
        kind: source.kind,
        text: source.text,
      })),
      null,
      2
    ),
    "",
    "Return strict JSON with this shape:",
    "{",
    '  "rules": [{',
    '    "id": string,',
    '    "title": string,',
    '    "scope": "policy" | "state" | "workflow" | "both",',
    '    "description": string,',
    '    "repairGuidance": string,',
    '    "check": null | { "kind": "node_count", "nodeType": string, "equals": number, "min": number, "max": number, "dataMatches": [{ "key": string, "equals": string | number | boolean, "notEquals": string | number | boolean }], "whenStateField": { "fieldNames": string[], "fieldTypes": string[] } },',
    '    "sourceCanvasId": string,',
    '    "sourceCanvasName": string,',
    '    "sourceNodeId": string,',
    '    "sourceNodeLabel": string',
    "  }]",
    "}",
  ].join("\n");
}

function findSourceForExtractedRule(
  sources: readonly PolicyCanvasRuleSource[],
  record: ExtractedRuleRecord
): PolicyCanvasRuleSource | undefined {
  const sourceNodeId = asString(record.sourceNodeId);
  if (sourceNodeId) {
    const source = sources.find((item) => item.nodeId === sourceNodeId);
    if (source) {
      return source;
    }
  }

  const sourceCanvasId = asString(record.sourceCanvasId);
  if (sourceCanvasId) {
    return sources.find((item) => item.canvasId === sourceCanvasId);
  }

  return undefined;
}

function normalizeExtractedRule(args: {
  record: ExtractedRuleRecord;
  sources: readonly PolicyCanvasRuleSource[];
  existingIds: ReadonlySet<string>;
}): CanvasRuleDefinition | null {
  const title = asString(args.record.title);
  const description = asString(args.record.description);
  const repairGuidance =
    asString(args.record.repairGuidance) ||
    asString(args.record.repair_guidance);
  const id = normalizeGeneratedRuleId(asString(args.record.id), title);

  if (!id || !title || !description || !repairGuidance) {
    return null;
  }

  if (args.existingIds.has(id)) {
    return null;
  }

  const source = findSourceForExtractedRule(args.sources, args.record);
  const declarativeCheck = parseDeclarativeCheck(args.record.check);
  return {
    id,
    title,
    scope: normalizeScope(args.record.scope),
    checkMode: "rule_registry",
    description,
    repairGuidance,
    ...(declarativeCheck ? { declarativeCheck } : {}),
    source: "daemon_policy_canvas",
    sourceCanvasId:
      (source?.canvasId ?? asString(args.record.sourceCanvasId)) || undefined,
    sourceCanvasName:
      (source?.canvasName ?? asString(args.record.sourceCanvasName)) ||
      undefined,
    sourceNodeId:
      (source?.nodeId ?? asString(args.record.sourceNodeId)) || undefined,
    sourceNodeLabel:
      (source?.nodeLabel ?? asString(args.record.sourceNodeLabel)) || undefined,
    sourceHash: source?.sourceHash,
  };
}

async function extractRulesFromPolicyCanvas(args: {
  openai: CanvasRuleRegistryOpenAIClient;
  existingRules: readonly CanvasRuleDefinition[];
  sources: readonly PolicyCanvasRuleSource[];
  model: string;
  maxCompletionTokens: number;
}): Promise<CanvasRuleDefinition[]> {
  if (args.sources.length === 0) {
    return [];
  }

  const completion = await args.openai.chat.completions.create({
    model: args.model,
    max_completion_tokens: args.maxCompletionTokens,
    messages: [
      {
        role: "system",
        content:
          "You distill daemon policy-canvas instructions into a compact rule registry for target-agent canvas authoring. Output JSON only.",
      },
      {
        role: "user",
        content: buildRuleExtractionPrompt({
          existingRules: args.existingRules,
          sources: [...args.sources],
        }),
      },
    ],
  });

  const parsed = parseJsonObject<{
    rules?: ExtractedRuleRecord[];
  }>(completion.choices[0]?.message?.content ?? "");
  const records = Array.isArray(parsed?.rules) ? parsed.rules : [];
  const existingIds = new Set(args.existingRules.map((rule) => rule.id));
  const extractedById = new Map<string, CanvasRuleDefinition>();

  for (const record of records.slice(0, MAX_EXTRACTED_POLICY_RULES)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    const rule = normalizeExtractedRule({
      record,
      sources: args.sources,
      existingIds,
    });
    if (!rule) {
      continue;
    }
    extractedById.set(rule.id, rule);
  }

  return [...extractedById.values()];
}

export async function refreshDerivedCanvasRuleRegistryWithConfig<
  TProject extends CanvasRuleRegistryProjectShape,
>(
  args: RefreshDerivedCanvasRuleRegistryConfig<TProject>
): Promise<TProject & { datasets: CanvasRuleRegistryDatasets }> {
  const existingRules = getSeededCanvasRuleDefinitions();
  const sources = collectPolicyCanvasRuleSources(args.project.policyCanvases);
  const extractedRules = await extractRulesFromPolicyCanvas({
    openai: args.openai,
    existingRules,
    sources,
    model: args.model,
    maxCompletionTokens: args.maxCompletionTokens,
  });
  const rules = [...existingRules, ...extractedRules];

  return {
    ...args.project,
    datasets: replaceCanvasRuleRegistryDataset(
      Array.isArray(args.project.datasets) ? args.project.datasets : [],
      rules,
      args.makeId
    ),
  };
}
