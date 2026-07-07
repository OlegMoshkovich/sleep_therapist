import type {
  SimulationPlayerDataset,
  SimulationPlayerDatasetRecord,
} from "../components/setup/dataset-schema";

export const CANVAS_RULE_REGISTRY_DATASET_NAME = "rule_registry";

export type CanvasRuleCheckMode = "preflight" | "rule_registry";
export type CanvasRuleScope = "policy" | "state" | "both" | "workflow";

export type CanvasRuleScalarValue = string | number | boolean;

export type CanvasRuleNodeDataPredicate = {
  key: string;
  equals?: CanvasRuleScalarValue;
  notEquals?: CanvasRuleScalarValue;
};

export type CanvasRuleStateFieldCondition = {
  fieldNames?: string[];
  fieldTypes?: string[];
};

export type CanvasRuleDeclarativeCheck = {
  kind: "node_count";
  nodeType: string;
  equals?: number;
  min?: number;
  max?: number;
  dataMatches?: CanvasRuleNodeDataPredicate[];
  whenStateField?: CanvasRuleStateFieldCondition;
};

export interface CanvasRuleDefinition {
  id: string;
  title: string;
  scope: CanvasRuleScope;
  checkMode: CanvasRuleCheckMode;
  description: string;
  repairGuidance: string;
  declarativeCheck?: CanvasRuleDeclarativeCheck;
  source?: string;
  sourceCanvasId?: string;
  sourceCanvasName?: string;
  sourceNodeId?: string;
  sourceNodeLabel?: string;
  sourceHash?: string;
}

interface CanvasRuleDatasetRow {
  id: string;
  title: string;
  scope: CanvasRuleScope;
  checkMode: CanvasRuleCheckMode;
  description: string;
  repairGuidance: string;
  enabled: boolean;
  check: string;
  source: string;
  sourceCanvasId?: string;
  sourceCanvasName?: string;
  sourceNodeId?: string;
  sourceNodeLabel?: string;
  sourceHash?: string;
}

