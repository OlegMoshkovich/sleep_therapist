import { AsyncLocalStorage } from "node:async_hooks";
import OpenAI from "openai";
import { GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE } from "@airlab/orchestration-core/general-orchestration-daemon-published-demos";
import {
  type CanvasExecutionSourceNodeRef,
  type ConditionPlan,
  defaultHybridExecutionPlan,
  evaluateStateCondition,
  executePolicyCodePlan,
  executeStateCodePlan,
  type PolicyCodeAction,
  type PolicyCodePlan,
  type PolicyExecutionGraph,
  type PolicyExecutionGraphStep,
  type PolicyPromptExtractExecutionStep,
  type PromptValueSnapshot,
  renderPolicyActionMessage,
  type StateCodeOperation,
  type StateCodeRuntimeContext,
  type StateCodePlan,
  type StateCodeRule,
  type StateExecutionGraph,
  type StateExecutionGraphStep,
  type StatePromptExtractionField,
  type StatePromptExtractionPlan,
  type StateValueSource,
  type HybridExecutionPlan,
} from "@airlab/canvas-planner/canvas-hybrid-runtime";
import {
  buildObservationIngressPromptValues,
  CARRIED_OUTPUT_PROMPT_VALUE_NAME,
} from "@airlab/canvas-core/lib/canvas-flow-values";
import { compileCanvas } from "@airlab/canvas-compiler/compiler";
import {
  compileStateExtractionPrompt,
  type StateExtractionField,
} from "@airlab/canvas-compiler/stateCompiler";
import {
  normalizeCanvasDoc,
  type CanvasDoc,
  type CanvasEntry,
  type CompiledToolDef,
} from "@airlab/canvas-ui/types";
import { dispatchTool } from "./dispatch";
import {
  type AsyncChatRuntimeOperationJobInput,
  type AsyncRuntimeOperationCompletionPayload,
  buildAsyncRuntimeJobPromptValueUpdates,
  isAsyncRuntimeJobResult,
} from "./async-job-runtime";
import { runAsyncJobPolicyRuntimeStep } from "./async-job-policy-runtime";
import { executeTypeScriptCodeStep } from "@airlab/canvas-core/lib/canvas-code-script-runtime";
import {
  appendConversationMemoryTurn,
  appendConversationMemoryObservationEvent,
  buildConversationMemoryObservationEvent,
  formatConversationMemoryTurn,
  hasConversationMemoryFieldNames,
  NEW_EVENTS_FIELD_NAME,
  resolveConversationMemoryFieldName,
} from "@airlab/canvas-core/lib/conversation-memory";

interface HistoryMessage {
  role: string;
  content: string;
}

type FieldType = "string" | "integer" | "boolean" | "string[]" | "number" | "json";
type StateSnapshot = Record<string, string>;

interface StateSchemaField {
  field_name?: string;
  type?: FieldType;
  initial_value?: string | null;
}

interface GuidelineBlock {
  topic?: string;
  content?: string;
  problem?: string;
  recommendation?: string;
}

interface AgentConfigRow {
  id: string;
  state_schema: StateSchemaField[] | null;
  state_update_prompt: string | null;
  policy_prompt: string | null;
  guideline_blocks: GuidelineBlock[] | string | null;
}

interface PolicyCanvasRow {
  canvas_id: string;
  name: string;
}

interface StoredCanvasRow extends PolicyCanvasRow {
  sort_order: number | null;
  canvas: CanvasEntry;
}

interface RuntimePromptConfig {
  setupId: string;
  setupTable: string;
  stateSchema: Array<{ fieldName: string; type: FieldType; initialValue: string }>;
  guidelinesContext: string;
  stateUpdateSystemPrompt: string;
  policyExecutionSystemPrompt: string;
  expandSystemPromptsByKey: Record<string, string>;
  toolsByName: Record<string, CompiledToolDef>;
  executionPlan: HybridExecutionPlan;
}

interface SetupSource {
  sourceTable: string;
  setupEndpoint: string;
  setupEndpointAliases?: string[];
}

export interface CreateChatRouteOptions {
  authenticate: (request: Request) => Promise<{ userId?: string | null }>;
  clerkIdToUUID: (clerkId: string) => Promise<string>;
  createSupabaseAdminClient: () => unknown;
  logger?: Pick<Console, "error" | "log">;
}

interface ChatRouteSupabaseResult {
  data: unknown;
  error: { message: string } | null;
}

interface ChatRouteSupabaseQuery
  extends PromiseLike<ChatRouteSupabaseResult> {
  eq(column: string, value: unknown): ChatRouteSupabaseQuery;
  in(column: string, values: readonly unknown[]): ChatRouteSupabaseQuery;
  order(
    column: string,
    options?: { ascending?: boolean }
  ): ChatRouteSupabaseQuery;
  limit(count: number): ChatRouteSupabaseQuery;
  maybeSingle(): PromiseLike<ChatRouteSupabaseResult>;
  single(): PromiseLike<ChatRouteSupabaseResult>;
}

interface ChatRouteSupabaseFromBuilder {
  select(columns: string): ChatRouteSupabaseQuery;
  insert(values: unknown): ChatRouteSupabaseQuery;
  update(values: unknown): ChatRouteSupabaseQuery;
}

interface ChatRouteSupabaseClient {
  from(table: string): ChatRouteSupabaseFromBuilder;
}

const OPENAI_MODEL = "gpt-5.4";
// The pure structured-extraction stages (state update/extraction, policy extraction)
// never produce user-facing text — their output is parsed straight into JSON state or
// prompt values. gpt-5.4-mini runs those ~40% faster than gpt-5.4 at the same quality
// (interleaved A/B on realistic 1.3k-token extraction prompts: 0.88s vs 1.50s median,
// p80 0.92s vs 1.59s; identical field extraction). Anything the user actually reads —
// decisions that emit replies, expansions, transforms, final answers — stays on the
// full model. Override the extraction tier via env without a code change / redeploy.
const OPENAI_EXTRACTION_MODEL = process.env.AIRLAB_OPENAI_EXTRACTION_MODEL ?? "gpt-5.4-mini";
// Compiled policy graphs evaluate each `IF <condition>` on the canvas as its own
// prompt_extract node — one full OpenAI round trip to extract a single boolean. When
// several such independent boolean conditions sit at the front of the policy graph
// (connected only by deterministic code routing), they can be evaluated together in a
// single call instead of one call per condition, saving a round trip per fused
// condition with no behavior change (verified: batched vs per-call booleans have the
// same output distribution). Kill switch: set to "off" to fall back to one call each.
const POLICY_CONDITION_BATCHING_ENABLED =
  (process.env.AIRLAB_POLICY_CONDITION_BATCHING ?? "on").toLowerCase() !== "off";
const OPENAI_MAX_TOKENS = 1024;
const DEFAULT_SETUP_SOURCE: SetupSource = {
  sourceTable: "nutrition",
  setupEndpoint: "/demo/nutrition/input",
};
const SLEEP_SETUP_SOURCE: SetupSource = {
  sourceTable: "sleep_inputs",
  setupEndpoint: "/demo/sleep/input",
  setupEndpointAliases: ["/sleep/input"],
};
const DND_SETUP_SOURCE: SetupSource = {
  sourceTable: "dnd_inputs",
  setupEndpoint: "/demo/dnd/input",
};
const RESEARCH_ASSISTANT_SETUP_SOURCE: SetupSource = {
  sourceTable: "research_assistant_inputs",
  setupEndpoint: "/demo/research-assistant/input",
};
const FIXED_DEMO_SLUGS = new Set([
  "dnd",
  "general-orchestration-daemon",
  "login",
  "nutrition",
  "platform",
  "research-assistant",
  "sleep",
]);
const STATE_BLOCK_BEGIN = "BEGIN STATE";
const STATE_BLOCK_END = "END STATE";
const STATE_EXECUTION_GRAPH_DEFAULT_MAX_STEPS = 8;
const STATE_EXECUTION_GRAPH_HARD_MAX_STEPS = 24;

class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

function normalizeExpandKey(label: string): string {
  return label.trim().toLowerCase().replace(/[_\s]+/g, " ");
}

function extractCanvasGeneralPromptsFromPolicy(policyPrompt: string): Record<string, string> {
  const promptsByKey: Record<string, string> = {};
  const pattern =
    /###\s*Canvas:\s*([^\n]+)[\s\S]*?General-purpose prompt:\s*([\s\S]*?)(?:\nFlow:|\n###\s*Canvas:|$)/gi;
  const matches = policyPrompt.matchAll(pattern);

  for (const match of matches) {
    const canvasName = match[1]?.trim() ?? "";
    const generalPrompt = match[2]?.trim() ?? "";
    if (!canvasName || !generalPrompt) {
      continue;
    }

    promptsByKey[normalizeExpandKey(canvasName)] = generalPrompt;
  }

  return promptsByKey;
}

function extractCanvasPolicyPromptsFromPolicy(policyPrompt: string): Record<string, string> {
  const promptsByKey: Record<string, string> = {};
  const pattern = /###\s*Canvas:\s*([^\n]+)\n([\s\S]*?)(?=\n###\s*Canvas:|$)/gi;
  const matches = policyPrompt.matchAll(pattern);

  for (const match of matches) {
    const canvasName = match[1]?.trim() ?? "";
    const canvasPrompt = match[2]?.trim() ?? "";
    if (!canvasName || !canvasPrompt) {
      continue;
    }

    promptsByKey[normalizeExpandKey(canvasName)] = canvasPrompt;
  }

  return promptsByKey;
}

function buildExpandSystemPromptsByKey(
  policyPrompt: string,
  policyCanvasRows: StoredCanvasRow[],
  policyCanvasDoc: CanvasDoc | null
): Record<string, string> {
  const compiledPolicyPrompt = policyCanvasDoc
    ? compileCanvas(policyCanvasDoc).output
    : policyPrompt;
  const promptsByCanvasName = extractCanvasPolicyPromptsFromPolicy(compiledPolicyPrompt);
  const generalPromptsByCanvasName = extractCanvasGeneralPromptsFromPolicy(compiledPolicyPrompt);
  const promptsByKey: Record<string, string> = {};

  const orderedRows = [...policyCanvasRows].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
  );

  for (const row of orderedRows) {
    const canvasKey = normalizeExpandKey(row.name);
    const prompt = promptsByCanvasName[canvasKey] ?? generalPromptsByCanvasName[canvasKey];
    if (prompt) {
      promptsByKey[canvasKey] = prompt;
    }
  }

  const legacyExpandLabels = Array.from(
    new Set(
      orderedRows.flatMap((row) =>
        row.canvas?.graph?.nodes
          ?.map((node) =>
            node.type === "expand" && typeof node.data?.label === "string"
              ? node.data.label.trim()
              : ""
          )
          .filter((label) => label.length > 0) ?? []
      )
    )
  );
  const secondaryCanvasRows = orderedRows.slice(1);
  let secondaryIndex = 0;

  for (const label of legacyExpandLabels) {
    const labelKey = normalizeExpandKey(label);
    if (promptsByKey[labelKey]) {
      continue;
    }

    const fallbackRow = secondaryCanvasRows[secondaryIndex];
    if (!fallbackRow) {
      break;
    }

    const fallbackKey = normalizeExpandKey(fallbackRow.name);
    const fallbackPrompt =
      promptsByCanvasName[fallbackKey] ?? generalPromptsByCanvasName[fallbackKey];
    if (!fallbackPrompt) {
      continue;
    }

    promptsByKey[labelKey] = fallbackPrompt;
    secondaryIndex += 1;
  }

  return {
    ...promptsByCanvasName,
    ...promptsByKey,
  };
}

function normalizeGuidelineBlocks(raw: AgentConfigRow["guideline_blocks"]): GuidelineBlock[] {
  if (!raw) {
    return [];
  }

  if (Array.isArray(raw)) {
    return raw;
  }

  if (typeof raw !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GuidelineBlock[]) : [];
  } catch {
    return [];
  }
}

function normalizeStateSchema(
  raw: AgentConfigRow["state_schema"],
  setupEndpoint: string
): RuntimePromptConfig["stateSchema"] {
  const schema = Array.isArray(raw) ? raw : [];
  const normalized = schema
    .map((field) => {
      const fieldName = typeof field.field_name === "string" ? field.field_name.trim() : "";
      const type = field.type ?? "string";
      const initialValue = field.initial_value === null ? "null" : String(field.initial_value ?? "");

      if (!fieldName) {
        return null;
      }

      const normalizedType: FieldType =
        type === "string" ||
        type === "integer" ||
        type === "boolean" ||
        type === "string[]" ||
        type === "number" ||
        type === "json"
          ? type
          : "string";

      return { fieldName, type: normalizedType, initialValue };
    })
    .filter((field): field is { fieldName: string; type: FieldType; initialValue: string } => field !== null);

  if (normalized.length === 0) {
    throw new RuntimeConfigError(
      `Chat configuration error: \`state_schema\` is empty or invalid in \`${setupEndpoint}\`.`
    );
  }

  return normalized;
}

function buildCanvasDoc(rows: StoredCanvasRow[]): CanvasDoc | null {
  if (rows.length === 0) {
    return null;
  }

  const canvases = [...rows]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((row) => ({
      ...row.canvas,
      id: row.canvas_id || row.canvas.id,
      name: row.name || row.canvas.name,
    }));

  return normalizeCanvasDoc({
    version: 2,
    activeId: canvases[0].id,
    canvases,
  });
}

function compileToolsByName(...docs: Array<CanvasDoc | null>): Record<string, CompiledToolDef> {
  const toolsByName = new Map<string, CompiledToolDef>();

  for (const doc of docs) {
    if (!doc) {
      continue;
    }

    for (const tool of compileCanvas(doc).tools ?? []) {
      const name = tool.function.name.trim();
      if (!name) {
        continue;
      }
      toolsByName.set(name, tool);
    }
  }

  return Object.fromEntries(toolsByName.entries());
}

async function fetchCanvasDoc(
  supabase: ChatRouteSupabaseClient,
  table: "policy_canvases" | "state_policy_canvases",
  setupTable: string,
  setupId: string
): Promise<CanvasDoc | null> {
  const { data, error } = await supabase
    .from(table)
    .select("canvas_id, name, sort_order, canvas")
    .eq("setup_table", setupTable)
    .eq("setup_id", setupId)
    .order("sort_order", { ascending: true });

  if (error) {
    return null;
  }

  return buildCanvasDoc((data ?? []) as StoredCanvasRow[]);
}