const SEEDED_CANVAS_RULES: readonly CanvasRuleDatasetRow[] = [
  {
    id: "canvas_docs_should_be_normalized",
    title: "Normalize canvas docs before analysis",
    scope: "both",
    checkMode: "preflight",
    description:
      "Stored canvas docs should be normalized into canonical node and edge structure before any rule analysis runs.",
    repairGuidance:
      "Normalize the canvas doc in code before running issue detection or applying repairs.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "condition_nodes_must_be_real_conditions",
    title: "Condition nodes must express real branching conditions",
    scope: "both",
    checkMode: "rule_registry",
    description:
      "A condition node should only be used when its label is a genuine branching condition and its outgoing flow represents a real branch rather than a prompt instruction.",
    repairGuidance:
      "Convert prompt-like conditions into action nodes, or split a prompt preface from the actual condition when both are needed.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "canvas_must_have_single_start_node",
    title: "Canvas must have one START node",
    scope: "both",
    checkMode: "rule_registry",
    description:
      "Each canvas should contain exactly one START node. Duplicate START nodes make the flow ambiguous and can cause parts of the canvas to be ignored.",
    repairGuidance:
      "Add a START node if one is missing. If there are duplicates, keep the canonical START node for the intended entry point, delete any extra START nodes, and reconnect their outgoing flow only when it represents reachable behavior that should remain in the canvas.",
    enabled: true,
    check: JSON.stringify({
      kind: "node_count",
      nodeType: "start",
      equals: 1,
    }),
    source: "existing_rule",
  },
  {
    id: "if_conditions_must_have_distinct_true_false_branches",
    title: "IF conditions must branch through distinct TRUE and FALSE edges",
    scope: "both",
    checkMode: "rule_registry",
    description:
      "A condition node should have exactly one TRUE edge and one FALSE edge, and those two branches should lead to different target nodes.",
    repairGuidance:
      "Repair malformed condition wiring so each IF has one TRUE edge and one FALSE edge, with each branch leading to a different downstream node.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "clarification_gates_must_split_prompt_and_branch",
    title: "Clarification gates must separate prompting from branching",
    scope: "policy",
    checkMode: "rule_registry",
    description:
      "On policy canvases, a clarification gate should not combine 'ask the user something' prompt text with the branch condition itself in a single condition node.",
    repairGuidance:
      "Rewrite the original node into a prompt action, add a follow-up condition node with the actual branch condition, and reconnect the true/false paths.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "policy_nodes_must_describe_runtime_behavior",
    title: "Policy nodes must describe runtime behavior",
    scope: "policy",
    checkMode: "rule_registry",
    description:
      "Policy canvas labels should describe the runtime behavior of the target demo and should not leak setup-authoring or editing-workflow language.",
    repairGuidance:
      "Rewrite leaked labels so they describe the target demo's behavior, constraints, or runtime state rather than the editor workflow.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "code_nodes_must_have_executable_backing",
    title: "Code nodes must have executable backing",
    scope: "both",
    checkMode: "rule_registry",
    description:
      "A canvas node should remain in Code mode only when it has TypeScript source or deterministic Visual ops that the runtime can execute.",
    repairGuidance:
      "Keep Code mode for nodes with executable TypeScript source or supported executable Visual ops. Convert unsupported Visual ops instructions or free-form procedural text into prompt/model nodes.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "deterministic_state_updates_should_use_code_nodes",
    title: "Deterministic state updates should use Code nodes",
    scope: "state",
    checkMode: "rule_registry",
    description:
      "On state canvases, a node that only performs supported deterministic state or local mutations should be authored as a Code node rather than a Prompt node. Prompt nodes are for extraction, summarization, open-ended interpretation, or model-written state updates.",
    repairGuidance:
      "Convert prompt/action nodes whose label, executable ops, or TypeScript source can run as supported deterministic state code into Code mode while preserving the label, executable backing, wiring, and local outputs. Do not convert nodes that require model reasoning or prompt extraction.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "policy_canvases_must_have_editable_commit_code",
    title: "Policy canvases must commit internally and publish with Display",
    scope: "policy",
    checkMode: "rule_registry",
    description:
      "A non-reward policy canvas should be built from the editable starter template Start -> fallback action Prompt -> commit Code node -> Display node. Project-specific behavior replaces the fallback prompt before the commit/display tail. The commit node records the finalized policy output as the latest action/new_events entry and must be an ordinary editable Code node, not a runtime-managed or read-only node. The Display node is the only node that publishes visible policy output. Reward canvases use the reward calculation Code-node rule instead.",
    repairGuidance:
      "For non-reward policy canvases, if the commit node or final Display node is missing, restore the editable commit Code node and Display node from the starter policy template and wire all non-terminated terminal policy paths into the commit/display tail. If the commit node exists but is Prompt/action/read-only/runtime-managed, convert it to an editable Code node with the starter commit backing while preserving intentional project-specific upstream behavior. For reward canvases, preserve the reward calculation Code tail instead of adding a policy commit/display tail.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "reward_canvases_end_with_calculation_code",
    title: "Reward canvases end with calculation Code",
    scope: "policy",
    checkMode: "rule_registry",
    description:
      "A reward canvas for an agent-connection direction should start from the editable reward starter template and terminate in one ordinary editable Code node that calculates or normalizes the scalar reward value. Earlier nodes may be Prompt, condition, tool, or other reasoning/preparation nodes, but every non-terminated reward path should flow into the final reward calculation Code node. The code node should set reward/scalar_reward and carried_output to the numeric reward so simulations and live sessions can consume it.",
    repairGuidance:
      "Restore or add a final editable TypeScript Code node for reward calculation, wire all non-terminated reward paths into it, and ensure it writes the scalar value to carried_output plus a numeric reward or scalar_reward local. Do not finish reward canvases with a Display node or the normal policy commit/display tail unless a separate visible diagnostic output is explicitly needed before the final calculation.",
    enabled: true,
    check: "",
    source: "new_rule",
  },
  {
    id: "source_connection_policies_must_not_yield_for_target_response",
    title: "Source connection policies must not yield for the target response",
    scope: "policy",
    checkMode: "rule_registry",
    description:
      "On the source/primary side policy canvas for an agent connection A -> B, do not add a Yield/End Turn node whose purpose is to receive or wait for a response from that same connected target agent B. That canvas describes A's policy for the pairwise interaction, not a receive-response subflow from B. If A needs to invoke a different connected agent C while handling the A -> B policy, use a Call Agent node targeting C instead.",
    repairGuidance:
      "Remove Yield nodes that receive, await, or route a response from the same connected target agent. Put B's response behavior in B's target policy canvas or model it as a later observation/event, and use Call Agent nodes only when A intentionally calls another connected agent such as C. Keep Yield for true end-of-turn/future-event waits such as user input or async job continuation.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "text_agent_actions_require_display_node",
    title: "Text agent actions require Display nodes",
    scope: "policy",
    checkMode: "rule_registry",
    description:
      "If an agent's action type is text and the canvas is not a reward canvas, its policy canvas must include a Display node that publishes the text action. Prompt, prompt-transform, full-prompt, expand, and tool output remain internal local values until a Display node makes the value visible.",
    repairGuidance:
      "For non-reward policy canvases, add a policy Display node with data.displayType=\"text\" and wire each non-terminated text-producing terminal path into it. Use inputVariable=\"carried_output\" for direct prompt/expand/tool output, use the prompt transform's explicit outputVariable when one is set, or use inputVariable=\"agent_latest_action\" when the path first commits the final text action into latest-action state. Reward canvases should end in a scalar reward calculation Code node instead of adding Display solely to publish the reward value.",
    enabled: true,
    check: JSON.stringify({
      kind: "node_count",
      nodeType: "display",
      min: 1,
      dataMatches: [{ key: "displayType", notEquals: "video" }],
      whenStateField: {
        fieldNames: ["agent_latest_action", "environment_latest_action"],
        fieldTypes: ["string", "text"],
      },
    }),
    source: "existing_rule",
  },
  {
    id: "state_canvases_must_start_with_editable_ingress_append_code",
    title: "State canvases must start with an editable ingress append Code node",
    scope: "state",
    checkMode: "rule_registry",
    description:
      'A state canvas should be built from the editable starter state template whose first node after Start is a Code node that appends the latest event to new_events. Every agent state canvas uses "Add agent_latest_observation and agent_latest_reward to new_events."; the runtime resolves those fields against that agent connection participant. It must be ordinary editable canvas code, not runtime-managed or read-only.',
    repairGuidance:
      "If the ingress append node is missing or malformed, restore an editable Code node immediately after Start. Use executable append_list_item backing for new_events from latest_observation_and_reward_event with local inputs agent_latest_observation and agent_latest_reward. Preserve project-specific downstream summary/state update behavior.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "state_canvases_must_include_summary_memory_gate",
    title: "State canvases must include the 4000-character summary memory gate",
    scope: "state",
    checkMode: "rule_registry",
    description:
      'A state canvas should preserve the editable starter memory path after ingress: condition "summary plus new_events exceeds 4000 characters", TRUE to Prompt "Update summary with a concise summary of summary plus new_events.", then Code "Set new_events to empty list.", with both the FALSE branch and clear-new_events path continuing into the remaining state-update path.',
    repairGuidance:
      'If the summary memory path is missing or malformed, restore it immediately after the ingress append Code node. Use condition "summary plus new_events exceeds 4000 characters"; wire TRUE to Prompt "Update summary with a concise summary of summary plus new_events."; wire that prompt to editable Code "Set new_events to empty list." with executable set_field backing for new_events=[]; wire both the FALSE branch and the clear-new_events node into the remaining project-specific state update path.',
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "workflow_canvases_must_show_temporal_stage_process",
    title: "Workflow canvases must show concrete temporal stages",
    scope: "workflow",
    checkMode: "rule_registry",
    description:
      "Workflow canvases are temporal process maps. Each stage node should represent one concrete time-bounded stage in the expert workflow, and the graph should show the real order in which stages happen. Retries, repeated evaluations, revisions, or iteration should appear as explicit visible loops or conditional returns on the workflow canvas rather than only being described in prose.",
    repairGuidance:
      "Rewrite broad category or capability nodes into concrete stage nodes, preserve stage nodes only for real temporal stages, and wire the normal ordered path explicitly. If a later stage can return to an earlier stage, add a visible back-edge or loop structure with a condition label such as needs revision, evaluation failed, or more material needed. Keep implementation details, state variables, policy logic, and reward logic out of workflow canvases.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "policy_rewrite_steps_should_use_prompt_transform",
    title: "Policy rewrite steps should use Prompt transform",
    scope: "policy",
    checkMode: "rule_registry",
    description:
      "On policy canvases, prompt nodes whose job is to rewrite, format, summarize, condense, finalize, or otherwise transform an existing local or state value should be marked as Prompt transform rather than ordinary Prompt.",
    repairGuidance:
      "Set the node's prompt subtype/actionType to prompt_transform when it rewrites an existing value such as carried_output, a state field, a tool result, assistant reply draft, or prompt-produced output. Set data.inputVariable to the source local or state field and data.outputVariable to the newly defined local when known. Preserve labels and wiring. Keep ordinary Prompt for nodes that generate new content from state or ask the user/environment for information.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "state_field_model_updates_should_stay_prompt_nodes",
    title: "Model-written state field updates should stay Prompt nodes",
    scope: "state",
    checkMode: "rule_registry",
    description:
      "On state canvases, prompt nodes that update a state field using model judgment, such as updating a summary from the current observation, should remain ordinary Prompt/update nodes. Prompt transform is reserved for rewriting an existing local or state value before another step consumes it.",
    repairGuidance:
      "Do not convert state-field update prompts into prompt_transform merely because they rewrite text. Use prompt_transform on state canvases only for local or state value transforms that produce a new local, and use a later Code or Prompt update step to commit that value to state if needed.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "consumed_local_values_must_have_preceding_producers",
    title: "Consumed local values must have preceding producers",
    scope: "both",
    checkMode: "rule_registry",
    description:
      "Any node that consumes a local or prompt value must be reachable only after a preceding node produces that value. This includes Display nodes, commit/code nodes, prompt transforms, tool inputs, and any node that reads variables such as carried_output, finalized assistant text, action, observation, reward, or tool results. START labels provide entry context only; they do not produce runtime local values.",
    repairGuidance:
      "Add, move, or reconnect a visible producing node before the consumer on every reachable path, or change the consumer to read a value that is already produced. Valid producers may be prompt, prompt_transform, prompt extraction, tool_call, code, or another explicit runtime value-producing node. If runtime-generation instructions currently live only in START, move or copy them into an explicit producing node and keep START as concise entry context.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "local_inputs_must_be_defined_on_all_paths",
    title: "Declared local inputs must be defined on every path",
    scope: "both",
    checkMode: "rule_registry",
    description:
      "When a node declares a local input, that local variable must be available on every control-flow path that can reach the node. A value defined on only one branch is not safe to read after the branch rejoins.",
    repairGuidance:
      "Define the local before the branch, define it on every branch, add an explicit default/merge before the consuming node, or remove the declared input if the node does not actually read it.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
  {
    id: "prompt_subtree_steps_must_not_overlap_on_execution_path",
    title: "Prompt subtree steps must not overlap on one execution path",
    scope: "both",
    checkMode: "rule_registry",
    description:
      "Compiled prompt-subtree steps should not cover the same canvas node when one of those steps can execute after the other on the same policy or state path. Same-path overlap can run the same prompt instructions twice, and a later state/policy model call can overwrite outputs produced by the earlier one.",
    repairGuidance:
      "Restructure the canvas so each prompt subtree owns a disjoint segment on every execution path. Split the upstream prompt into a single-node prompt before the downstream subtree, or move shared downstream work into one explicit later segment. Branch alternatives may share conceptual downstream behavior, but a single executed path should not run two prompt-subtree steps that both include the same source node.",
    enabled: true,
    check: "",
    source: "existing_rule",
  },
] as const;

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function isCanvasRuleRegistryDatasetName(value: string): boolean {
  return normalizeKey(value) === CANVAS_RULE_REGISTRY_DATASET_NAME;
}

function createRuleRegistryColumn(
  makeId: () => string,
  name: string,
  type: "string" | "boolean" = "string"
) {
  return {
    id: makeId(),
    name,
    type,
  };
}

function createRuleRegistryColumns(makeId: () => string) {
  return [
    createRuleRegistryColumn(makeId, "id"),
    createRuleRegistryColumn(makeId, "title"),
    createRuleRegistryColumn(makeId, "scope"),
    createRuleRegistryColumn(makeId, "checkMode"),
    createRuleRegistryColumn(makeId, "description"),
    createRuleRegistryColumn(makeId, "repairGuidance"),
    createRuleRegistryColumn(makeId, "enabled", "boolean"),
    createRuleRegistryColumn(makeId, "check"),
    createRuleRegistryColumn(makeId, "source"),
    createRuleRegistryColumn(makeId, "sourceCanvasId"),
    createRuleRegistryColumn(makeId, "sourceCanvasName"),
    createRuleRegistryColumn(makeId, "sourceNodeId"),
    createRuleRegistryColumn(makeId, "sourceNodeLabel"),
    createRuleRegistryColumn(makeId, "sourceHash"),
  ];
}

function stringifyDeclarativeCheck(
  check: CanvasRuleDeclarativeCheck | undefined
): string {
  return check ? JSON.stringify(check) : "";
}

function createRuleRegistryRecord(
  rule: CanvasRuleDefinition,
  columns: ReturnType<typeof createRuleRegistryColumns>,
  makeId: () => string
): SimulationPlayerDatasetRecord {
  const columnByName = new Map(
    columns.map((column) => [normalizeKey(column.name), column.id])
  );

  const values: Record<string, string> = {};
  const write = (name: string, value: string | undefined) => {
    const columnId = columnByName.get(normalizeKey(name));
    if (columnId) {
      values[columnId] = value ?? "";
    }
  };

  write("id", rule.id);
  write("title", rule.title);
  write("scope", rule.scope);
  write("checkMode", rule.checkMode);
  write("description", rule.description);
  write("repairGuidance", rule.repairGuidance);
  write("enabled", "true");
  write("check", stringifyDeclarativeCheck(rule.declarativeCheck));
  write("source", rule.source);
  write("sourceCanvasId", rule.sourceCanvasId);
  write("sourceCanvasName", rule.sourceCanvasName);
  write("sourceNodeId", rule.sourceNodeId);
  write("sourceNodeLabel", rule.sourceNodeLabel);
  write("sourceHash", rule.sourceHash);

  return {
    id: makeId(),
    values,
  };
}

function buildCanvasRuleRegistryDataset(args: {
  existingDataset?: SimulationPlayerDataset;
  rules: readonly CanvasRuleDefinition[];
  makeId: () => string;
}): SimulationPlayerDataset {
  const columns = createRuleRegistryColumns(args.makeId);

  return {
    id: args.existingDataset?.id ?? args.makeId(),
    name: CANVAS_RULE_REGISTRY_DATASET_NAME,
    notes:
      "Daemon-owned canvas rule registry. Rows are the active rules the daemon uses while inspecting and repairing target canvases. The optional check column accepts safe declarative JSON such as {\"kind\":\"node_count\",\"nodeType\":\"start\",\"equals\":1}, with optional dataMatches and whenStateField predicates.",
    columns,
    records: args.rules.map((rule) =>
      createRuleRegistryRecord(rule, columns, args.makeId)
    ),
  };
}

export function createCanvasRuleRegistryDataset(
  makeId: () => string
): SimulationPlayerDataset {
  return buildCanvasRuleRegistryDataset({
    rules: getSeededCanvasRuleDefinitions(),
    makeId,
  });
}

export function replaceCanvasRuleRegistryDataset(
  datasets: SimulationPlayerDataset[],
  rules: readonly CanvasRuleDefinition[],
  makeId: () => string
): SimulationPlayerDataset[] {
  const existingDataset = datasets.find((dataset) =>
    isCanvasRuleRegistryDatasetName(dataset.name)
  );
  const replacement = buildCanvasRuleRegistryDataset({
    existingDataset,
    rules,
    makeId,
  });

  return [
    ...datasets.filter(
      (dataset) => !isCanvasRuleRegistryDatasetName(dataset.name)
    ),
    replacement,
  ];
}

function readRecordByColumnName(
  dataset: SimulationPlayerDataset,
  record: SimulationPlayerDatasetRecord
): Record<string, string> {
  return dataset.columns.reduce<Record<string, string>>((acc, column) => {
    acc[normalizeKey(column.name)] = record.values[column.id] ?? "";
    return acc;
  }, {});
}

function readRowString(
  row: Record<string, string>,
  names: string[]
): string {
  for (const name of names) {
    const value = row[normalizeKey(name)]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function readRowBoolean(
  row: Record<string, string>,
  names: string[],
  fallback: boolean
): boolean {
  const value = readRowString(row, names);
  if (!value) {
    return fallback;
  }

  if (/^(true|yes|1|enabled)$/i.test(value)) {
    return true;
  }
  if (/^(false|no|0|disabled)$/i.test(value)) {
    return false;
  }
  return fallback;
}

function normalizeRuleId(value: string): string {
  return normalizeKey(value).replace(/[^a-z0-9_]/g, "");
}

function normalizeScope(value: string): CanvasRuleScope {
  const normalized = normalizeKey(value);
  if (
    normalized === "policy" ||
    normalized === "state" ||
    normalized === "workflow"
  ) {
    return normalized;
  }
  return "both";
}

function normalizeCheckMode(value: string): CanvasRuleCheckMode {
  return normalizeKey(value) === "preflight" ? "preflight" : "rule_registry";
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
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

function parseScalarValue(value: unknown): CanvasRuleScalarValue | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}

function parseNodeDataPredicates(
  value: unknown
): CanvasRuleNodeDataPredicate[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const predicates = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const key =
      typeof record.key === "string"
        ? record.key.trim()
        : typeof record.path === "string"
          ? record.path.trim()
          : "";
    if (!key) {
      return [];
    }

    const equals = parseScalarValue(record.equals);
    const notEquals = parseScalarValue(record.notEquals ?? record.not_equals);
    if (equals === undefined && notEquals === undefined) {
      return [];
    }

    return [
      {
        key,
        ...(equals !== undefined ? { equals } : {}),
        ...(notEquals !== undefined ? { notEquals } : {}),
      },
    ];
  });

  return predicates.length > 0 ? predicates : undefined;
}

function parseStateFieldCondition(
  value: unknown
): CanvasRuleStateFieldCondition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const fieldNames = parseStringList(
    record.fieldNames ?? record.field_names ?? record.fieldName ?? record.field_name
  );
  const fieldTypes = parseStringList(
    record.fieldTypes ?? record.field_types ?? record.fieldType ?? record.field_type
  );

  return fieldNames.length === 0 && fieldTypes.length === 0
    ? undefined
    : {
        ...(fieldNames.length > 0 ? { fieldNames } : {}),
        ...(fieldTypes.length > 0 ? { fieldTypes } : {}),
      };
}