async function fetchExecutionPlan(
  supabase: ChatRouteSupabaseClient,
  setupTable: string,
  setupId: string
): Promise<HybridExecutionPlan> {
  const { data, error } = await supabase
    .from("canvas_execution_plans")
    .select("execution_plan")
    .eq("setup_table", setupTable)
    .eq("setup_id", setupId)
    .maybeSingle();

  if (error || !data || typeof data !== "object") {
    return defaultHybridExecutionPlan();
  }

  const rawPlan = (data as { execution_plan?: unknown }).execution_plan;
  return rawPlan && typeof rawPlan === "object"
    ? (rawPlan as HybridExecutionPlan)
    : defaultHybridExecutionPlan();
}

function toFieldLabel(fieldName: string): string {
  return fieldName
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeStateValueForBlock(value: unknown, type: FieldType): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (type === "boolean") {
    if (typeof value === "boolean") {
      return value ? "Yes" : "";
    }
    if (typeof value === "string") {
      return /^(true|yes)$/i.test(value.trim()) ? "Yes" : "";
    }
    return "";
  }

  if (type === "string[]") {
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === "string" ? item.trim() : String(item)))
        .filter((item) => item.length > 0)
        .join(", ");
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return "";
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item)).join(", ");
        }
      } catch {
        return trimmed;
      }
      return trimmed;
    }
    return "";
  }

  if (type === "integer" || type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === "string") {
      return value.trim();
    }
    return "";
  }

  if (type === "json") {
    if (typeof value === "string") {
      return value.trim();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return typeof value === "string" ? value.trim() : String(value);
}

function toJsonStateValue(value: string, type: FieldType): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return type === "string[]" ? [] : null;
  }

  if (type === "boolean") {
    return /^(yes|true)$/i.test(trimmed);
  }

  if (type === "integer") {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (type === "number") {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (type === "string[]") {
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (type === "json") {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function toJsonStateValueForField(
  fieldName: string,
  value: string,
  type: FieldType
): unknown {
  const normalizedFieldName = normalizeExpandKey(fieldName);
  const trimmed = value.trim();

  if (normalizedFieldName === "age") {
    if (!trimmed) {
      return null;
    }
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 120 ? parsed : null;
  }

  if (normalizedFieldName === "gender") {
    if (!trimmed) {
      return null;
    }
    const lowered = trimmed.toLowerCase();
    if (["male", "female", "other"].includes(lowered)) {
      return lowered;
    }
    return null;
  }

  if (normalizedFieldName === "emergency") {
    if (!trimmed) {
      return false;
    }
    return /^(yes|true|1)$/i.test(trimmed);
  }

  return toJsonStateValue(value, type);
}

function buildInitialStateSnapshot(
  stateSchema: RuntimePromptConfig["stateSchema"]
): StateSnapshot {
  return stateSchema.reduce<StateSnapshot>((acc, field) => {
    acc[field.fieldName] = normalizeStateValueForBlock(field.initialValue, field.type);
    return acc;
  }, {});
}

function usesConversationMemoryState(
  stateSchema: RuntimePromptConfig["stateSchema"]
): boolean {
  return hasConversationMemoryFieldNames(
    stateSchema.map((field) => field.fieldName)
  );
}

function replaceStateSnapshot(
  target: StateSnapshot,
  next: StateSnapshot
): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, next);
}

export async function executeQueuedChatRuntimeOperationJob(
  input: AsyncChatRuntimeOperationJobInput
): Promise<AsyncRuntimeOperationCompletionPayload> {
  throw new Error(
    `Unsupported async chat runtime operation "${input.step.operation}".`
  );
}

function appendObservationToConversationMemoryState(
  state: StateSnapshot,
  observation: string,
  stateSchema: RuntimePromptConfig["stateSchema"]
): StateSnapshot {
  if (!usesConversationMemoryState(stateSchema)) {
    return state;
  }

  const memoryFieldName = resolveConversationMemoryFieldName(
    stateSchema.map((field) => field.fieldName)
  );
  if (!memoryFieldName) {
    return state;
  }

  return {
    ...state,
    [memoryFieldName]:
      memoryFieldName.toLowerCase() === NEW_EVENTS_FIELD_NAME
        ? appendConversationMemoryObservationEvent(
            state[memoryFieldName] ?? "",
            observation
          )
        : appendConversationMemoryTurn(
            state[memoryFieldName] ?? "",
            "user",
            observation
          ),
  };
}

function normalizePromptExtractionFieldType(value: unknown): FieldType {
  return value === "integer" ||
    value === "boolean" ||
    value === "string[]" ||
    value === "number" ||
    value === "json"
    ? value
    : "string";
}

function normalizePromptExtractionFields(
  promptPlan: StatePromptExtractionPlan | undefined
): StatePromptExtractionField[] {
  if (!promptPlan || !Array.isArray(promptPlan.fields)) {
    return [];
  }

  return promptPlan.fields
    .map((field) => ({
      name: typeof field?.name === "string" ? field.name.trim() : "",
      type: normalizePromptExtractionFieldType(field?.type),
      instruction: typeof field?.instruction === "string" ? field.instruction.trim() : "",
    }))
    .filter((field) => field.name.length > 0 && field.instruction.length > 0);
}

function renderPromptExtractionFieldShape(field: StatePromptExtractionField): string {
  switch (field.type) {
    case "boolean":
      return "boolean | null";
    case "integer":
      return "integer | null";
    case "number":
      return "number | null";
    case "string[]":
      return "string[] | null";
    case "json":
      return "json | null";
    case "string":
    default:
      return "string | null";
  }
}

function renderPromptExtractionInstruction(fields: StatePromptExtractionField[]): string {
  const lines =
    fields.length > 0
      ? fields.map((field) => `  ${JSON.stringify(field.name)}: ${renderPromptExtractionFieldShape(field)}`)
      : ["  ..."];

  return [
    "Return exactly a JSON object of this form and nothing else:",
    "{",
    lines.join(",\n"),
    "}",
  ].join("\n");
}

function renderPolicyDecisionExtractionInstruction(
  fields: StatePromptExtractionField[]
): string {
  const lines = [
    '  "assistant_reply": string',
    ...fields.map(
      (field) =>
        `  ${JSON.stringify(field.name)}: ${renderPromptExtractionFieldShape(field)}`
    ),
  ];

  return [
    "Return exactly a JSON object of this form and nothing else:",
    "{",
    lines.join(",\n"),
    "}",
  ].join("\n");
}

function normalizePromptExtractionValue(rawValue: unknown, type: FieldType): unknown {
  if (rawValue === undefined || rawValue === null) {
    return null;
  }

  if (type === "boolean") {
    if (typeof rawValue === "boolean") {
      return rawValue;
    }
    if (typeof rawValue === "string") {
      const trimmed = rawValue.trim().toLowerCase();
      if (trimmed === "true" || trimmed === "yes") return true;
      if (trimmed === "false" || trimmed === "no") return false;
    }
    return null;
  }

  if (type === "integer") {
    const numeric =
      typeof rawValue === "number"
        ? rawValue
        : typeof rawValue === "string"
          ? Number.parseInt(rawValue.trim(), 10)
          : Number.NaN;
    return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
  }

  if (type === "number") {
    const numeric =
      typeof rawValue === "number"
        ? rawValue
        : typeof rawValue === "string"
          ? Number(rawValue.trim())
          : Number.NaN;
    return Number.isFinite(numeric) ? numeric : null;
  }

  if (type === "string[]") {
    if (Array.isArray(rawValue)) {
      return rawValue
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0);
    }

    const text = String(rawValue).trim();
    return text.length > 0 ? [text] : [];
  }

  if (type === "json") {
    if (
      typeof rawValue === "boolean" ||
      typeof rawValue === "number" ||
      typeof rawValue === "string" ||
      Array.isArray(rawValue) ||
      (rawValue !== null && typeof rawValue === "object")
    ) {
      if (typeof rawValue !== "string") {
        return rawValue;
      }

      const text = rawValue.trim();
      if (!text) {
        return null;
      }

      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }

    return null;
  }

  const text = String(rawValue).trim();
  return text.length > 0 ? text : null;
}

function parseStatePromptExtractionReply(
  text: string,
  promptPlan: StatePromptExtractionPlan | undefined
): PromptValueSnapshot | null {
  const fields = normalizePromptExtractionFields(promptPlan);
  if (fields.length === 0) {
    return null;
  }

  const objectText = extractFirstJsonObject(text);
  if (!objectText) {
    return null;
  }

  try {
    const parsed = JSON.parse(objectText) as Record<string, unknown>;
    return fields.reduce<PromptValueSnapshot>((acc, field) => {
      acc[field.name] = normalizePromptExtractionValue(parsed[field.name], field.type);
      return acc;
    }, {});
  } catch {
    return null;
  }
}

function parsePolicyDecisionExtractionReply(
  text: string,
  promptPlan: StatePromptExtractionPlan | undefined
): { assistantReply: string; promptValues: PromptValueSnapshot | null } {
  const objectText = extractFirstJsonObject(text);
  if (!objectText) {
    return {
      assistantReply: text.trim(),
      promptValues: parseStatePromptExtractionReply(text, promptPlan),
    };
  }

  try {
    const parsed = JSON.parse(objectText) as Record<string, unknown>;
    const assistantReply =
      typeof parsed.assistant_reply === "string"
        ? parsed.assistant_reply.trim()
        : text.trim();
    const fields = normalizePromptExtractionFields(promptPlan);
    const promptValues =
      fields.length === 0
        ? null
        : fields.reduce<PromptValueSnapshot>((acc, field) => {
            acc[field.name] = normalizePromptExtractionValue(parsed[field.name], field.type);
            return acc;
          }, {});
    return { assistantReply, promptValues };
  } catch {
    return {
      assistantReply: text.trim(),
      promptValues: parseStatePromptExtractionReply(text, promptPlan),
    };
  }
}

function buildGuidelinesContextFromBlocks(blocks: GuidelineBlock[]): string {
  const sections = blocks
    .map((block) => {
      const topic = block.topic?.trim() ?? "";
      const content = block.content?.trim() ?? "";
      const problem = block.problem?.trim() ?? "";
      const recommendation = block.recommendation?.trim() ?? "";

      const lines = [
        topic ? `Topic: ${topic}` : "",
        content ? `Content: ${content}` : "",
        problem ? `Problem: ${problem}` : "",
        recommendation ? `Recommendation: ${recommendation}` : "",
      ].filter((line) => line.length > 0);

      return lines.join("\n");
    })
    .filter((section) => section.length > 0);

  if (sections.length === 0) {
    return "";
  }

  return `Guidelines\n${sections.join("\n\n---\n\n")}`;
}

function resolveSetupSourceFromRequest(request: Request): SetupSource {
  const referer = request.headers.get("referer") ?? "";

  if (referer.includes("/demo/research-assistant")) {
    return RESEARCH_ASSISTANT_SETUP_SOURCE;
  }

  if (referer.includes("/demo/dnd")) {
    return DND_SETUP_SOURCE;
  }

  if (referer.includes("/demo/sleep") || referer.includes("/sleep-assessment")) {
    return SLEEP_SETUP_SOURCE;
  }

  const publishedDemoSource = resolvePublishedDaemonSetupSource(referer);
  if (publishedDemoSource) {
    return publishedDemoSource;
  }

  return DEFAULT_SETUP_SOURCE;
}

function resolvePublishedDaemonSetupSource(referer: string): SetupSource | null {
  if (!referer.trim()) {
    return null;
  }

  let pathname = "";
  try {
    pathname = new URL(referer).pathname;
  } catch {
    pathname = referer.split("?")[0].split("#")[0];
  }

  const match = pathname.match(/^\/demo\/([^/]+)\/?$/);
  const slug = match?.[1] ? decodeURIComponent(match[1]).trim() : "";
  if (!slug || FIXED_DEMO_SLUGS.has(slug)) {
    return null;
  }

  return {
    sourceTable: GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE,
    setupEndpoint: `/demo/${slug}`,
  };
}

async function loadRuntimePromptConfig(
  supabase: ChatRouteSupabaseClient,
  setupSource: SetupSource
): Promise<RuntimePromptConfig> {
  const baseQuery = supabase
    .from(setupSource.sourceTable)
    .select("id, state_schema, state_update_prompt, policy_prompt, guideline_blocks")
    .order("updated_at", { ascending: false })
    .limit(1);

  let data: AgentConfigRow | null = null;
  let error: { message: string } | null = null;

  const primaryResult = await baseQuery.eq("endpoint", setupSource.setupEndpoint).maybeSingle();
  data = (primaryResult.data as AgentConfigRow | null) ?? null;
  error = primaryResult.error ? { message: primaryResult.error.message } : null;

  if (!error && !data && setupSource.setupEndpointAliases && setupSource.setupEndpointAliases.length > 0) {
    const fallbackResult = await baseQuery
      .in("endpoint", setupSource.setupEndpointAliases)
      .maybeSingle();
    data = (fallbackResult.data as AgentConfigRow | null) ?? null;
    error = fallbackResult.error ? { message: fallbackResult.error.message } : null;
  }

  if (error) {
    throw new RuntimeConfigError(`Failed to load chat configuration: ${error.message}`);
  }

  const config = data;
  if (!config) {
    throw new RuntimeConfigError(
      `Chat configuration error: no setup row found for endpoint ${setupSource.setupEndpoint}.`
    );
  }

  const stateSchema = normalizeStateSchema(config?.state_schema ?? null, setupSource.setupEndpoint);
  const guidelinesContext = buildGuidelinesContextFromBlocks(
    normalizeGuidelineBlocks(config?.guideline_blocks ?? null)
  );
  const compilerFields: StateExtractionField[] = stateSchema.map((field) => ({
    name: field.fieldName,
    type: field.type,
    initialValue: field.initialValue,
  }));
  const stateCanvasDoc = await fetchCanvasDoc(
    supabase,
    "state_policy_canvases",
    setupSource.sourceTable,
    config.id
  );
  const policyCanvasDoc = await fetchCanvasDoc(
    supabase,
    "policy_canvases",
    setupSource.sourceTable,
    config.id
  );

  let stateUpdateSystemPrompt = config?.state_update_prompt?.trim() ?? "";
  if (!stateUpdateSystemPrompt) {
    if (stateCanvasDoc) {
      stateUpdateSystemPrompt = compileStateExtractionPrompt(
        stateCanvasDoc,
        compilerFields
      ).trim();
    }
  }

  let policyExecutionSystemPrompt = config?.policy_prompt?.trim() ?? "";
  if (!policyExecutionSystemPrompt) {
    if (policyCanvasDoc) {
      policyExecutionSystemPrompt = compileCanvas(policyCanvasDoc).output.trim();
    }
  }

  if (!stateUpdateSystemPrompt) {
    throw new RuntimeConfigError(
      "Chat configuration error: `state_update_prompt` is missing in the selected setup row."
    );
  }

  if (!policyExecutionSystemPrompt) {
    throw new RuntimeConfigError(
      "Chat configuration error: `policy_prompt` is missing in the selected setup row."
    );
  }

  const { data: policyCanvasRows, error: policyCanvasError } = await supabase
    .from("policy_canvases")
    .select("canvas_id, name, sort_order, canvas")
    .eq("setup_table", setupSource.sourceTable)
    .eq("setup_id", config.id);

  if (policyCanvasError) {
    throw new RuntimeConfigError(`Failed to load policy canvases: ${policyCanvasError.message}`);
  }

  const expandSystemPromptsByKey = buildExpandSystemPromptsByKey(
    policyExecutionSystemPrompt,
    (policyCanvasRows ?? []) as StoredCanvasRow[],
    policyCanvasDoc
  );
  const executionPlan = await fetchExecutionPlan(
    supabase,
    setupSource.sourceTable,
    config.id
  );
  const toolsByName = compileToolsByName(stateCanvasDoc, policyCanvasDoc);

  return {
    setupId: config.id,
    setupTable: setupSource.sourceTable,
    stateSchema,
    guidelinesContext,
    stateUpdateSystemPrompt,
    policyExecutionSystemPrompt,
    expandSystemPromptsByKey,
    toolsByName,
    executionPlan,
  };
}

function normalizeModelText(text: string | null | undefined): string {
  return (text ?? "").trim();
}

function extractAgeFromText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const patterns = [
    /\b(\d{1,3})\s*(?:years?\s*old|yo|y\/o)\b/i,
    /\bage\s*(?:is|:)?\s*(\d{1,3})\b/i,
    // Only treat a message that is essentially just a number as an age.
    // This deliberately does NOT match times ("10pm") or durations
    // ("about 3 hours", "3 months"), which previously leaked in as ages.
    /^\s*(\d{1,3})\s*(?:years?\s*old|yo|y\/o)?\s*$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    const age = Number(match?.[1]);
    if (Number.isInteger(age) && age >= 0 && age <= 120) {
      return String(age);
    }
  }

  return null;
}

function extractGenderFromText(text: string): string | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (/\b(male|man|boy)\b/.test(normalized)) {
    return "male";
  }
  if (/\b(female|woman|girl)\b/.test(normalized)) {
    return "female";
  }
  if (/\b(nonbinary|non-binary|other|trans|transgender)\b/.test(normalized)) {
    return "other";
  }

  return null;
}

function mergeDeterministicStateFromLatestMessage(
  state: StateSnapshot,
  stateSchema: RuntimePromptConfig["stateSchema"],
  latestUserMessage: string
): StateSnapshot {
  const nextState: StateSnapshot = { ...state };

  // A field is "unknown" when it is blank or the literal initial "null". The
  // deterministic merge only FILLS unknown fields — it must never overwrite a
  // value the user already gave (e.g. a stray "3" in "about 3 hours" clobbering
  // a known age), which used to re-open the policy's intake gates and made the
  // assistant re-ask questions it already had answers for.
  const isUnknown = (value: string | undefined): boolean => {
    const trimmed = (value ?? "").trim();
    return trimmed === "" || trimmed.toLowerCase() === "null";
  };

  const ageField = stateSchema.find((field) => normalizeExpandKey(field.fieldName) === "age");
  if (ageField && isUnknown(nextState[ageField.fieldName])) {
    const extractedAge = extractAgeFromText(latestUserMessage);
    if (extractedAge) {
      nextState[ageField.fieldName] = extractedAge;
    }
  }

  const genderField = stateSchema.find((field) => normalizeExpandKey(field.fieldName) === "gender");
  if (genderField && isUnknown(nextState[genderField.fieldName])) {
    const extractedGender = extractGenderFromText(latestUserMessage);
    if (extractedGender) {
      nextState[genderField.fieldName] = extractedGender;
    }
  }

  return nextState;
}

function stripStateBlock(text: string): string {
  const normalized = text.trim();

  if (!normalized.startsWith(STATE_BLOCK_BEGIN)) {
    return normalized;
  }

  const endIndex = normalized.indexOf(STATE_BLOCK_END);
  if (endIndex === -1) {
    return normalized;
  }

  return normalized.slice(endIndex + STATE_BLOCK_END.length).trim();
}

function serializeStateSnapshotForStateUpdate(
  state: StateSnapshot,
  stateSchema: RuntimePromptConfig["stateSchema"]
): Record<string, unknown> {
  return stateSchema.reduce<Record<string, unknown>>((acc, field) => {
    acc[field.fieldName] = toJsonStateValueForField(
      field.fieldName,
      state[field.fieldName] ?? "",
      field.type
    );
    return acc;
  }, {});
}