function parseDeclarativeCheckObject(
  value: Record<string, unknown>
): CanvasRuleDeclarativeCheck | undefined {
  const kind =
    typeof value.kind === "string"
      ? normalizeKey(value.kind)
      : typeof value.checkKind === "string"
        ? normalizeKey(value.checkKind)
        : typeof value.check_kind === "string"
          ? normalizeKey(value.check_kind)
          : "";
  if (kind !== "node_count") {
    return undefined;
  }

  const nodeType =
    typeof value.nodeType === "string"
      ? value.nodeType.trim()
      : typeof value.node_type === "string"
        ? value.node_type.trim()
        : "";
  if (!nodeType) {
    return undefined;
  }

  const check: CanvasRuleDeclarativeCheck = {
    kind: "node_count",
    nodeType,
  };
  const equals = parseOptionalNumber(value.equals);
  const min = parseOptionalNumber(value.min);
  const max = parseOptionalNumber(value.max);
  if (equals !== undefined) {
    check.equals = equals;
  }
  if (min !== undefined) {
    check.min = min;
  }
  if (max !== undefined) {
    check.max = max;
  }

  const dataMatches = parseNodeDataPredicates(
    value.dataMatches ?? value.data_matches ?? value.nodeData ?? value.node_data
  );
  if (dataMatches) {
    check.dataMatches = dataMatches;
  }

  const whenStateField = parseStateFieldCondition(
    value.whenStateField ?? value.when_state_field
  );
  if (whenStateField) {
    check.whenStateField = whenStateField;
  }

  return check.equals === undefined &&
    check.min === undefined &&
    check.max === undefined
    ? undefined
    : check;
}

function parseDeclarativeCheck(
  row: Record<string, string>
): CanvasRuleDeclarativeCheck | undefined {
  const checkValue = readRowString(row, ["check", "declarativeCheck"]);
  if (checkValue) {
    try {
      const parsed = JSON.parse(checkValue) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parseDeclarativeCheckObject(parsed as Record<string, unknown>);
      }
    } catch {
      return undefined;
    }
  }

  const flatCheck = parseDeclarativeCheckObject({
    kind: readRowString(row, ["checkKind", "check_kind", "kind"]),
    nodeType: readRowString(row, ["nodeType", "node_type"]),
    equals: readRowString(row, ["equals"]),
    min: readRowString(row, ["min"]),
    max: readRowString(row, ["max"]),
  });
  return flatCheck;
}

function parseRuleRegistryRow(
  row: Record<string, string>
): CanvasRuleDefinition | null {
  if (!readRowBoolean(row, ["enabled"], true)) {
    return null;
  }

  const id = normalizeRuleId(readRowString(row, ["id", "ruleId", "rule_id"]));
  const title = readRowString(row, ["title", "name"]);
  const description = readRowString(row, ["description"]);
  const repairGuidance = readRowString(row, [
    "repairGuidance",
    "repair_guidance",
    "repair",
  ]);

  if (!id || !title || !description || !repairGuidance) {
    return null;
  }

  const declarativeCheck = parseDeclarativeCheck(row);
  return {
    id,
    title,
    scope: normalizeScope(readRowString(row, ["scope"])),
    checkMode: normalizeCheckMode(
      readRowString(row, ["checkMode", "check_mode"])
    ),
    description,
    repairGuidance,
    ...(declarativeCheck ? { declarativeCheck } : {}),
    source: readRowString(row, ["source"]) || undefined,
    sourceCanvasId:
      readRowString(row, ["sourceCanvasId", "source_canvas_id"]) || undefined,
    sourceCanvasName:
      readRowString(row, ["sourceCanvasName", "source_canvas_name"]) || undefined,
    sourceNodeId:
      readRowString(row, ["sourceNodeId", "source_node_id"]) || undefined,
    sourceNodeLabel:
      readRowString(row, ["sourceNodeLabel", "source_node_label"]) || undefined,
    sourceHash:
      readRowString(row, ["sourceHash", "source_hash"]) || undefined,
  };
}