function renderStateUpdateJson(
  state: StateSnapshot,
  stateSchema: RuntimePromptConfig["stateSchema"]
): string {
  return JSON.stringify(serializeStateSnapshotForStateUpdate(state, stateSchema), null, 2);
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

function parseStateUpdateJson(
  text: string,
  stateSchema: RuntimePromptConfig["stateSchema"],
  fallbackState: StateSnapshot
): StateSnapshot | null {
  const objectText = extractFirstJsonObject(text);

  if (!objectText) {
    return null;
  }

  try {
    const parsed = JSON.parse(objectText) as Record<string, unknown>;
    return stateSchema.reduce<StateSnapshot>((acc, field) => {
      const rawValue = parsed[field.fieldName];
      acc[field.fieldName] =
        rawValue === undefined
          ? fallbackState[field.fieldName] ?? ""
          : normalizeStateValueForBlock(rawValue, field.type);
      return acc;
    }, {});
  } catch {
    return null;
  }
}

function parseStateBlock(
  text: string,
  stateSchema: RuntimePromptConfig["stateSchema"]
): StateSnapshot {
  const match = text.match(/BEGIN STATE\s*([\s\S]*?)\s*END STATE/i);

  if (!match) {
    return buildInitialStateSnapshot(stateSchema);
  }

  const block = match[1];
  return stateSchema.reduce<StateSnapshot>((acc, field) => {
    const label = toFieldLabel(field.fieldName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const value = block.match(new RegExp(`^[ \\t]*${label}:[ \\t]*(.*)$`, "im"))?.[1]?.trim() ?? "";
    acc[field.fieldName] = value;
    return acc;
  }, {});
}

function parseStateUpdateReply(
  text: string,
  stateSchema: RuntimePromptConfig["stateSchema"],
  fallbackState: StateSnapshot
): StateSnapshot {
  return (
    parseStateUpdateJson(text, stateSchema, fallbackState) ??
    parseStateBlock(text, stateSchema)
  );
}

function formatHistoryForStatePrompt(history: HistoryMessage[]): string {
  return history
    .map((message, index) => {
      const content =
        message.role === "assistant" ? stripStateBlock(message.content) : message.content.trim();
      return `${index + 1}. ${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n");
}

function historyWithoutLatestUserMessage(
  history: HistoryMessage[],
  latestUserMessage: string
): HistoryMessage[] {
  if (history.length === 0) {
    return history;
  }

  const lastMessage = history[history.length - 1];
  if (lastMessage.role !== "user") {
    return history;
  }

  if (normalizeModelText(lastMessage.content) !== normalizeModelText(latestUserMessage)) {
    return history;
  }

  return history.slice(0, -1);
}

function hasStateSnapshotData(state: StateSnapshot): boolean {
  return Object.values(state).some((value) => value.trim().length > 0);
}

function getLatestKnownState(
  history: HistoryMessage[],
  stateSchema: RuntimePromptConfig["stateSchema"]
): StateSnapshot {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];

    if (message.role !== "assistant") {
      continue;
    }

    const parsedState = parseStateBlock(message.content, stateSchema);
    if (!hasStateSnapshotData(parsedState)) {
      continue;
    }

    return parsedState;
  }

  return buildInitialStateSnapshot(stateSchema);
}

function normalizeStoredStateSnapshot(
  raw: unknown,
  stateSchema: RuntimePromptConfig["stateSchema"]
): StateSnapshot | null {
  if (!raw) {
    return null;
  }

  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  return stateSchema.reduce<StateSnapshot>((acc, field) => {
    acc[field.fieldName] = normalizeStateValueForBlock(record[field.fieldName], field.type);
    return acc;
  }, {});
}

function getConversationKnownState(
  storedState: unknown,
  history: HistoryMessage[],
  stateSchema: RuntimePromptConfig["stateSchema"]
): StateSnapshot {
  return (
    normalizeStoredStateSnapshot(storedState, stateSchema) ??
    getLatestKnownState(history, stateSchema)
  );
}

function buildStateUpdatePrompt(
  history: HistoryMessage[],
  latestUserMessage: string,
  knownState: StateSnapshot,
  promptConfig: RuntimePromptConfig
): string {
  if (usesConversationMemoryState(promptConfig.stateSchema)) {
    return `${promptConfig.guidelinesContext}
Current conversation state (JSON):
${renderStateUpdateJson(knownState, promptConfig.stateSchema)}

Update the state using only the current state above.
summary is long-term memory, and new_events contains the recent unsummarized events as a list of { action, observation, reward } objects.
Return only the full updated state JSON object.`;
  }

  return `${promptConfig.guidelinesContext}
Conversation history:
${formatHistoryForStatePrompt(historyWithoutLatestUserMessage(history, latestUserMessage))}

Previous known state (JSON):
${renderStateUpdateJson(knownState, promptConfig.stateSchema)}

Latest user message:
${latestUserMessage}

  Now update the patient state. Return only the JSON object.`;
}

function buildStateSubtreeUpdatePrompt(
  history: HistoryMessage[],
  latestUserMessage: string,
  knownState: StateSnapshot,
  promptConfig: RuntimePromptConfig
): string {
  if (usesConversationMemoryState(promptConfig.stateSchema)) {
    return `${promptConfig.guidelinesContext}
Current conversation state (JSON):
${renderStateUpdateJson(knownState, promptConfig.stateSchema)}

Now execute only the provided state subtree instructions.
Use only the current state above.
Return only the full updated state JSON object and nothing else.`;
  }

  return `${promptConfig.guidelinesContext}
Conversation history:
${formatHistoryForStatePrompt(historyWithoutLatestUserMessage(history, latestUserMessage))}

Previous known state (JSON):
${renderStateUpdateJson(knownState, promptConfig.stateSchema)}

Latest user message:
${latestUserMessage}

Now execute only the provided state subtree instructions.
Return only the full updated state JSON object and nothing else.`;
}

function buildStateHybridExtractionPrompt(
  history: HistoryMessage[],
  latestUserMessage: string,
  knownState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  promptPlan: StatePromptExtractionPlan | undefined,
  existingPromptValues: PromptValueSnapshot = {}
): string {
  const fields = normalizePromptExtractionFields(promptPlan);
  const extractionShape = renderPromptExtractionInstruction(fields);
  const extractionRules =
    fields.length > 0
      ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const contextPrompt =
    typeof promptPlan?.context_prompt === "string" ? promptPlan.context_prompt.trim() : "";
  const promptValuesJson =
    Object.keys(existingPromptValues).length > 0
      ? JSON.stringify(existingPromptValues, null, 2)
      : "(none)";

  if (usesConversationMemoryState(promptConfig.stateSchema)) {
    return `${promptConfig.guidelinesContext}
State flow instructions:
${promptConfig.stateUpdateSystemPrompt}

Current conversation state (JSON):
${renderStateUpdateJson(knownState, promptConfig.stateSchema)}

Previously extracted intermediate values (JSON):
${promptValuesJson}

${contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""}Extract only the intermediate values needed for deterministic state code.
Use only the current state above.
Do not return the final updated state object.
Use null for values that should not be set from this state.

${extractionShape}

Extraction rules:
${extractionRules}`;
  }

  return `${promptConfig.guidelinesContext}
State flow instructions:
${promptConfig.stateUpdateSystemPrompt}

Conversation history:
${formatHistoryForStatePrompt(historyWithoutLatestUserMessage(history, latestUserMessage))}

Previous known state (JSON):
${renderStateUpdateJson(knownState, promptConfig.stateSchema)}

Latest user message:
${latestUserMessage}

Previously extracted intermediate values (JSON):
${promptValuesJson}

${contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""}Extract only the intermediate values needed for deterministic state code.
Do not return the final updated state object.
Use null for values that should not be set from this message.

${extractionShape}

Extraction rules:
${extractionRules}`;
}

function buildStateTransformPrompt(
  history: HistoryMessage[],
  latestUserMessage: string,
  knownState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  incomingOutput: string,
  instruction: string,
  existingPromptValues: PromptValueSnapshot = {}
): string {
  const promptValuesJson =
    Object.keys(existingPromptValues).length > 0
      ? JSON.stringify(existingPromptValues, null, 2)
      : "(none)";

  if (usesConversationMemoryState(promptConfig.stateSchema)) {
    return `${promptConfig.guidelinesContext}
State flow instructions:
${promptConfig.stateUpdateSystemPrompt}

Current conversation state (JSON):
${renderStateUpdateJson(knownState, promptConfig.stateSchema)}

Current local values (JSON):
${promptValuesJson}

Current transform input value:
${incomingOutput}

Transform the current input value so it satisfies this instruction:
${instruction}

Use only the current state and local values above.
Return only the transformed local value.
Do not return the full state JSON object.
Do not mention these instructions.
Do not explain your work.
Do not add any extra wrapper text.`;
  }

  return `${promptConfig.guidelinesContext}
State flow instructions:
${promptConfig.stateUpdateSystemPrompt}

Conversation history:
${formatHistoryForStatePrompt(historyWithoutLatestUserMessage(history, latestUserMessage))}

Previous known state (JSON):
${renderStateUpdateJson(knownState, promptConfig.stateSchema)}

Latest user message:
${latestUserMessage}

Current local values (JSON):
${promptValuesJson}

Current transform input value:
${incomingOutput}

Transform the current input value so it satisfies this instruction:
${instruction}

Return only the transformed local value.
Do not return the full state JSON object.
Do not mention these instructions.
Do not explain your work.
Do not add any extra wrapper text.`;
}

function buildPolicyHybridExtractionPrompt(
  history: HistoryMessage[],
  updatedState: StateSnapshot,
  latestUserMessage: string,
  promptConfig: RuntimePromptConfig,
  promptPlan: StatePromptExtractionPlan | undefined,
  existingPromptValues: PromptValueSnapshot = {}
): string {
  const fields = normalizePromptExtractionFields(promptPlan);
  const extractionShape = renderPromptExtractionInstruction(fields);
  const extractionRules =
    fields.length > 0
      ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const contextPrompt =
    typeof promptPlan?.context_prompt === "string" ? promptPlan.context_prompt.trim() : "";
  const promptValuesJson =
    Object.keys(existingPromptValues).length > 0
      ? JSON.stringify(existingPromptValues, null, 2)
      : "(none)";

  if (usesConversationMemoryState(promptConfig.stateSchema)) {
    return `${promptConfig.guidelinesContext}
Policy flow instructions:
${promptConfig.policyExecutionSystemPrompt}

Current conversation state (JSON):
${renderStateUpdateJson(updatedState, promptConfig.stateSchema)}

Previously extracted intermediate values (JSON):
${promptValuesJson}

${contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""}Extract only the intermediate values needed for deterministic policy code.
Use only the current state above.
Do not return the final assistant response.
Use null for values that should not be set from this state.

${extractionShape}

Extraction rules:
${extractionRules}`;
  }

  return `${promptConfig.guidelinesContext}
Policy flow instructions:
${promptConfig.policyExecutionSystemPrompt}

Conversation history:
${formatHistoryForStatePrompt(history)}

Updated patient state (JSON):
${renderStateUpdateJson(updatedState, promptConfig.stateSchema)}

Latest user message:
${latestUserMessage}

Previously extracted intermediate values (JSON):
${promptValuesJson}

${contextPrompt ? `Focused subtree or node context:\n${contextPrompt}\n\n` : ""}Extract only the intermediate values needed for deterministic policy code.
Do not return the final assistant response.
Use null for values that should not be set from this message.

${extractionShape}

Extraction rules:
${extractionRules}`;
}

function buildPolicyExecutionPrompt(
  history: HistoryMessage[],
  updatedState: StateSnapshot,
  promptConfig: RuntimePromptConfig
): string {
  if (usesConversationMemoryState(promptConfig.stateSchema)) {
    return `${promptConfig.guidelinesContext}
Current conversation state (JSON):
${renderStateUpdateJson(updatedState, promptConfig.stateSchema)}

Now decide the next assistant step using only the current state above. Return only one of:
- assistant message body
- exact triage summary format`;
  }

  return `${promptConfig.guidelinesContext}
Conversation history:
${formatHistoryForStatePrompt(history)}

Updated patient state (JSON):
${renderStateUpdateJson(updatedState, promptConfig.stateSchema)}

Now decide the next assistant step using the updated state. Return only one of:
- assistant message body
- exact triage summary format`;
}

function buildExpansionPrompt(
  history: HistoryMessage[],
  updatedState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  expandLabel: string
): string {
  if (usesConversationMemoryState(promptConfig.stateSchema)) {
    return `${promptConfig.guidelinesContext}
Current conversation state (JSON):
${renderStateUpdateJson(updatedState, promptConfig.stateSchema)}

Referenced subtree:
${expandLabel}

Now execute only this referenced subtree using only the current state above and return only the assistant message body or the exact triage summary format.`;
  }

  return `${promptConfig.guidelinesContext}
Conversation history:
${formatHistoryForStatePrompt(history)}

Updated patient state (JSON):
${renderStateUpdateJson(updatedState, promptConfig.stateSchema)}

Referenced subtree:
${expandLabel}

Now execute only this referenced subtree and return only the assistant message body or the exact triage summary format.`;
}

function buildPolicySubtreeExecutionPrompt(
  history: HistoryMessage[],
  updatedState: StateSnapshot,
  promptConfig: RuntimePromptConfig
): string {
  if (usesConversationMemoryState(promptConfig.stateSchema)) {
    return `${promptConfig.guidelinesContext}
Current conversation state (JSON):
${renderStateUpdateJson(updatedState, promptConfig.stateSchema)}

Now execute only the provided policy subtree instructions using only the current state above and return only the assistant message body or the exact triage summary format.`;
  }

  return `${promptConfig.guidelinesContext}
Conversation history:
${formatHistoryForStatePrompt(history)}

Updated patient state (JSON):
${renderStateUpdateJson(updatedState, promptConfig.stateSchema)}

Now execute only the provided policy subtree instructions and return only the assistant message body or the exact triage summary format.`;
}

function buildPolicySubtreeExecutionAndExtractionPrompt(
  history: HistoryMessage[],
  updatedState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  promptPlan: StatePromptExtractionPlan | undefined,
  existingPromptValues: PromptValueSnapshot = {}
): string {
  const fields = normalizePromptExtractionFields(promptPlan);
  const extractionShape = renderPolicyDecisionExtractionInstruction(fields);
  const extractionRules =
    fields.length > 0
      ? fields.map((field) => `- ${field.name}: ${field.instruction}`).join("\n")
      : "- (none)";
  const promptValuesJson =
    Object.keys(existingPromptValues).length > 0
      ? JSON.stringify(existingPromptValues, null, 2)
      : "(none)";

  if (usesConversationMemoryState(promptConfig.stateSchema)) {
    return `${promptConfig.guidelinesContext}
Current conversation state (JSON):
${renderStateUpdateJson(updatedState, promptConfig.stateSchema)}

Previously extracted intermediate values (JSON):
${promptValuesJson}

Now execute only the provided policy subtree instructions using only the current state above.
Return the main policy subtree output in "assistant_reply".
Also extract the requested typed intermediate values for deterministic follow-up steps.
Do not explain your work.

${extractionShape}

Extraction rules:
${extractionRules}`;
  }

  return `${promptConfig.guidelinesContext}
Conversation history:
${formatHistoryForStatePrompt(history)}

Updated patient state (JSON):
${renderStateUpdateJson(updatedState, promptConfig.stateSchema)}

Previously extracted intermediate values (JSON):
${promptValuesJson}

Now execute only the provided policy subtree instructions.
Return the main policy subtree output in "assistant_reply".
Also extract the requested typed intermediate values for deterministic follow-up steps.
Do not explain your work.

${extractionShape}

Extraction rules:
${extractionRules}`;
}

function buildPolicyTransformPrompt(
  history: HistoryMessage[],
  updatedState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  incomingOutput: string,
  instruction: string
): string {
  if (usesConversationMemoryState(promptConfig.stateSchema)) {
    return `${promptConfig.guidelinesContext}
Current conversation state (JSON):
${renderStateUpdateJson(updatedState, promptConfig.stateSchema)}

Current incoming output:
${incomingOutput}

Transform the current incoming output so it satisfies this instruction:
${instruction}

Use only the current state above.
Return only the transformed assistant message body.
Do not mention these instructions.
Do not explain your work.
Do not add any extra wrapper text.`;
  }

  return `${promptConfig.guidelinesContext}
Conversation history:
${formatHistoryForStatePrompt(history)}

Updated patient state (JSON):
${renderStateUpdateJson(updatedState, promptConfig.stateSchema)}

Current incoming output:
${incomingOutput}

Transform the current incoming output so it satisfies this instruction:
${instruction}

Return only the transformed assistant message body.
Do not mention these instructions.
Do not explain your work.
Do not add any extra wrapper text.`;
}

// Live progress for the "thinking" indicator: as each pipeline stage runs, the route
// (when streaming) forwards a short human description of what the server is doing right
// now, so the client can show "Reviewing what you told me…" instead of anonymous dots.
export interface ChatStageEvent {
  // The internal runPrompt label the stage came from (e.g. "1-state-update").
  stage: string;
  // Human-facing description shown in the UI.
  text: string;
  ts: number;
}

// Request-scoped so concurrent turns never cross streams. runPrompt reads it from the
// async context; the store is unset (getStore() === undefined) on the non-streaming
// path, so emitting is a no-op there.
const stageEmitterStore = new AsyncLocalStorage<(event: ChatStageEvent) => void>();

// Map an internal runPrompt label to what the user sees. The three real stages of a
// turn — state update, the front-of-graph condition checks, and reply generation —
// read as a natural progression: Reviewing → Checking → Writing.
function describeStage(label: string | undefined): string {
  if (label && label.startsWith("1-state")) {
    return "Reviewing what you told me…";
  }
  if (label === "2-policy-extraction") {
    return "Checking for anything urgent…";
  }
  if (label === "2-policy-decision" || (label && label.startsWith("3-"))) {
    return "Writing a reply…";
  }
  return "Thinking…";
}

function emitChatStage(label: string | undefined): void {
  const emit = stageEmitterStore.getStore();
  if (emit) {
    emit({ stage: label ?? "unknown", text: describeStage(label), ts: Date.now() });
  }
}

async function runChatCompletion(
  openai: OpenAI,
  model: string,
  maxTokens: number,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
): Promise<string> {
  const completion = await openai.chat.completions.create({
    model,
    max_completion_tokens: maxTokens,
    // These pipeline calls are structured extraction/decision/reply steps, not
    // deep reasoning. gpt-5.4's default effort makes the state-extraction call
    // (LOOP 0) spend ~15s "thinking". "none" skips reasoning entirely and still
    // returns valid structured output, cutting that latency dramatically.
    // NOTE: gpt-5.4 does NOT support "minimal" (400 unsupported_value); the
    // valid tiers are 'none' | 'low' | 'medium' | 'high' | 'xhigh'.
    reasoning_effort: "none",
    messages,
  });

  return normalizeModelText(completion.choices[0]?.message?.content);
}

async function runPrompt(
  openai: OpenAI,
  model: string,
  maxTokens: number,
  systemPrompt: string | undefined,
  prompt: string,
  label?: string
): Promise<string> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  messages.push({ role: "user", content: prompt });

  const tag = label ? `[chat:${label}]` : "[chat]";
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${tag} SYSTEM PROMPT:\n${systemPrompt ?? "(none)"}`);
  console.log(`\n${tag} USER PROMPT:\n${prompt}`);

  // Tell the client what this turn is doing right now, just before the round trip.
  emitChatStage(label);

  const result = await runChatCompletion(openai, model, maxTokens, messages);

  console.log(`\n${tag} RESPONSE:\n${result}`);
  console.log(`${"=".repeat(60)}\n`);

  return result;
}

async function runPromptBasedStateUpdate(
  openai: OpenAI,
  history: HistoryMessage[],
  latestUserMessage: string,
  knownState: StateSnapshot,
  promptConfig: RuntimePromptConfig
): Promise<StateSnapshot> {
  const stateForPrompt = usesConversationMemoryState(promptConfig.stateSchema)
    ? appendObservationToConversationMemoryState(
        knownState,
        latestUserMessage,
        promptConfig.stateSchema
      )
    : knownState;
  const updatedStateReply = await runPrompt(
    openai,
    OPENAI_EXTRACTION_MODEL,
    OPENAI_MAX_TOKENS,
    promptConfig.stateUpdateSystemPrompt,
    buildStateUpdatePrompt(history, latestUserMessage, stateForPrompt, promptConfig),
    "1-state-update"
  );
  const parsedUpdatedState = parseStateUpdateReply(
    updatedStateReply,
    promptConfig.stateSchema,
    stateForPrompt
  );
  const updatedState = usesConversationMemoryState(promptConfig.stateSchema)
    ? parsedUpdatedState
    : mergeDeterministicStateFromLatestMessage(
        parsedUpdatedState,
        promptConfig.stateSchema,
        latestUserMessage
      );

  console.log("[chat:state-merge]", {
    latestUserMessage,
    parsedUpdatedState,
    updatedState,
  });

  return updatedState;
}

async function runPromptBasedStateSubtreeUpdate(
  openai: OpenAI,
  history: HistoryMessage[],
  latestUserMessage: string,
  knownState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  subtreePrompt: string
): Promise<StateSnapshot> {
  const updatedStateReply = await runPrompt(
    openai,
    OPENAI_EXTRACTION_MODEL,
    OPENAI_MAX_TOKENS,
    subtreePrompt,
    buildStateSubtreeUpdatePrompt(history, latestUserMessage, knownState, promptConfig),
    "1-state-subtree-update"
  );
  const parsedUpdatedState = parseStateUpdateReply(
    updatedStateReply,
    promptConfig.stateSchema,
    knownState
  );
  return usesConversationMemoryState(promptConfig.stateSchema)
    ? parsedUpdatedState
    : mergeDeterministicStateFromLatestMessage(
        parsedUpdatedState,
        promptConfig.stateSchema,
        latestUserMessage
      );
}

async function runPromptBasedStateExtraction(
  openai: OpenAI,
  history: HistoryMessage[],
  latestUserMessage: string,
  knownState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  promptPlan: StatePromptExtractionPlan | undefined,
  existingPromptValues: PromptValueSnapshot = {}
): Promise<PromptValueSnapshot | null> {
  const extractionReply = await runPrompt(
    openai,
    OPENAI_EXTRACTION_MODEL,
    OPENAI_MAX_TOKENS,
    undefined,
    buildStateHybridExtractionPrompt(
      history,
      latestUserMessage,
      knownState,
      promptConfig,
      promptPlan,
      existingPromptValues
    ),
    "1-state-extraction"
  );

  const promptValues = parseStatePromptExtractionReply(extractionReply, promptPlan);

  console.log("[chat:state-extraction]", {
    latestUserMessage,
    promptValues,
  });

  return promptValues;
}

async function runPromptBasedStateTransform(
  openai: OpenAI,
  history: HistoryMessage[],
  latestUserMessage: string,
  knownState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  incomingOutput: string,
  instruction: string,
  existingPromptValues: PromptValueSnapshot = {}
): Promise<string> {
  return runPrompt(
    openai,
    OPENAI_MODEL,
    OPENAI_MAX_TOKENS,
    undefined,
    buildStateTransformPrompt(
      history,
      latestUserMessage,
      knownState,
      promptConfig,
      incomingOutput,
      instruction,
      existingPromptValues
    ),
    "1-state-transform"
  );
}

async function runPromptBasedPolicyExtraction(
  openai: OpenAI,
  history: HistoryMessage[],
  updatedState: StateSnapshot,
  latestUserMessage: string,
  promptConfig: RuntimePromptConfig,
  promptPlan: StatePromptExtractionPlan | undefined,
  existingPromptValues: PromptValueSnapshot = {}
): Promise<PromptValueSnapshot | null> {
  const extractionReply = await runPrompt(
    openai,
    OPENAI_EXTRACTION_MODEL,
    OPENAI_MAX_TOKENS,
    undefined,
    buildPolicyHybridExtractionPrompt(
      history,
      updatedState,
      latestUserMessage,
      promptConfig,
      promptPlan,
      existingPromptValues
    ),
    "2-policy-extraction"
  );

  const promptValues = parseStatePromptExtractionReply(extractionReply, promptPlan);

  console.log("[chat:policy-extraction]", {
    latestUserMessage,
    promptValues,
  });

  return promptValues;
}

function hasPromptValueData(promptValues: PromptValueSnapshot): boolean {
  return Object.entries(promptValues).some(([key, value]) => {
    if (key === CARRIED_OUTPUT_PROMPT_VALUE_NAME) {
      return false;
    }

    if (value === null || value === undefined) {
      return false;
    }

    if (Array.isArray(value)) {
      return value.length > 0;
    }

    if (typeof value === "string") {
      return value.trim().length > 0;
    }

    return true;
  });
}

function conditionUsesPromptValues(condition: ConditionPlan | undefined): boolean {
  if (!condition) {
    return false;
  }

  switch (condition.kind) {
    case "all":
    case "any":
      return condition.conditions.some((entry) => conditionUsesPromptValues(entry));
    case "not":
      return conditionUsesPromptValues(condition.condition);
    case "prompt_value_empty":
    case "prompt_value_not_empty":
    case "prompt_value_equals":
    case "prompt_value_not_equals":
    case "prompt_value_includes":
    case "prompt_value_matches_regex":
      return true;
    default:
      return false;
  }
}

function stateValueSourceUsesPromptValues(source: StateValueSource | undefined): boolean {
  return source?.kind === "prompt_variable";
}

function stateCodeOperationUsesPromptValues(operation: StateCodeOperation): boolean {
  if (operation.kind === "append_list_item") {
    return stateValueSourceUsesPromptValues(operation.source);
  }

  if (operation.kind === "set_field" || operation.kind === "set_local") {
    return stateValueSourceUsesPromptValues(operation.source);
  }

  return false;
}

function stateCodeRuleUsesPromptValues(rule: StateCodeRule): boolean {
  return (
    conditionUsesPromptValues(rule.when) ||
    rule.ops.some((operation) => stateCodeOperationUsesPromptValues(operation))
  );
}

function filterStateCodePlanRules(
  plan: StateCodePlan | undefined,
  kind: "prompt_assisted" | "deterministic"
): StateCodePlan | undefined {
  if (!plan) {
    return undefined;
  }

  const rules = (plan.rules ?? []).filter((rule) =>
    kind === "prompt_assisted"
      ? stateCodeRuleUsesPromptValues(rule)
      : !stateCodeRuleUsesPromptValues(rule)
  );

  return {
    ...plan,
    rules,
    prompt_extraction_plan:
      kind === "prompt_assisted" ? plan.prompt_extraction_plan : undefined,
  };
}

function normalizeGraphStepId(stepId: string | null | undefined): string | null {
  const normalized = typeof stepId === "string" ? stepId.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

function resolveStateExecutionGraphMaxSteps(graph: StateExecutionGraph): number {
  const requested =
    typeof graph.max_steps === "number" && Number.isFinite(graph.max_steps)
      ? Math.trunc(graph.max_steps)
      : STATE_EXECUTION_GRAPH_DEFAULT_MAX_STEPS;

  return Math.min(
    Math.max(requested, 1),
    STATE_EXECUTION_GRAPH_HARD_MAX_STEPS
  );
}

function buildLegacyStateExecutionGraph(plan: StateCodePlan | undefined): StateExecutionGraph | null {
  if (!plan) {
    return null;
  }

  const deterministicPlan = filterStateCodePlanRules(plan, "deterministic");
  const promptAssistedPlan = filterStateCodePlanRules(plan, "prompt_assisted");
  const deterministicRules = deterministicPlan?.rules ?? [];
  const promptAssistedRules = promptAssistedPlan?.rules ?? [];
  const hasPromptExtractionFields =
    normalizePromptExtractionFields(promptAssistedPlan?.prompt_extraction_plan).length > 0;
  const steps: StateExecutionGraphStep[] = [];

  if (deterministicRules.length > 0) {
    steps.push({
      id: "legacy-deterministic-code",
      type: "code",
      rules: deterministicRules,
      next_step_id:
        promptAssistedRules.length > 0 && hasPromptExtractionFields
          ? "legacy-prompt-extract"
          : plan.fallback_to_prompt_when_no_rule_matches === true
            ? "legacy-fallback-full-prompt"
            : "legacy-end",
    });
  }

  if (promptAssistedRules.length > 0 && hasPromptExtractionFields) {
    steps.push({
      id: "legacy-prompt-extract",
      type: "prompt_extract",
      prompt_extraction_plan: promptAssistedPlan?.prompt_extraction_plan ?? { fields: [] },
      next_step_id: "legacy-prompt-assisted-code",
    });
    steps.push({
      id: "legacy-prompt-assisted-code",
      type: "code",
      rules: promptAssistedRules,
      on_match_step_id: "legacy-end",
      on_no_match_step_id:
        plan.fallback_to_prompt_when_no_rule_matches === true
          ? "legacy-fallback-full-prompt"
          : "legacy-end",
    });
  }

  if (plan.fallback_to_prompt_when_no_rule_matches === true) {
    steps.push({
      id: "legacy-fallback-full-prompt",
      type: "full_prompt_update",
      next_step_id: "legacy-end",
    });
  }

  steps.push({ id: "legacy-end", type: "end" });

  if (steps.length === 0) {
    return null;
  }

  return {
    entry_step_id: steps[0].id,
    max_steps: STATE_EXECUTION_GRAPH_DEFAULT_MAX_STEPS,
    steps,
  };
}

function resolveSkippedStateExecutionGraphStepTarget(step: StateExecutionGraphStep): string | null {
  if (step.else_step_id !== undefined) {
    return normalizeGraphStepId(step.else_step_id);
  }

  if (step.type === "code") {
    return normalizeGraphStepId(step.on_no_match_step_id ?? step.next_step_id);
  }

  if (step.type === "prompt_extract") {
    return normalizeGraphStepId(step.on_empty_step_id ?? step.next_step_id);
  }

  if (step.type === "tool_call") {
    return normalizeGraphStepId(step.next_step_id);
  }

  if (step.type === "prompt_subtree_update") {
    return normalizeGraphStepId(step.next_step_id);
  }

  if (step.type === "prompt_transform") {
    return normalizeGraphStepId(step.next_step_id);
  }

  if (step.type === "full_prompt_update") {
    return normalizeGraphStepId(step.next_step_id);
  }

  return null;
}

function getToolResultVariableName(
  toolName: string,
  resultVariable: string | undefined
): string {
  const normalized = resultVariable?.trim();
  return normalized && normalized.length > 0 ? normalized : toolName;
}

function shouldYieldAfterAsyncTool(
  promptValues: PromptValueSnapshot,
  resultBase: string
): boolean {
  const base = resultBase.trim();
  return Boolean(base && promptValues[`${base}_should_yield`] === true);
}

function renderAsyncYieldOutput(
  promptValues: PromptValueSnapshot,
  resultBase: string,
  visibleOutput: string
): string {
  const base = resultBase.trim();
  const summaryValue = promptValues[`${base}_summary`];
  const previewValue = promptValues[`${base}_preview`];
  const summary =
    typeof summaryValue === "string" ? summaryValue.trim() : "";
  const preview =
    typeof previewValue === "string" ? previewValue.trim() : "";
  return (
    visibleOutput.trim() ||
    summary ||
    preview ||
    "I have started that background work and will continue when it is ready."
  );
}

function buildOutputObjectFromPromptValues(
  promptValues: PromptValueSnapshot,
  fieldNames: string[] | null | undefined
): Record<string, unknown> | null {
  if (!Array.isArray(fieldNames) || fieldNames.length === 0) {
    return null;
  }

  const output: Record<string, unknown> = {};
  for (const rawName of fieldNames) {
    const name = rawName.trim();
    if (!name || !(name in promptValues)) {
      continue;
    }
    const value = promptValues[name];
    if (value !== undefined) {
      output[name] = value;
    }
  }

  return Object.keys(output).length > 0 ? output : {};
}

function buildStateToolInputContributions(
  promptValues: PromptValueSnapshot,
  inputObjectVariables: string[] | null | undefined,
  inputPromptValueNames: string[] | null | undefined
): unknown[] | undefined {
  const contributions: unknown[] = [];

  for (const name of inputObjectVariables ?? []) {
    if (!(name in promptValues)) {
      continue;
    }
    const value = promptValues[name];
    if (value !== undefined) {
      contributions.push(value);
    }
  }

  const promptValueContribution = buildOutputObjectFromPromptValues(
    promptValues,
    inputPromptValueNames
  );
  if (
    promptValueContribution &&
    Object.keys(promptValueContribution).length > 0
  ) {
    contributions.push(promptValueContribution);
  }

  return contributions.length > 0 ? contributions : undefined;
}

function parseToolInputContribution(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function buildDirectToolArgs(
  tool: CompiledToolDef,
  inputContributions: unknown[] | undefined
): Record<string, unknown> {
  const allowedKeys = new Set(Object.keys(tool.function.parameters?.properties ?? {}));
  const merged: Record<string, unknown> = {};

  for (const contribution of inputContributions ?? []) {
    const parsed = parseToolInputContribution(contribution);
    if (!parsed) {
      continue;
    }

    for (const [key, value] of Object.entries(parsed)) {
      if (allowedKeys.size > 0 && !allowedKeys.has(key)) {
        continue;
      }
      merged[key] = value;
    }
  }

  return merged;
}

async function runDirectCanvasTool(
  promptConfig: RuntimePromptConfig,
  toolName: string,
  resultVariable?: string,
  inputContributions?: unknown[],
  conversationId?: string
): Promise<PromptValueSnapshot> {
  const normalizedToolName = toolName.trim();
  const tool = promptConfig.toolsByName[normalizedToolName];

  if (!tool) {
    throw new RuntimeConfigError(
      `Chat configuration error: no compiled tool found for "${normalizedToolName}".`
    );
  }

  const toolArgs = buildDirectToolArgs(tool, inputContributions);
  const result = await dispatchTool(tool.config, toolArgs, {
    toolName: normalizedToolName,
    setupId: promptConfig.setupId,
    setupTable: promptConfig.setupTable,
    conversationId,
    awaitOpenClawCompletion: true,
  });
  if (!result.ok) {
    throw new RuntimeConfigError(
      `Chat configuration error: direct tool "${normalizedToolName}" failed: ${result.error ?? "Unknown error"}.`
    );
  }

  if (isAsyncRuntimeJobResult(result.data)) {
    return buildAsyncRuntimeJobPromptValueUpdates(
      getToolResultVariableName(normalizedToolName, resultVariable),
      result.data,
      tool.config.asyncContinuationPolicy
    );
  }

  return {
    [getToolResultVariableName(normalizedToolName, resultVariable)]: result.data ?? "",
  };
}

async function runStateExecutionGraph(
  openai: OpenAI,
  history: HistoryMessage[],
  latestUserMessage: string,
  knownState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  graph: StateExecutionGraph,
  runtimeContext: StateCodeRuntimeContext = {},
  conversationId?: string
): Promise<StateSnapshot> {
  const steps = Array.isArray(graph.steps) ? graph.steps : [];
  if (steps.length === 0) {
    return knownState;
  }

  const stepById = new Map(
    steps
      .map((step) => {
        const id = normalizeGraphStepId(step.id);
        return id ? [id, step] : null;
      })
      .filter((entry): entry is [string, StateExecutionGraphStep] => entry !== null)
  );

  const entryStepId = normalizeGraphStepId(graph.entry_step_id) ?? normalizeGraphStepId(steps[0]?.id);
  if (!entryStepId || !stepById.has(entryStepId)) {
    throw new RuntimeConfigError("Chat configuration error: state execution graph entry step is missing.");
  }

  let currentStepId: string | null = entryStepId;
  let currentState = knownState;
  let promptValues: PromptValueSnapshot =
    buildObservationIngressPromptValues(latestUserMessage);
  let stepsRun = 0;
  const maxSteps = resolveStateExecutionGraphMaxSteps(graph);

  while (currentStepId) {
    if (stepsRun >= maxSteps) {
      throw new RuntimeConfigError(
        `Chat configuration error: state execution graph exceeded max_steps (${maxSteps}).`
      );
    }

    const step = stepById.get(currentStepId);
    if (!step) {
      throw new RuntimeConfigError(
        `Chat configuration error: state execution graph step "${currentStepId}" was not found.`
      );
    }

    stepsRun += 1;

    if (
      step.when &&
      !evaluateStateCondition(
        step.when,
        currentState,
        promptConfig.stateSchema,
        promptValues
      )
    ) {
      currentStepId = resolveSkippedStateExecutionGraphStepTarget(step);
      continue;
    }

    if (step.type === "end") {
      break;
    }

    if (step.type === "code") {
      const codeResult = executeStateCodePlan(
        { rules: step.rules },
        currentState,
        promptConfig.stateSchema,
        promptValues,
        runtimeContext
      );

      currentState = codeResult.nextState;
      promptValues = codeResult.nextPromptValues;
      if (step.output_variable?.trim()) {
        const outputObject = buildOutputObjectFromPromptValues(
          promptValues,
          step.output_object_field_names
        );
        if (outputObject) {
          promptValues = setCarriedOutput(
            setPromptValue(promptValues, step.output_variable.trim(), outputObject),
            outputObject
          );
        }
      }
      currentStepId = codeResult.matchedAnyRule
        ? normalizeGraphStepId(step.on_match_step_id ?? step.next_step_id)
        : normalizeGraphStepId(step.on_no_match_step_id ?? step.next_step_id);
      continue;
    }

    if (step.type === "prompt_extract") {
      const extractedPromptValues = await runPromptBasedStateExtraction(
        openai,
        history,
        latestUserMessage,
        currentState,
        promptConfig,
        step.prompt_extraction_plan,
        promptValues
      );

      if (extractedPromptValues) {
        promptValues = { ...promptValues, ...extractedPromptValues };
      }

      const extractedAnyValue = extractedPromptValues ? hasPromptValueData(extractedPromptValues) : false;
      currentStepId = extractedAnyValue
        ? normalizeGraphStepId(step.on_value_step_id ?? step.next_step_id)
        : normalizeGraphStepId(step.on_empty_step_id ?? step.next_step_id);
      continue;
    }

    if (step.type === "tool_call") {
      try {
        const inputContributions = buildStateToolInputContributions(
          promptValues,
          step.input_object_variables,
          step.input_prompt_value_names
        );
        const toolPromptValues = await runDirectCanvasTool(
          promptConfig,
          step.tool_name,
          step.result_variable,
          inputContributions,
          conversationId
        );
        const toolResultKey = getToolResultVariableName(
          step.tool_name,
          step.result_variable
        );
        promptValues = {
          ...promptValues,
          ...toolPromptValues,
        };
        promptValues = setCarriedOutput(
          promptValues,
          toolPromptValues[toolResultKey]
        );
        currentStepId = normalizeGraphStepId(step.next_step_id);
        continue;
      } catch (error) {
        const errorStepId = normalizeGraphStepId(step.on_error_step_id);
        if (errorStepId) {
          currentStepId = errorStepId;
          continue;
        }
        throw error;
      }
    }

    if (step.type === "prompt_subtree_update") {
      currentState = await runPromptBasedStateSubtreeUpdate(
        openai,
        history,
        latestUserMessage,
        currentState,
        promptConfig,
        step.subtree_prompt
      );
      currentStepId = normalizeGraphStepId(step.next_step_id);
      continue;
    }

    if (step.type === "prompt_transform") {
      const inputVariable = getPromptTransformInputVariable(step);
      const outputVariable = getPromptTransformOutputVariable(step);
      const transformedOutput = await runPromptBasedStateTransform(
        openai,
        history,
        latestUserMessage,
        currentState,
        promptConfig,
        resolvePromptTransformInput(currentState, promptValues, inputVariable),
        step.instruction,
        promptValues
      );
      promptValues = setPromptTransformOutput(
        promptValues,
        outputVariable,
        transformedOutput
      );
      currentStepId = normalizeGraphStepId(step.next_step_id);
      continue;
    }

    currentState = await runPromptBasedStateUpdate(
      openai,
      history,
      latestUserMessage,
      currentState,
      promptConfig
    );
    currentStepId = normalizeGraphStepId(step.next_step_id);
  }

  return currentState;
}

async function runPromptBasedPolicy(
  openai: OpenAI,
  history: HistoryMessage[],
  updatedState: StateSnapshot,
  promptConfig: RuntimePromptConfig
): Promise<string> {
  return runPrompt(
    openai,
    OPENAI_MODEL,
    OPENAI_MAX_TOKENS,
    promptConfig.policyExecutionSystemPrompt,
    buildPolicyExecutionPrompt(history, updatedState, promptConfig),
    "2-policy-decision"
  );
}

async function runExpandPolicyPrompt(
  openai: OpenAI,
  history: HistoryMessage[],
  updatedState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  expandLabel: string
): Promise<string> {
  const expandPrompt =
    promptConfig.expandSystemPromptsByKey[normalizeExpandKey(expandLabel)] ?? null;

  if (!expandPrompt) {
    throw new RuntimeConfigError(
      `Chat configuration error: no expansion policy prompt found for "${expandLabel}".`
    );
  }

  return runPrompt(
    openai,
    OPENAI_MODEL,
    OPENAI_MAX_TOKENS,
    expandPrompt,
    buildExpansionPrompt(history, updatedState, promptConfig, expandLabel),
    `3-expand:${expandLabel}`
  );
}

async function runPolicySubtreeDecisionPrompt(
  openai: OpenAI,
  history: HistoryMessage[],
  updatedState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  subtreePrompt: string
): Promise<string> {
  return runPrompt(
    openai,
    OPENAI_MODEL,
    OPENAI_MAX_TOKENS,
    subtreePrompt,
    buildPolicySubtreeExecutionPrompt(history, updatedState, promptConfig),
    "3-subtree"
  );
}

async function runPolicySubtreeDecisionPromptWithExtraction(
  openai: OpenAI,
  history: HistoryMessage[],
  updatedState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  subtreePrompt: string,
  promptPlan: StatePromptExtractionPlan | undefined,
  existingPromptValues: PromptValueSnapshot = {}
): Promise<{ assistantReply: string; promptValues: PromptValueSnapshot | null }> {
  const reply = await runPrompt(
    openai,
    OPENAI_MODEL,
    OPENAI_MAX_TOKENS,
    subtreePrompt,
    buildPolicySubtreeExecutionAndExtractionPrompt(
      history,
      updatedState,
      promptConfig,
      promptPlan,
      existingPromptValues
    ),
    "3-subtree-extraction"
  );

  return parsePolicyDecisionExtractionReply(reply, promptPlan);
}

async function runPolicyPromptTransform(
  openai: OpenAI,
  history: HistoryMessage[],
  updatedState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  incomingOutput: string,
  instruction: string
): Promise<string> {
  return runPrompt(
    openai,
    OPENAI_MODEL,
    OPENAI_MAX_TOKENS,
    undefined,
    buildPolicyTransformPrompt(
      history,
      updatedState,
      promptConfig,
      incomingOutput,
      instruction
    ),
    "3-transform"
  );
}

async function resolvePolicyActionReply(
  openai: OpenAI,
  history: HistoryMessage[],
  updatedState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  action: PolicyCodeAction,
  promptValues: PromptValueSnapshot = {}
): Promise<string | null> {
  if (action.kind === "use_prompt") {
    return null;
  }

  if (action.kind === "expand") {
    return runExpandPolicyPrompt(openai, history, updatedState, promptConfig, action.label);
  }

  if (action.kind === "display") {
    return resolvePolicyDisplayOutput(action, updatedState, promptValues);
  }

  throw new Error(`Unsupported policy code action: ${JSON.stringify(action)}`);
}

function resolvePolicyExecutionGraphMaxSteps(graph: PolicyExecutionGraph): number {
  const requested =
    typeof graph.max_steps === "number" && Number.isFinite(graph.max_steps)
      ? Math.trunc(graph.max_steps)
      : STATE_EXECUTION_GRAPH_DEFAULT_MAX_STEPS;

  return Math.min(
    Math.max(requested, 1),
    STATE_EXECUTION_GRAPH_HARD_MAX_STEPS
  );
}

function normalizeAssistantReplyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function resolveCurrentPolicyOutput(
  promptValues: PromptValueSnapshot
): string {
  return normalizeAssistantReplyValue(
    promptValues[CARRIED_OUTPUT_PROMPT_VALUE_NAME]
  );
}

function resolvePolicyDisplayOutput(
  action: PolicyCodeAction,
  currentState: StateSnapshot,
  promptValues: PromptValueSnapshot
): string {
  if (action.kind !== "display") {
    return "";
  }

  const displayType = action.display_type === "video" ? "video" : "text";
  if (displayType === "video" && typeof action.video_url === "string") {
    return action.video_url.trim();
  }

  const inputVariable =
    typeof action.input_variable === "string" && action.input_variable.trim()
      ? action.input_variable.trim()
      : CARRIED_OUTPUT_PROMPT_VALUE_NAME;

  if (Object.prototype.hasOwnProperty.call(promptValues, inputVariable)) {
    return normalizeAssistantReplyValue(promptValues[inputVariable]);
  }

  if (Object.prototype.hasOwnProperty.call(currentState, inputVariable)) {
    return normalizeAssistantReplyValue(currentState[inputVariable]);
  }

  if (typeof action.message === "string" && action.message.trim()) {
    return renderPolicyActionMessage(action.message, currentState, promptValues);
  }

  return resolveCurrentPolicyOutput(promptValues);
}

function sanitizePromptValueUpdates(
  promptValues: PromptValueSnapshot | null | undefined
): PromptValueSnapshot | null {
  if (!promptValues) {
    return null;
  }

  if (!(CARRIED_OUTPUT_PROMPT_VALUE_NAME in promptValues)) {
    return promptValues;
  }

  const sanitized = { ...promptValues };
  delete sanitized[CARRIED_OUTPUT_PROMPT_VALUE_NAME];
  return sanitized;
}

function mergePromptValueUpdates(
  currentPromptValues: PromptValueSnapshot,
  nextPromptValues: PromptValueSnapshot | null | undefined
): PromptValueSnapshot {
  const sanitized = sanitizePromptValueUpdates(nextPromptValues);
  return sanitized ? { ...currentPromptValues, ...sanitized } : currentPromptValues;
}

function setPromptValue(
  promptValues: PromptValueSnapshot,
  key: string,
  value: unknown
): PromptValueSnapshot {
  return {
    ...promptValues,
    [key]: value,
  };
}

function setCarriedOutput(
  promptValues: PromptValueSnapshot,
  value: unknown
): PromptValueSnapshot {
  return setPromptValue(
    promptValues,
    CARRIED_OUTPUT_PROMPT_VALUE_NAME,
    normalizeAssistantReplyValue(value)
  );
}

function normalizePromptTransformVariableName(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function getPromptTransformInputVariable(step: {
  input_variable?: string | null;
}): string {
  return (
    normalizePromptTransformVariableName(step.input_variable) ||
    CARRIED_OUTPUT_PROMPT_VALUE_NAME
  );
}

function getPromptTransformOutputVariable(step: {
  output_variable?: string | null;
}): string {
  return (
    normalizePromptTransformVariableName(step.output_variable) ||
    CARRIED_OUTPUT_PROMPT_VALUE_NAME
  );
}

function resolvePromptTransformInput(
  currentState: StateSnapshot,
  promptValues: PromptValueSnapshot,
  inputVariable: string
): string {
  if (Object.prototype.hasOwnProperty.call(promptValues, inputVariable)) {
    return normalizeAssistantReplyValue(promptValues[inputVariable]);
  }

  if (Object.prototype.hasOwnProperty.call(currentState, inputVariable)) {
    return normalizeAssistantReplyValue(currentState[inputVariable]);
  }

  return "";
}

function setPromptTransformOutput(
  promptValues: PromptValueSnapshot,
  outputVariable: string,
  value: unknown
): PromptValueSnapshot {
  return outputVariable === CARRIED_OUTPUT_PROMPT_VALUE_NAME
    ? setCarriedOutput(promptValues, value)
    : setPromptValue(promptValues, outputVariable, value);
}

function buildLegacyPolicyExecutionGraph(plan: PolicyCodePlan | undefined): PolicyExecutionGraph | null {
  if (!plan) {
    return null;
  }

  const hasRules = (plan.rules?.length ?? 0) > 0;
  const needsFullPromptFallback =
    !plan.default_action || plan.default_action.kind === "use_prompt";
  const steps: PolicyExecutionGraphStep[] = [];

  if (hasRules || plan.default_action) {
    steps.push({
      id: "legacy-policy-code",
      type: "code",
      rules: plan.rules ?? [],
      default_action: plan.default_action,
      on_no_match_step_id: !plan.default_action && needsFullPromptFallback
        ? "legacy-policy-full-prompt"
        : undefined,
      on_use_prompt_step_id: needsFullPromptFallback
        ? "legacy-policy-full-prompt"
        : undefined,
    });
  }

  if (needsFullPromptFallback) {
    steps.push({
      id: "legacy-policy-full-prompt",
      type: "full_prompt_decision",
    });
  }

  if (steps.length === 0) {
    return null;
  }

  return {
    entry_step_id: steps[0].id,
    max_steps: STATE_EXECUTION_GRAPH_DEFAULT_MAX_STEPS,
    steps,
  };
}

function resolveSkippedPolicyExecutionGraphStepTarget(step: PolicyExecutionGraphStep): string | null {
  if (step.else_step_id !== undefined) {
    return normalizeGraphStepId(step.else_step_id);
  }

  if (step.type === "code") {
    return normalizeGraphStepId(step.on_no_match_step_id ?? step.next_step_id);
  }

  if (step.type === "prompt_extract") {
    return normalizeGraphStepId(step.on_empty_step_id ?? step.next_step_id);
  }

  if (step.type === "tool_call") {
    return normalizeGraphStepId(step.next_step_id);
  }

  if (step.type === "prompt_subtree_decision") {
    return normalizeGraphStepId(step.next_step_id);
  }

  if (step.type === "prompt_transform") {
    return normalizeGraphStepId(step.next_step_id);
  }

  if (step.type === "full_prompt_decision") {
    return normalizeGraphStepId(step.next_step_id);
  }

  if (step.type === "runtime_operation") {
    return normalizeGraphStepId(step.next_step_id);
  }

  return null;
}

// Collect the independent boolean-condition prompt_extract fields reachable from the
// policy graph's entry through only deterministic code routing, so they can be
// evaluated in a single extraction call instead of one round trip per condition.
// Conservative by construction: it follows only pure-routing code steps and other
// boolean-condition extract nodes, and stops at any node that can emit output or side
// effects (subtree decision, transform, tool call, runtime op, end, non-routing code),
// so a later fused condition can never depend on a value produced in between. Returns
// the deduped field union only when at least two condition nodes would be fused.
function collectBatchablePolicyConditionFields(
  steps: PolicyExecutionGraphStep[],
  entryStepId: string
): StatePromptExtractionField[] {
  const stepById = new Map<string, PolicyExecutionGraphStep>();
  for (const step of steps) {
    const id = normalizeGraphStepId(step.id);
    if (id) {
      stepById.set(id, step);
    }
  }

  const isBooleanConditionExtract = (
    step: PolicyExecutionGraphStep
  ): step is PolicyPromptExtractExecutionStep => {
    if (step.type !== "prompt_extract" || step.when) {
      return false;
    }
    const plan = step.prompt_extraction_plan;
    if (plan && typeof plan.context_prompt === "string" && plan.context_prompt.trim()) {
      return false;
    }
    const fields = normalizePromptExtractionFields(plan);
    return fields.length > 0 && fields.every((field) => field.type === "boolean");
  };

  const isPureRoutingCodeStep = (step: PolicyExecutionGraphStep): boolean => {
    if (step.type !== "code") {
      return false;
    }
    if (step.script_source && step.script_source.trim()) {
      return false;
    }
    if (step.output_variable && step.output_variable.trim()) {
      return false;
    }
    return true;
  };

  const outgoingTargets = (step: PolicyExecutionGraphStep): string[] => {
    const raw: Array<string | null | undefined> = [];
    if (step.type === "prompt_extract") {
      raw.push(step.on_value_step_id, step.on_empty_step_id, step.next_step_id);
    } else if (step.type === "code") {
      raw.push(
        step.on_match_step_id,
        step.on_no_match_step_id,
        step.on_use_prompt_step_id,
        step.next_step_id
      );
    }
    return raw
      .map((id) => normalizeGraphStepId(id))
      .filter((id): id is string => id !== null);
  };

  const MAX_NODES = 8;
  const visited = new Set<string>();
  const conditionNodeIds = new Set<string>();
  const fieldsByName = new Map<string, StatePromptExtractionField>();
  const queue: string[] = [entryStepId];

  while (queue.length > 0 && conditionNodeIds.size < MAX_NODES) {
    const id = normalizeGraphStepId(queue.shift());
    if (!id || visited.has(id)) {
      continue;
    }
    visited.add(id);
    const step = stepById.get(id);
    if (!step) {
      continue;
    }

    if (isBooleanConditionExtract(step)) {
      conditionNodeIds.add(id);
      for (const field of normalizePromptExtractionFields(step.prompt_extraction_plan)) {
        if (!fieldsByName.has(field.name)) {
          fieldsByName.set(field.name, field);
        }
      }
      queue.push(...outgoingTargets(step));
      continue;
    }

    if (isPureRoutingCodeStep(step)) {
      queue.push(...outgoingTargets(step));
      continue;
    }

    // Any other node type ends the batchable region on this branch.
  }

  return conditionNodeIds.size >= 2 ? [...fieldsByName.values()] : [];
}

async function runPolicyExecutionGraph(
  openai: OpenAI,
  history: HistoryMessage[],
  updatedState: StateSnapshot,
  latestUserMessage: string,
  promptConfig: RuntimePromptConfig,
  graph: PolicyExecutionGraph,
  runtimeContext: StateCodeRuntimeContext = {},
  conversationId?: string,
  visitedNodeRefsSink?: CanvasExecutionSourceNodeRef[]
): Promise<{
  assistantReply: string;
  visibleAssistantReply: string;
  nextState: StateSnapshot;
}> {
  const steps = Array.isArray(graph.steps) ? graph.steps : [];
  if (steps.length === 0) {
    return {
      assistantReply: await runPromptBasedPolicy(openai, history, updatedState, promptConfig),
      visibleAssistantReply: "",
      nextState: updatedState,
    };
  }

  const stepById = new Map(
    steps
      .map((step) => {
        const id = normalizeGraphStepId(step.id);
        return id ? [id, step] : null;
      })
      .filter((entry): entry is [string, PolicyExecutionGraphStep] => entry !== null)
  );

  const entryStepId = normalizeGraphStepId(graph.entry_step_id) ?? normalizeGraphStepId(steps[0]?.id);
  if (!entryStepId || !stepById.has(entryStepId)) {
    throw new RuntimeConfigError("Chat configuration error: policy execution graph entry step is missing.");
  }

  let currentStepId: string | null = entryStepId;
  let currentState = updatedState;
  let promptValues: PromptValueSnapshot =
    buildObservationIngressPromptValues(latestUserMessage);

  // Evaluate independent front-of-graph boolean conditions in one extraction call
  // rather than one round trip each. The seeded values are consumed by their
  // prompt_extract nodes below (which then skip their own call), so control flow is
  // unchanged — only the number of OpenAI round trips drops.
  if (POLICY_CONDITION_BATCHING_ENABLED && entryStepId) {
    const batchableFields = collectBatchablePolicyConditionFields(steps, entryStepId);
    if (batchableFields.length > 0) {
      const batchedValues = await runPromptBasedPolicyExtraction(
        openai,
        history,
        currentState,
        latestUserMessage,
        promptConfig,
        { fields: batchableFields },
        promptValues
      );
      if (batchedValues) {
        promptValues = mergePromptValueUpdates(promptValues, batchedValues);
      }
    }
  }

  const displayedReplies: string[] = [];
  const appendDisplayedReply = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      displayedReplies.push(trimmed);
    }
  };
  const resolveVisibleAssistantReply = () => displayedReplies.join("\n\n");
  let stepsRun = 0;
  const maxSteps = resolvePolicyExecutionGraphMaxSteps(graph);
  const appliedAsyncRuntimeOperationJobIds = new Set<string>();

  while (currentStepId) {
    if (stepsRun >= maxSteps) {
      throw new RuntimeConfigError(
        `Chat configuration error: policy execution graph exceeded max_steps (${maxSteps}).`
      );
    }

    const step = stepById.get(currentStepId);
    if (!step) {
      throw new RuntimeConfigError(
        `Chat configuration error: policy execution graph step "${currentStepId}" was not found.`
      );
    }

    stepsRun += 1;

    if (
      step.when &&
      !evaluateStateCondition(
        step.when,
        currentState,
        promptConfig.stateSchema,
        promptValues
      )
    ) {
      currentStepId = resolveSkippedPolicyExecutionGraphStepTarget(step);
      continue;
    }

    // Record the canvas nodes this executed step maps back to so the studio can
    // animate the exact path the runtime took through the policy graph.
    if (visitedNodeRefsSink && Array.isArray(step.sourceNodeRefs)) {
      visitedNodeRefsSink.push(...step.sourceNodeRefs);
    }

    if (step.type === "end") {
      const explicitMessage =
        "message" in step && typeof step.message === "string" ? step.message.trim() : "";

      if (explicitMessage) {
        return {
          assistantReply: renderPolicyActionMessage(explicitMessage, currentState, promptValues),
          visibleAssistantReply: resolveVisibleAssistantReply(),
          nextState: currentState,
        };
      }
      return {
        assistantReply: resolveCurrentPolicyOutput(promptValues),
        visibleAssistantReply: resolveVisibleAssistantReply(),
        nextState: currentState,
      };
    }

    if (step.type === "code") {
      if (step.language === "typescript" && step.script_source?.trim()) {
        const scriptResult = executeTypeScriptCodeStep({
          source: step.script_source,
          currentState,
          stateSchema: promptConfig.stateSchema,
          promptValues,
        });
        currentState = scriptResult.nextState;
        promptValues = scriptResult.nextPromptValues;
        if (step.output_variable?.trim()) {
          const outputObject = buildOutputObjectFromPromptValues(
            promptValues,
            step.output_object_field_names
          );
          if (outputObject) {
            promptValues = setPromptValue(
              promptValues,
              step.output_variable.trim(),
              outputObject
            );
          }
        }
        currentStepId = normalizeGraphStepId(
          step.on_match_step_id ?? step.next_step_id
        );
        continue;
      }

      const codeResult = executePolicyCodePlan(
        {
          rules: step.rules,
          default_action: step.default_action,
        },
        currentState,
        promptConfig.stateSchema,
        promptValues,
        runtimeContext
      );
      promptValues = codeResult.nextPromptValues;
      currentState = codeResult.nextState;
      const action = codeResult.action;

      if (!action) {
        currentStepId = normalizeGraphStepId(
          (codeResult.matchedAnyRule ? step.on_match_step_id : step.on_no_match_step_id) ??
            step.next_step_id
        );
        continue;
      }

      if (action.kind === "use_prompt") {
        currentStepId = normalizeGraphStepId(step.on_use_prompt_step_id ?? step.next_step_id);
        continue;
      }

      const continuationStepId = normalizeGraphStepId(step.on_match_step_id ?? step.next_step_id);
      const preparedReply: string =
        (await resolvePolicyActionReply(
          openai,
          history,
          currentState,
          promptConfig,
          action,
          promptValues
        )) ?? "";
      if (action.kind === "display") {
        appendDisplayedReply(preparedReply);
      }

      if (continuationStepId) {
        if (action.kind !== "display") {
          promptValues = setCarriedOutput(promptValues, preparedReply);
          if (step.output_variable?.trim()) {
            promptValues = setPromptValue(
              promptValues,
              step.output_variable.trim(),
              preparedReply
            );
          }
        }
        currentStepId = continuationStepId;
        continue;
      }

      return {
        assistantReply:
          action.kind === "display"
            ? resolveVisibleAssistantReply() ||
              resolveCurrentPolicyOutput(promptValues) ||
              preparedReply
            : preparedReply,
        visibleAssistantReply: resolveVisibleAssistantReply(),
        nextState: currentState,
      };
    }

    if (step.type === "prompt_extract") {
      // If a front-of-graph batch prefetch already extracted every field this node
      // needs, reuse those values instead of making a second identical call. The
      // reconstructed snapshot preserves the exact on_value/on_empty routing (a node
      // that produced any non-null value routes on_value; only an all-null result
      // routes on_empty — identical to a fresh extraction).
      const stepExtractionFields = normalizePromptExtractionFields(step.prompt_extraction_plan);
      const seededFromBatch =
        POLICY_CONDITION_BATCHING_ENABLED &&
        stepExtractionFields.length > 0 &&
        stepExtractionFields.every((field) => field.name in promptValues);

      let extractedPromptValues: PromptValueSnapshot | null;
      if (seededFromBatch) {
        extractedPromptValues = stepExtractionFields.reduce<PromptValueSnapshot>(
          (acc, field) => {
            acc[field.name] = promptValues[field.name];
            return acc;
          },
          {}
        );
      } else {
        extractedPromptValues = await runPromptBasedPolicyExtraction(
          openai,
          history,
          currentState,
          latestUserMessage,
          promptConfig,
          step.prompt_extraction_plan,
          promptValues
        );

        if (extractedPromptValues) {
          promptValues = mergePromptValueUpdates(promptValues, extractedPromptValues);
        }
      }

      const extractedAnyValue = extractedPromptValues ? hasPromptValueData(extractedPromptValues) : false;
      currentStepId = extractedAnyValue
        ? normalizeGraphStepId(step.on_value_step_id ?? step.next_step_id)
        : normalizeGraphStepId(step.on_empty_step_id ?? step.next_step_id);
      continue;
    }

    if (step.type === "tool_call") {
      try {
        const inputContributions = Array.isArray(step.input_object_variables)
          ? step.input_object_variables.map((name) => promptValues[name]).filter((value) => value !== undefined)
          : undefined;
        const toolPromptValues = await runDirectCanvasTool(
          promptConfig,
          step.tool_name,
          step.result_variable,
          inputContributions,
          conversationId
        );
        const toolResultKey = getToolResultVariableName(step.tool_name, step.result_variable);
        promptValues = mergePromptValueUpdates(promptValues, toolPromptValues);
        promptValues = setCarriedOutput(promptValues, toolPromptValues[toolResultKey]);
        if (shouldYieldAfterAsyncTool(promptValues, toolResultKey)) {
          const visibleAssistantReply = resolveVisibleAssistantReply();
          return {
            assistantReply: renderAsyncYieldOutput(
              promptValues,
              toolResultKey,
              visibleAssistantReply
            ),
            visibleAssistantReply,
            nextState: currentState,
          };
        }
        currentStepId = normalizeGraphStepId(step.next_step_id);
        continue;
      } catch {
        const errorStepId = normalizeGraphStepId(step.on_error_step_id);
        if (errorStepId) {
          currentStepId = errorStepId;
          continue;
        }
        return {
          assistantReply: "There was an error in fetching.",
          visibleAssistantReply: resolveVisibleAssistantReply(),
          nextState: currentState,
        };
      }
    }

    if (step.type === "prompt_subtree_decision") {
      const hasStructuredOutputs =
        normalizePromptExtractionFields(step.prompt_extraction_plan).length > 0;
      const subtreeResult = hasStructuredOutputs
          ? await runPolicySubtreeDecisionPromptWithExtraction(
            openai,
            history,
            currentState,
            promptConfig,
            step.subtree_prompt,
            step.prompt_extraction_plan,
            promptValues
          )
        : {
            assistantReply: await runPolicySubtreeDecisionPrompt(
              openai,
              history,
              currentState,
              promptConfig,
              step.subtree_prompt
            ),
            promptValues: null,
          };
      const subtreeReply = subtreeResult.assistantReply;
      if (subtreeResult.promptValues) {
        promptValues = mergePromptValueUpdates(
          promptValues,
          subtreeResult.promptValues
        );
      }
      const continuationStepId = normalizeGraphStepId(step.next_step_id);

      if (continuationStepId) {
        promptValues = setCarriedOutput(promptValues, subtreeReply);
        if (step.output_variable?.trim()) {
          promptValues = setPromptValue(
            promptValues,
            step.output_variable.trim(),
            subtreeReply
          );
        }
        currentStepId = continuationStepId;
        continue;
      }

      return {
        assistantReply: subtreeReply,
        visibleAssistantReply: resolveVisibleAssistantReply(),
        nextState: currentState,
      };
    }

    if (step.type === "prompt_transform") {
      const inputVariable = getPromptTransformInputVariable(step);
      const outputVariable = getPromptTransformOutputVariable(step);
      const transformedReply = await runPolicyPromptTransform(
        openai,
        history,
        currentState,
        promptConfig,
        resolvePromptTransformInput(currentState, promptValues, inputVariable),
        step.instruction
      );
      const continuationStepId = normalizeGraphStepId(step.next_step_id);

      if (continuationStepId) {
        promptValues = setPromptTransformOutput(
          promptValues,
          outputVariable,
          transformedReply
        );
        currentStepId = continuationStepId;
        continue;
      }

      return {
        assistantReply: transformedReply,
        visibleAssistantReply: resolveVisibleAssistantReply(),
        nextState: currentState,
      };
    }

    if (step.type === "runtime_operation") {
      const asyncJobResult = await runAsyncJobPolicyRuntimeStep({
        step,
        promptValues,
        onCompletedRuntimeOperationJob: async (jobId, result) => {
          if (
            result.runtime !== "chat" ||
            appliedAsyncRuntimeOperationJobIds.has(jobId)
          ) {
            return;
          }
          const nextState =
            result.contextSnapshot &&
            typeof result.contextSnapshot === "object" &&
            !Array.isArray(result.contextSnapshot) &&
            result.contextSnapshot.currentState &&
            typeof result.contextSnapshot.currentState === "object" &&
            !Array.isArray(result.contextSnapshot.currentState)
              ? (result.contextSnapshot.currentState as StateSnapshot)
              : null;
          if (!nextState) {
            return;
          }
          replaceStateSnapshot(currentState, nextState);
          appliedAsyncRuntimeOperationJobIds.add(jobId);
        },
      });
      if (asyncJobResult) {
        promptValues = {
          ...promptValues,
          ...asyncJobResult.promptValues,
        };
        promptValues = setCarriedOutput(
          promptValues,
          asyncJobResult.output ?? resolveCurrentPolicyOutput(promptValues)
        );
        currentStepId = normalizeGraphStepId(step.next_step_id);
        continue;
      }

      throw new RuntimeConfigError(
        `Chat configuration error: policy execution graph requested unsupported runtime_operation("${step.operation}").`
      );
    }

    const promptDecisionReply = await runPromptBasedPolicy(
      openai,
      history,
      currentState,
      promptConfig
    );
    const continuationStepId = normalizeGraphStepId(step.next_step_id);

    if (continuationStepId) {
      promptValues = setCarriedOutput(promptValues, promptDecisionReply);
      currentStepId = continuationStepId;
      continue;
    }

    return {
      assistantReply: promptDecisionReply,
      visibleAssistantReply: resolveVisibleAssistantReply(),
      nextState: currentState,
    };
  }

  throw new RuntimeConfigError(
    "Chat configuration error: policy execution graph ended without producing an assistant response."
  );
}

async function runStatefulAssistantTurn(
  openai: OpenAI,
  history: HistoryMessage[],
  latestUserMessage: string,
  knownState: StateSnapshot,
  promptConfig: RuntimePromptConfig,
  conversationId: string
): Promise<{
  assistantReply: string;
  nextState: StateSnapshot;
  nodeRefs: CanvasExecutionSourceNodeRef[];
}> {
  const policyVisitedNodeRefs: CanvasExecutionSourceNodeRef[] = [];
  const statePlan = promptConfig.executionPlan.state;
  const stateExecutionGraph =
    statePlan.code_plan?.execution_graph ?? buildLegacyStateExecutionGraph(statePlan.code_plan);
  let updatedState = knownState;
  const turnRuntimeContext: StateCodeRuntimeContext = {
    latestUserTurn: formatConversationMemoryTurn("user", latestUserMessage),
    latestObservationEvent: buildConversationMemoryObservationEvent({
      observation: latestUserMessage,
    }),
  };

  if (statePlan.mode === "full_prompt") {
    updatedState = await runPromptBasedStateUpdate(
      openai,
      history,
      latestUserMessage,
      knownState,
      promptConfig
    );
  } else {
    const nextState =
      stateExecutionGraph
          ? await runStateExecutionGraph(
            openai,
            history,
            latestUserMessage,
            knownState,
            promptConfig,
            stateExecutionGraph,
            turnRuntimeContext,
            conversationId
          )
        : executeStateCodePlan(
            statePlan.code_plan,
            knownState,
            promptConfig.stateSchema,
            buildObservationIngressPromptValues(latestUserMessage),
            turnRuntimeContext
          ).nextState;

    updatedState = usesConversationMemoryState(promptConfig.stateSchema)
      ? nextState
      : mergeDeterministicStateFromLatestMessage(
          nextState,
          promptConfig.stateSchema,
          latestUserMessage
        );
  }

  const policyPlan = promptConfig.executionPlan.policy;
  let assistantBodyReply: string;

  if (policyPlan.mode === "full_prompt") {
    assistantBodyReply = await runPromptBasedPolicy(
      openai,
      history,
      updatedState,
      promptConfig
    );
  } else {
    const policyExecutionGraph =
      policyPlan.code_plan?.execution_graph ?? buildLegacyPolicyExecutionGraph(policyPlan.code_plan);

    if (policyExecutionGraph) {
      const policyResult = await runPolicyExecutionGraph(
        openai,
        history,
        updatedState,
        latestUserMessage,
        promptConfig,
        policyExecutionGraph,
        turnRuntimeContext,
        conversationId,
        policyVisitedNodeRefs
      );
      updatedState = policyResult.nextState;
      // Prefer output routed through a Display node; fall back to the graph's
      // terminal reply for canvases authored without Display nodes so they
      // still render their final assistant message instead of erroring.
      assistantBodyReply = policyResult.visibleAssistantReply.trim()
        ? policyResult.visibleAssistantReply
        : policyResult.assistantReply;
      if (!assistantBodyReply.trim()) {
        throw new RuntimeConfigError(
          "Chat configuration error: policy execution graph produced no assistant response."
        );
      }
    } else {
      const codePolicyResult = executePolicyCodePlan(
        policyPlan.code_plan,
        updatedState,
        promptConfig.stateSchema,
        buildObservationIngressPromptValues(latestUserMessage),
        turnRuntimeContext
      );
      updatedState = codePolicyResult.nextState;
      const action = codePolicyResult.action;

      if (!action || action.kind === "use_prompt") {
        assistantBodyReply = await runPromptBasedPolicy(
          openai,
          history,
          updatedState,
          promptConfig
        );
      } else {
        assistantBodyReply =
          (await resolvePolicyActionReply(
            openai,
            history,
            updatedState,
            promptConfig,
            action,
            codePolicyResult.nextPromptValues
          )) ?? "";
      }
    }
  }

  const assistantBody = stripStateBlock(assistantBodyReply);
  const finalState = updatedState;

  return {
    assistantReply: assistantBody.trim(),
    nextState: finalState,
    nodeRefs: policyVisitedNodeRefs,
  };
}

async function saveAssistantReply(
  supabase: ChatRouteSupabaseClient,
  conversationId: string,
  content: string,
  state: StateSnapshot,
  stateSchema: RuntimePromptConfig["stateSchema"]
) {
  await supabase.from("messages").insert({
    conversation_id: conversationId,
    role: "assistant",
    content,
  });

  await supabase
    .from("conversations")
    .update({
      updated_at: new Date().toISOString(),
      current_state: serializeStateSnapshotForStateUpdate(state, stateSchema),
    })
    .eq("id", conversationId);
}

function buildTextResponse(content: string) {
  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * Observability trace events for one chat turn. Each OpenAI round-trip in the
 * stateful pipeline (state update, then policy) produces a request + response
 * pair, matching the shape the trace viewer renders.
 */
type ChatTraceEvent =
  | {
      kind: "openai_request";
      loop: number;
      // server wall-clock (ms) when the call started — lets the trace UI show
      // true per-call latency instead of stamping every event at client arrival
      ts: number;
      model: string;
      messages: Array<{ role: string; preview: string }>;
      tools: Array<{ name: string; description?: string }>;
    }
  | {
      kind: "openai_response";
      loop: number;
      // server wall-clock (ms) when the call returned
      ts: number;
      content: string;
      finishReason: string | null;
      toolCalls: Array<{ name: string; args: unknown }>;
    };

/**
 * Wrap an OpenAI client so every `chat.completions.create` call is recorded
 * into `sink` as request/response trace events. All other access passes
 * through to the real client. Used only when a request opts into tracing, so
 * the default (plain-text) chat path is unaffected.
 */
function createTracingOpenAIClient(openai: OpenAI, sink: ChatTraceEvent[]): OpenAI {
  let loop = 0;
  const realCreate = openai.chat.completions.create.bind(openai.chat.completions);
  const tracedCreate = (async (params: Record<string, unknown>) => {
    const myLoop = loop++;
    const messages = Array.isArray(params.messages)
      ? (params.messages as Array<{ role?: unknown; content?: unknown }>)
      : [];
    const tools = Array.isArray(params.tools)
      ? (params.tools as Array<{ function?: { name?: string; description?: string } }>)
      : [];
    sink.push({
      kind: "openai_request",
      loop: myLoop,
      ts: Date.now(),
      model: typeof params.model === "string" ? params.model : "(model)",
      messages: messages.map((m) => ({
        role: String(m.role ?? ""),
        preview: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      })),
      tools: tools.map((t) => ({ name: t.function?.name ?? "tool", description: t.function?.description })),
    });
    const res = (await realCreate(params as never)) as {
      choices?: Array<{
        message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
        finish_reason?: string;
      }>;
    };
    const choice = res?.choices?.[0];
    sink.push({
      kind: "openai_response",
      loop: myLoop,
      ts: Date.now(),
      content: choice?.message?.content ?? "",
      finishReason: choice?.finish_reason ?? null,
      toolCalls: (choice?.message?.tool_calls ?? []).map((c) => {
        let args: unknown = c.function?.arguments ?? null;
        try { args = JSON.parse(c.function?.arguments ?? "null"); } catch { /* keep raw */ }
        return { name: c.function?.name ?? "", args };
      }),
    });
    return res;
  }) as unknown;

  return new Proxy(openai, {
    get(target, prop, receiver) {
      if (prop === "chat") {
        const chat = Reflect.get(target, prop, receiver) as object;
        return new Proxy(chat, {
          get(ct, cprop) {
            if (cprop === "completions") {
              const comp = Reflect.get(ct, cprop) as object;
              return new Proxy(comp, {
                get(cm, mprop) {
                  if (mprop === "create") return tracedCreate;
                  const v = Reflect.get(cm, mprop);
                  return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(cm) : v;
                },
              });
            }
            const v = Reflect.get(ct, cprop);
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(ct) : v;
          },
        });
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as OpenAI;
}

export function createChatPostHandler(options: CreateChatRouteOptions) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const setupSource = resolveSetupSourceFromRequest(request);
      (options.logger ?? console).log("[api/chat/route] base handler", {
        referer: request.headers.get("referer") ?? "(none)",
        sourceTable: setupSource.sourceTable,
        setupEndpoint: setupSource.setupEndpoint,
      });
      const { userId } = await options.authenticate(request);

      if (!userId) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      const userUUID = await options.clerkIdToUUID(userId);
      const supabase =
        options.createSupabaseAdminClient() as ChatRouteSupabaseClient;
      const body = await request.json();
      const { conversationId, userMessage } = body;
      const trimmedUserMessage = userMessage?.trim();

      if (!conversationId || !trimmedUserMessage) {
        return Response.json({ error: "Bad request" }, { status: 400 });
      }

      const { data: convo } = await supabase
        .from("conversations")
        .select("id, current_state")
        .eq("id", conversationId)
        .eq("user_id", userUUID)
        .single();

      if (!convo) {
        return Response.json({ error: "Conversation not found" }, { status: 404 });
      }
      const conversationRow = convo as { current_state?: unknown };

      await supabase.from("messages").insert({
        conversation_id: conversationId,
        role: "user",
        content: trimmedUserMessage,
      });

      const { data: history } = await supabase
        .from("messages")
        .select("role, content")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      const orderedHistory: HistoryMessage[] = ((history ?? []) as HistoryMessage[]).map(
        (message) => ({
          role: message.role,
          content: message.content,
        })
      );

      const wantsTrace = body?.trace === true;
      const traceSink: ChatTraceEvent[] = [];
      const baseOpenAI = new OpenAI({ apiKey: process.env.AIRLAB_OPENAI_API_KEY });
      const openai = wantsTrace ? createTracingOpenAIClient(baseOpenAI, traceSink) : baseOpenAI;
      const promptConfig = await loadRuntimePromptConfig(supabase, setupSource);
      const knownState = getConversationKnownState(
        conversationRow.current_state,
        orderedHistory,
        promptConfig.stateSchema
      );

      // Streaming path: run the turn while forwarding live stage descriptions ("stage"
      // events) so the client can show what the server is doing, then emit one final
      // "result" event carrying the same payload the non-streaming JSON path returns.
      // Opt-in via `stream: true`, so existing JSON callers are unaffected.
      if (body?.stream === true) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const sendEvent = (event: string, payload: unknown) => {
              controller.enqueue(
                encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
              );
            };
            try {
              const turnResult = await stageEmitterStore.run(
                (stageEvent) => sendEvent("stage", stageEvent),
                () =>
                  runStatefulAssistantTurn(
                    openai,
                    orderedHistory,
                    trimmedUserMessage,
                    knownState,
                    promptConfig,
                    conversationId
                  )
              );
              await saveAssistantReply(
                supabase,
                conversationId,
                turnResult.assistantReply,
                turnResult.nextState,
                promptConfig.stateSchema
              );
              sendEvent("result", {
                content: turnResult.assistantReply,
                trace: wantsTrace ? traceSink : [],
                nodeRefs: turnResult.nodeRefs,
                state: serializeStateSnapshotForStateUpdate(
                  turnResult.nextState,
                  promptConfig.stateSchema
                ),
              });
            } catch (err) {
              (options.logger ?? console).error("Chat route stream error:", err);
              sendEvent("error", {
                error: err instanceof Error ? err.message : "Internal server error",
              });
            } finally {
              controller.close();
            }
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        });
      }

      const turnResult = await runStatefulAssistantTurn(
        openai,
        orderedHistory,
        trimmedUserMessage,
        knownState,
        promptConfig,
        conversationId
      );
      await saveAssistantReply(
        supabase,
        conversationId,
        turnResult.assistantReply,
        turnResult.nextState,
        promptConfig.stateSchema
      );
      if (wantsTrace) {
        return Response.json({
          content: turnResult.assistantReply,
          trace: traceSink,
          // The exact canvas nodes the policy graph traversed this turn, so the
          // studio can animate the path the runtime actually took.
          nodeRefs: turnResult.nodeRefs,
          // The patient state extracted this turn, so the studio's State pane can
          // show the current values (age, gender, etc.) the model is tracking.
          state: serializeStateSnapshotForStateUpdate(
            turnResult.nextState,
            promptConfig.stateSchema
          ),
        });
      }
      return buildTextResponse(turnResult.assistantReply);
    } catch (err) {
      (options.logger ?? console).error("Chat route error:", err);
      return Response.json(
        { error: err instanceof Error ? err.message : "Internal server error" },
        { status: 500 }
      );
    }
  };
}