function seededRuleRowToRecord(
  row: CanvasRuleDatasetRow
): Record<string, string> {
  return {
    id: row.id,
    title: row.title,
    scope: row.scope,
    checkmode: row.checkMode,
    description: row.description,
    repairguidance: row.repairGuidance,
    enabled: String(row.enabled),
    check: row.check,
    source: row.source,
    sourcecanvasid: row.sourceCanvasId ?? "",
    sourcecanvasname: row.sourceCanvasName ?? "",
    sourcenodeid: row.sourceNodeId ?? "",
    sourcenodelabel: row.sourceNodeLabel ?? "",
    sourcehash: row.sourceHash ?? "",
  };
}

export function getSeededCanvasRuleDefinitions(): CanvasRuleDefinition[] {
  return SEEDED_CANVAS_RULES.flatMap((row) => {
    const rule = parseRuleRegistryRow(seededRuleRowToRecord(row));
    return rule ? [rule] : [];
  });
}

export function readCanvasRuleRegistryFromDatasets(
  datasets: SimulationPlayerDataset[]
): CanvasRuleDefinition[] {
  const dataset = datasets.find((item) =>
    isCanvasRuleRegistryDatasetName(item.name)
  );
  if (!dataset) {
    return [];
  }

  const rulesById = new Map<string, CanvasRuleDefinition>();
  for (const record of dataset.records) {
    const rule = parseRuleRegistryRow(readRecordByColumnName(dataset, record));
    if (!rule) {
      continue;
    }
    rulesById.set(rule.id, rule);
  }

  return [...rulesById.values()];
}

export function getCanvasRuleDefinitionsForScope(
  rules: readonly CanvasRuleDefinition[],
  scope: Exclude<CanvasRuleScope, "both">,
  options?: { checkMode?: CanvasRuleCheckMode }
): CanvasRuleDefinition[] {
  return rules.filter((rule) => {
    if (scope === "workflow") {
      if (rule.scope !== "workflow") {
        return false;
      }
    } else if (rule.scope === "workflow") {
      return false;
    }

    if (rule.scope !== "both" && rule.scope !== scope) {
      return false;
    }

    if (options?.checkMode && rule.checkMode !== options.checkMode) {
      return false;
    }

    return true;
  });
}
