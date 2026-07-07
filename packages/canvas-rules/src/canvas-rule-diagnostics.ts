import { getCanvasNodeDeclaredInputFields } from "@airlab/canvas-compiler/node-declared-inputs";
import { getNodeActionSubtype } from "@airlab/canvas-core/components/canvas/action-subtype";
import { normalizePromptOutputFields } from "@airlab/canvas-core/components/canvas/prompt-output-fields";
import {
  type CanvasEdgeRecord,
  type CanvasDoc,
  type CanvasNodeRecord,
} from "@airlab/canvas-compiler/types";
import type { RuntimeStateField } from "@airlab/canvas-planner/canvas-hybrid-runtime";
import {
  buildStructuralExecutionPlan,
  getConditionLabelIssue,
  parseStateActionLabel,
} from "@airlab/canvas-planner/canvas-structural-planner";
import {
  NODE_EXECUTABLE_CODE_OPS_DATA_KEY,
  readExplicitNodeExecutableStateCodeOps,
} from "@airlab/canvas-core/lib/canvas-node-code-ops";
import {
  NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY,
  nodeHasExecutableCodeSource,
} from "@airlab/canvas-core/lib/canvas-node-code-script";
import { NODE_LOCAL_INPUTS_DATA_KEY } from "@airlab/canvas-core/lib/canvas-node-local-fields";
import { collectAvailableCanvasLocalValueNames } from "@airlab/canvas-core/lib/canvas-local-dataflow";
import type {
  CanvasRuleDeclarativeCheck,
  CanvasRuleDefinition,
} from "@airlab/canvas-core/lib/canvas-rule-registry";
import {
  APPEND_ASSISTANT_TURN_CODE_LABEL,
  APPEND_ASSISTANT_TURN_CODE_SOURCE,
  APPEND_ASSISTANT_TURN_CODE_TEMPLATE_ID,
  BUILTIN_CODE_TEMPLATE_ID_DATA_KEY,
} from "@airlab/canvas-core/lib/canvas-append-assistant-turn-code";
import {
  AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME,
  AGENT_LATEST_REWARD_PROMPT_VALUE_NAME,
} from "@airlab/canvas-core/lib/canvas-flow-values";
import {
  DEFAULT_CONVERSATION_MEMORY_LIMIT,
  NEW_EVENTS_FIELD_NAME,
} from "@airlab/canvas-core/lib/conversation-memory";

export const CONDITION_NODES_MUST_BE_REAL_CONDITIONS_RULE_ID =
  "condition_nodes_must_be_real_conditions";
export const CANVAS_MUST_HAVE_SINGLE_START_NODE_RULE_ID =
  "canvas_must_have_single_start_node";
export const IF_CONDITIONS_MUST_HAVE_DISTINCT_TRUE_FALSE_BRANCHES_RULE_ID =
  "if_conditions_must_have_distinct_true_false_branches";
export const LOCAL_INPUTS_MUST_BE_DEFINED_ON_ALL_PATHS_RULE_ID =
  "local_inputs_must_be_defined_on_all_paths";
export const DETERMINISTIC_STATE_UPDATES_SHOULD_USE_CODE_NODES_RULE_ID =
  "deterministic_state_updates_should_use_code_nodes";
export const POLICY_CANVASES_MUST_HAVE_EDITABLE_COMMIT_CODE_RULE_ID =
  "policy_canvases_must_have_editable_commit_code";
export const STATE_CANVASES_MUST_START_WITH_EDITABLE_INGRESS_APPEND_CODE_RULE_ID =
  "state_canvases_must_start_with_editable_ingress_append_code";
export const STATE_CANVASES_MUST_INCLUDE_SUMMARY_MEMORY_GATE_RULE_ID =
  "state_canvases_must_include_summary_memory_gate";
export const PROMPT_SUBTREE_STEPS_MUST_NOT_OVERLAP_ON_EXECUTION_PATH_RULE_ID =
  "prompt_subtree_steps_must_not_overlap_on_execution_path";
export const WORKFLOW_CANVASES_MUST_SHOW_TEMPORAL_STAGE_PROCESS_RULE_ID =
  "workflow_canvases_must_show_temporal_stage_process";

type CanvasDiagnosticNode = Pick<CanvasNodeRecord, "id" | "type" | "data">;
type CanvasDiagnosticEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
};

export interface CanvasRuleDiagnostic {
  ruleId: string;
  severity: "error" | "warning";
  summary: string;
  evidence?: string;
  nodeId?: string;
  edgeId?: string;
  canvasId?: string;
  canvasName?: string;
  label?: string;
  sourceLabel?: string;
  targetLabel?: string;
}

type CanvasRuleTarget = "policy" | "state" | "workflow";
type PromptSubtreeExecutionStep = {
  id: string;
  type: string;
  sourceNodeRefs?: Array<{ canvasId: string; nodeId: string }>;
} & Record<string, unknown>;

function displayNodeLabel(node: CanvasDiagnosticNode): string {
  const label =
    typeof node.data?.label === "string" ? node.data.label.trim() : "";
  return label || node.type?.trim() || "node";
}

function normalizeRuleText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\+/g, " and ")
    .replace(/[.!?]+$/g, "")
    .replace(/[_\s-]+/g, " ");
}

function nodeIsMarkedReadOnly(node: CanvasDiagnosticNode): boolean {
  return (
    node.data?.nonEditable === true ||
    (typeof node.data?.nonEditableReason === "string" &&
      node.data.nonEditableReason.trim().length > 0)
  );
}

function collectAvailablePromptValueNames(
  nodes: CanvasDiagnosticNode[],
  edges: CanvasDiagnosticEdge[],
  nodeId: string
): string[] {
  return collectAvailableCanvasLocalValueNames({
    nodes: nodes.map((node) => ({
      ...node,
      position: { x: 0, y: 0 },
    })) as CanvasNodeRecord[],
    edges: edges as CanvasEdgeRecord[],
    nodeId,
  });
}

function collectConditionRuleDiagnostics(
  nodes: CanvasDiagnosticNode[],
  edges: CanvasDiagnosticEdge[],
  stateSchema: RuntimeStateField[]
): CanvasRuleDiagnostic[] {
  const diagnostics: CanvasRuleDiagnostic[] = [];

  for (const node of nodes) {
    if (node.type !== "condition") {
      continue;
    }

    const label =
      typeof node.data?.label === "string" ? node.data.label.trim() : "";
    const displayLabel = displayNodeLabel(node);
    const issue = getConditionLabelIssue(
      label,
      stateSchema,
      collectAvailablePromptValueNames(nodes, edges, node.id)
    );

    if (issue) {
      diagnostics.push({
        ruleId: CONDITION_NODES_MUST_BE_REAL_CONDITIONS_RULE_ID,
        severity: "error",
        summary: issue,
        evidence: label ? `label=${JSON.stringify(label)}` : undefined,
        nodeId: node.id,
        label: displayLabel,
      });
    }

    const outgoing = edges.filter((edge) => edge.source === node.id);
    const trueEdges = outgoing.filter((edge) => edge.sourceHandle === "true");
    const falseEdges = outgoing.filter((edge) => edge.sourceHandle === "false");
    const extraEdges = outgoing.filter(
      (edge) => edge.sourceHandle !== "true" && edge.sourceHandle !== "false"
    );
    const trueTarget = trueEdges[0]?.target ?? null;
    const falseTarget = falseEdges[0]?.target ?? null;

    const hasExpectedShape =
      trueEdges.length === 1 &&
      falseEdges.length === 1 &&
      extraEdges.length === 0 &&
      trueTarget !== null &&
      falseTarget !== null &&
      trueTarget !== falseTarget;
    if (hasExpectedShape) {
      continue;
    }

    let summary =
      `condition "${displayLabel}" does not have exactly one TRUE edge and one FALSE edge to distinct targets`;
    if (trueEdges.length === 0 || falseEdges.length === 0) {
      summary = `condition "${displayLabel}" is missing a TRUE or FALSE branch edge`;
    } else if (trueEdges.length > 1 || falseEdges.length > 1 || extraEdges.length > 0) {
      summary = `condition "${displayLabel}" has malformed branch wiring beyond a single TRUE and FALSE edge`;
    } else if (trueTarget === falseTarget) {
      summary = `condition "${displayLabel}" sends TRUE and FALSE to the same target node`;
    }

    diagnostics.push({
      ruleId: IF_CONDITIONS_MUST_HAVE_DISTINCT_TRUE_FALSE_BRANCHES_RULE_ID,
      severity: "error",
      summary,
      evidence: [
        `true_edges=${trueEdges.length}`,
        `false_edges=${falseEdges.length}`,
        `extra_edges=${extraEdges.length}`,
        `true_target=${trueTarget ?? "none"}`,
        `false_target=${falseTarget ?? "none"}`,
      ].join(", "),
      nodeId: node.id,
      label: displayLabel,
    });
  }

  return diagnostics;
}

function collectStartNodeSingletonDiagnostics(
  nodes: CanvasDiagnosticNode[]
): CanvasRuleDiagnostic[] {
  const startNodes = nodes.filter((node) => node.type === "start");
  if (startNodes.length === 1) {
    return [];
  }

  if (startNodes.length === 0) {
    return [
      {
        ruleId: CANVAS_MUST_HAVE_SINGLE_START_NODE_RULE_ID,
        severity: "error",
        summary: "canvas has no START node; each canvas should have exactly one START node",
        evidence: "start_node_count=0",
      },
    ];
  }

  return startNodes.slice(1).map((node) => ({
    ruleId: CANVAS_MUST_HAVE_SINGLE_START_NODE_RULE_ID,
    severity: "error",
    summary: `canvas has ${startNodes.length} START nodes; each canvas should have exactly one START node`,
    evidence: `start_node_ids=${startNodes.map((startNode) => startNode.id).join(",")}`,
    nodeId: node.id,
    label: displayNodeLabel(node),
  }));
}

function ruleIsActive(
  rules: readonly CanvasRuleDefinition[] | undefined,
  ruleId: string
): boolean {
  return !rules || rules.some((rule) => rule.id === ruleId);
}

function ruleIsExplicitlyActive(
  rules: readonly CanvasRuleDefinition[] | undefined,
  ruleId: string
): boolean {
  return !!rules?.some((rule) => rule.id === ruleId);
}

function hasDeclarativeCheck(
  rules: readonly CanvasRuleDefinition[] | undefined,
  ruleId: string
): boolean {
  return !!rules?.some((rule) => rule.id === ruleId && rule.declarativeCheck);
}

function filterRulesForTarget(
  rules: readonly CanvasRuleDefinition[] | undefined,
  target: CanvasRuleTarget | undefined
): readonly CanvasRuleDefinition[] | undefined {
  if (!target || !rules) {
    return rules;
  }

  return rules.filter((rule) =>
    target === "workflow"
      ? rule.scope === "workflow"
      : rule.scope === "both" || rule.scope === target
  );
}

function formatNodeTypeLabel(nodeType: string): string {
  return nodeType.trim().toUpperCase() || "NODE";
}

function scalarMatches(left: unknown, right: unknown): boolean {
  if (typeof left === "string" && typeof right === "string") {
    return normalizeRuleText(left) === normalizeRuleText(right);
  }
  return left === right;
}

function readNodeDataPath(node: CanvasDiagnosticNode, path: string): unknown {
  return path
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<unknown>((value, part) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
      }
      return (value as Record<string, unknown>)[part];
    }, node.data);
}

function nodeMatchesDataPredicates(
  node: CanvasDiagnosticNode,
  check: Extract<CanvasRuleDeclarativeCheck, { kind: "node_count" }>
): boolean {
  return (check.dataMatches ?? []).every((predicate) => {
    const value = readNodeDataPath(node, predicate.key);
    if (
      predicate.equals !== undefined &&
      !scalarMatches(value, predicate.equals)
    ) {
      return false;
    }
    if (
      predicate.notEquals !== undefined &&
      scalarMatches(value, predicate.notEquals)
    ) {
      return false;
    }
    return true;
  });
}

function stateFieldConditionApplies(
  check: CanvasRuleDeclarativeCheck,
  stateSchema: RuntimeStateField[]
): boolean {
  const condition = check.whenStateField;
  if (!condition) {
    return true;
  }

  const fieldNames = new Set(
    (condition.fieldNames ?? []).map((fieldName) => normalizeRuleText(fieldName))
  );
  const fieldTypes = new Set(
    (condition.fieldTypes ?? []).map((fieldType) =>
      fieldType.trim().toLowerCase()
    )
  );

  return stateSchema.some((field) => {
    const nameMatches =
      fieldNames.size === 0 || fieldNames.has(normalizeRuleText(field.fieldName));
    const typeMatches =
      fieldTypes.size === 0 ||
      fieldTypes.has(String(field.type).trim().toLowerCase());
    return nameMatches && typeMatches;
  });
}

function collectNodeCountDeclarativeDiagnostics(
  rule: CanvasRuleDefinition,
  check: Extract<CanvasRuleDeclarativeCheck, { kind: "node_count" }>,
  nodes: CanvasDiagnosticNode[],
  stateSchema: RuntimeStateField[]
): CanvasRuleDiagnostic[] {
  if (!stateFieldConditionApplies(check, stateSchema)) {
    return [];
  }

  const matchingNodes = nodes.filter(
    (node) =>
      node.type === check.nodeType && nodeMatchesDataPredicates(node, check)
  );
  const count = matchingNodes.length;
  const tooLow =
    check.equals !== undefined
      ? count < check.equals
      : check.min !== undefined && count < check.min;
  const tooHigh =
    check.equals !== undefined
      ? count > check.equals
      : check.max !== undefined && count > check.max;

  if (!tooLow && !tooHigh) {
    return [];
  }

  const expected =
    check.equals !== undefined
      ? `exactly ${check.equals}`
      : [
          check.min !== undefined ? `at least ${check.min}` : "",
          check.max !== undefined ? `at most ${check.max}` : "",
        ]
          .filter(Boolean)
          .join(" and ");
  const nodeTypeLabel = formatNodeTypeLabel(check.nodeType);
  const summary =
    count === 0 && check.equals === 1
      ? `canvas has no ${nodeTypeLabel} node; each canvas should have exactly one ${nodeTypeLabel} node`
      : `canvas has ${count} ${nodeTypeLabel} node${count === 1 ? "" : "s"}; expected ${expected}`;
  const evidence = [
    `node_type=${JSON.stringify(check.nodeType)}`,
    `node_count=${count}`,
    check.dataMatches?.length
      ? `data_matches=${JSON.stringify(check.dataMatches)}`
      : "",
    check.whenStateField
      ? `when_state_field=${JSON.stringify(check.whenStateField)}`
      : "",
    check.equals !== undefined ? `expected=${check.equals}` : "",
    check.min !== undefined ? `min=${check.min}` : "",
    check.max !== undefined ? `max=${check.max}` : "",
    matchingNodes.length > 0
      ? `node_ids=${matchingNodes.map((node) => node.id).join(",")}`
      : "",
  ]
    .filter(Boolean)
    .join(", ");

  if (tooHigh) {
    const allowedCount =
      check.equals !== undefined ? check.equals : check.max ?? matchingNodes.length;
    return matchingNodes.slice(Math.max(0, allowedCount)).map((node) => ({
      ruleId: rule.id,
      severity: "error",
      summary,
      evidence,
      nodeId: node.id,
      label: displayNodeLabel(node),
    }));
  }

  return [
    {
      ruleId: rule.id,
      severity: "error",
      summary,
      evidence,
    },
  ];
}

function collectDeclarativeRuleDiagnostics(
  nodes: CanvasDiagnosticNode[],
  rules: readonly CanvasRuleDefinition[] | undefined,
  stateSchema: RuntimeStateField[]
): CanvasRuleDiagnostic[] {
  if (!rules) {
    return [];
  }

  return rules.flatMap((rule) => {
    const check = rule.declarativeCheck;
    if (!check) {
      return [];
    }

    if (check.kind === "node_count") {
      return collectNodeCountDeclarativeDiagnostics(
        rule,
        check,
        nodes,
        stateSchema
      );
    }

    return [];
  });
}

function collectStepNextIds(step: PromptSubtreeExecutionStep): string[] {
  return [
    step.next_step_id,
    step.on_match_step_id,
    step.on_no_match_step_id,
    step.on_value_step_id,
    step.on_empty_step_id,
    step.on_error_step_id,
    step.on_use_prompt_step_id,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function executionStepCanReach(
  stepsById: Map<string, PromptSubtreeExecutionStep>,
  fromId: string,
  toId: string
): boolean {
  const visited = new Set<string>();
  const queue = [fromId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId || visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    const step = stepsById.get(currentId);
    if (!step) {
      continue;
    }
    for (const nextId of collectStepNextIds(step)) {
      if (nextId === toId) {
        return true;
      }
      if (!visited.has(nextId)) {
        queue.push(nextId);
      }
    }
  }

  return false;
}

function isPromptSubtreeExecutionStep(
  step: PromptSubtreeExecutionStep
): boolean {
  return (
    step.type === "prompt_subtree_decision" ||
    step.type === "prompt_subtree_update"
  );
}

function collectPromptSubtreeExecutionOverlapDiagnostics(
  nodes: CanvasDiagnosticNode[],
  edges: CanvasDiagnosticEdge[],
  stateSchema: RuntimeStateField[],
  target: CanvasRuleTarget | undefined
): CanvasRuleDiagnostic[] {
  if (!target || nodes.length === 0) {
    return [];
  }

  const diagnosticCanvasId = "diagnostic-canvas";
  const diagnosticDoc: CanvasDoc = {
    version: 2,
    activeId: diagnosticCanvasId,
    canvases: [
      {
        id: diagnosticCanvasId,
        name: "Diagnostic canvas",
        freeText: "",
        graph: {
          nodes: nodes.map((node) => ({
            ...node,
            position: { x: 0, y: 0 },
          })) as CanvasNodeRecord[],
          edges: edges as CanvasEdgeRecord[],
        },
      },
    ],
  };

  const plan = buildStructuralExecutionPlan({
    stateSchema,
    stateCanvasDoc: target === "state" ? diagnosticDoc : null,
    policyCanvasDoc: target === "policy" ? diagnosticDoc : null,
  });
  const graph =
    target === "state"
      ? plan.state.code_plan?.execution_graph
      : plan.policy.code_plan?.execution_graph;
  const steps = (graph?.steps ?? []) as PromptSubtreeExecutionStep[];
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  const promptSteps = steps.filter(isPromptSubtreeExecutionStep);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const diagnostics: CanvasRuleDiagnostic[] = [];

  for (let i = 0; i < promptSteps.length; i += 1) {
    const left = promptSteps[i];
    const leftKeys = new Set(
      (left.sourceNodeRefs ?? []).map((ref) => `${ref.canvasId}:${ref.nodeId}`)
    );
    if (leftKeys.size === 0) {
      continue;
    }

    for (let j = i + 1; j < promptSteps.length; j += 1) {
      const right = promptSteps[j];
      const rightKeys = new Set(
        (right.sourceNodeRefs ?? []).map((ref) => `${ref.canvasId}:${ref.nodeId}`)
      );
      const sharedKeys = [...leftKeys].filter((key) => rightKeys.has(key));
      if (sharedKeys.length === 0) {
        continue;
      }

      const leftReachesRight = executionStepCanReach(
        stepsById,
        left.id,
        right.id
      );
      const rightReachesLeft = executionStepCanReach(
        stepsById,
        right.id,
        left.id
      );
      if (!leftReachesRight && !rightReachesLeft) {
        continue;
      }

      const firstSharedNodeId = sharedKeys[0]?.split(":").at(-1) ?? "";
      const sharedLabels = sharedKeys
        .map((key) => nodeById.get(key.split(":").at(-1) ?? ""))
        .filter((node): node is CanvasDiagnosticNode => Boolean(node))
        .map(displayNodeLabel);
      diagnostics.push({
        ruleId: PROMPT_SUBTREE_STEPS_MUST_NOT_OVERLAP_ON_EXECUTION_PATH_RULE_ID,
        severity: "error",
        summary:
          "compiled prompt-subtree steps overlap on the same execution path",
        evidence: [
          `first_step=${left.id}`,
          `second_step=${right.id}`,
          `direction=${leftReachesRight ? `${left.id}->${right.id}` : `${right.id}->${left.id}`}`,
          `shared_nodes=${sharedKeys.length}`,
          sharedLabels.length > 0
            ? `shared_labels=${sharedLabels.map((label) => JSON.stringify(label)).join(" | ")}`
            : "",
        ]
          .filter(Boolean)
          .join(", "),
        nodeId: firstSharedNodeId || undefined,
        label:
          firstSharedNodeId && nodeById.has(firstSharedNodeId)
            ? displayNodeLabel(nodeById.get(firstSharedNodeId)!)
            : undefined,
      });
    }
  }

  return diagnostics;
}

function collectLocalInputAvailabilityDiagnostics(
  nodes: CanvasDiagnosticNode[],
  edges: CanvasDiagnosticEdge[],
  stateSchema: RuntimeStateField[]
): CanvasRuleDiagnostic[] {
  const diagnostics: CanvasRuleDiagnostic[] = [];
  const stateFieldNames = new Set(
    stateSchema.map((field) => normalizeRuleText(field.fieldName))
  );

  for (const node of nodes) {
    const declaredInputs = getCanvasNodeDeclaredInputFields(node);
    if (declaredInputs.length === 0) {
      continue;
    }

    const availableNames = new Set(
      collectAvailablePromptValueNames(nodes, edges, node.id)
    );
    for (const input of declaredInputs) {
      const name = input.name.trim();
      const isDisplayValueSource = input.origin === "display value source";
      const isPromptTransformValueSource =
        input.origin === "prompt transform value source";
      const valueSourceReadsStateField =
        (isDisplayValueSource || isPromptTransformValueSource) &&
        stateFieldNames.has(normalizeRuleText(name));
      if (!name || availableNames.has(name) || valueSourceReadsStateField) {
        continue;
      }

      const isValueSource = isDisplayValueSource || isPromptTransformValueSource;
      const summary = isValueSource
        ? `node "${displayNodeLabel(node)}" uses value source "${name}", but that value is neither a state field nor a local defined on every control path reaching the node`
        : `node "${displayNodeLabel(node)}" declares local input "${name}", but that local is not defined on every control path reaching the node`;

      diagnostics.push({
        ruleId: LOCAL_INPUTS_MUST_BE_DEFINED_ON_ALL_PATHS_RULE_ID,
        severity: "error",
        summary,
        evidence: isValueSource
          ? `value_source=${JSON.stringify(name)}`
          : `declared_input=${JSON.stringify(name)}`,
        nodeId: node.id,
        label: displayNodeLabel(node),
      });
    }
  }

  return diagnostics;
}

function collectDeterministicStatePromptDiagnostics(
  nodes: CanvasDiagnosticNode[],
  stateSchema: RuntimeStateField[]
): CanvasRuleDiagnostic[] {
  const diagnostics: CanvasRuleDiagnostic[] = [];

  for (const node of nodes) {
    if (node.type !== "prompt" && node.type !== "action") {
      continue;
    }

    const actionType = getNodeActionSubtype(node);
    if (actionType !== "prompt" && actionType !== "default") {
      continue;
    }

    if (normalizePromptOutputFields(node.data?.promptOutputFields).length > 0) {
      continue;
    }

    const label =
      typeof node.data?.label === "string" ? node.data.label.trim() : "";
    const deterministicReason = (() => {
      if (readExplicitNodeExecutableStateCodeOps(node, stateSchema)) {
        return "executableCodeOps";
      }

      if (nodeHasExecutableCodeSource(node)) {
        return "executableTypeScript";
      }

      if (label && parseStateActionLabel(label, stateSchema)) {
        return "label";
      }

      return null;
    })();

    if (!deterministicReason) {
      continue;
    }

    diagnostics.push({
      ruleId: DETERMINISTIC_STATE_UPDATES_SHOULD_USE_CODE_NODES_RULE_ID,
      severity: "warning",
      summary: `node "${displayNodeLabel(node)}" is a deterministic state update and should be Code mode rather than Prompt mode`,
      evidence: [
        `reason=${deterministicReason}`,
        label ? `label=${JSON.stringify(label)}` : "",
      ]
        .filter(Boolean)
        .join(", "),
      nodeId: node.id,
      label: displayNodeLabel(node),
    });
  }

  return diagnostics;
}

function nodeLooksLikePolicyCommit(node: CanvasDiagnosticNode): boolean {
  const label =
    typeof node.data?.label === "string" ? node.data.label.trim() : "";
  const normalizedLabel = normalizeRuleText(label);
  const templateId =
    typeof node.data?.[BUILTIN_CODE_TEMPLATE_ID_DATA_KEY] === "string"
      ? node.data[BUILTIN_CODE_TEMPLATE_ID_DATA_KEY].trim()
      : "";
  const source =
    typeof node.data?.[NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY] === "string"
      ? node.data[NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY].trim()
      : "";

  if (
    templateId === APPEND_ASSISTANT_TURN_CODE_TEMPLATE_ID ||
    source === APPEND_ASSISTANT_TURN_CODE_SOURCE.trim()
  ) {
    return true;
  }

  return (
    normalizedLabel === normalizeRuleText(APPEND_ASSISTANT_TURN_CODE_LABEL) ||
    ((normalizedLabel.includes("commit") ||
      normalizedLabel.includes("append")) &&
      normalizedLabel.includes("new events") &&
      (normalizedLabel.includes("finalized") ||
        normalizedLabel.includes("latest action") ||
        normalizedLabel.includes("agent latest action")))
  );
}

function nodeHasPolicyCommitBacking(node: CanvasDiagnosticNode): boolean {
  const templateId =
    typeof node.data?.[BUILTIN_CODE_TEMPLATE_ID_DATA_KEY] === "string"
      ? node.data[BUILTIN_CODE_TEMPLATE_ID_DATA_KEY].trim()
      : "";
  const source =
    typeof node.data?.[NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY] === "string"
      ? node.data[NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY].trim()
      : "";

  return (
    templateId === APPEND_ASSISTANT_TURN_CODE_TEMPLATE_ID ||
    source === APPEND_ASSISTANT_TURN_CODE_SOURCE.trim()
  );
}

function collectPolicyCommitTemplateDiagnostics(
  nodes: CanvasDiagnosticNode[]
): CanvasRuleDiagnostic[] {
  const diagnostics: CanvasRuleDiagnostic[] = [];
  const candidates = nodes.filter(nodeLooksLikePolicyCommit);
  const backedCommitNodes = candidates.filter(nodeHasPolicyCommitBacking);

  if (candidates.length === 0) {
    return [
      {
        ruleId: POLICY_CANVASES_MUST_HAVE_EDITABLE_COMMIT_CODE_RULE_ID,
        severity: "error",
        summary:
          "policy canvas is missing the editable starter commit Code node that records the finalized policy output in latest-action/new_events state",
        evidence: "commit_code_node_count=0",
      },
    ];
  }

  if (backedCommitNodes.length === 0) {
    const candidate = candidates[0];
    diagnostics.push({
      ruleId: POLICY_CANVASES_MUST_HAVE_EDITABLE_COMMIT_CODE_RULE_ID,
      severity: "error",
      summary: `policy commit candidate "${displayNodeLabel(candidate)}" is not backed by the starter commit Code template`,
      evidence: [
        `node_type=${JSON.stringify(candidate.type)}`,
        `action_type=${JSON.stringify(candidate.data?.actionType ?? "")}`,
      ].join(", "),
      nodeId: candidate.id,
      label: displayNodeLabel(candidate),
    });
  }

  for (const node of backedCommitNodes) {
    if (node.type !== "code" || node.data?.actionType !== "code") {
      diagnostics.push({
        ruleId: POLICY_CANVASES_MUST_HAVE_EDITABLE_COMMIT_CODE_RULE_ID,
        severity: "error",
        summary: `policy commit node "${displayNodeLabel(node)}" must be an ordinary Code node`,
        evidence: [
          `node_type=${JSON.stringify(node.type)}`,
          `action_type=${JSON.stringify(node.data?.actionType ?? "")}`,
        ].join(", "),
        nodeId: node.id,
        label: displayNodeLabel(node),
      });
    }

    if (nodeIsMarkedReadOnly(node)) {
      diagnostics.push({
        ruleId: POLICY_CANVASES_MUST_HAVE_EDITABLE_COMMIT_CODE_RULE_ID,
        severity: "error",
        summary: `policy commit node "${displayNodeLabel(node)}" must be editable, not runtime-managed/read-only`,
        evidence: `nonEditableReason=${JSON.stringify(
          node.data?.nonEditableReason ?? ""
        )}`,
        nodeId: node.id,
        label: displayNodeLabel(node),
      });
    }
  }

  if (backedCommitNodes.length > 1) {
    for (const node of backedCommitNodes.slice(1)) {
      diagnostics.push({
        ruleId: POLICY_CANVASES_MUST_HAVE_EDITABLE_COMMIT_CODE_RULE_ID,
        severity: "error",
        summary:
          "policy canvas has multiple starter commit Code nodes; keep one canonical commit after the project-specific behavior",
        evidence: `commit_code_node_count=${backedCommitNodes.length}`,
        nodeId: node.id,
        label: displayNodeLabel(node),
      });
    }
  }

  return diagnostics;
}

function nodeHasStateIngressAppendLabel(node: CanvasDiagnosticNode): boolean {
  const label =
    typeof node.data?.label === "string" ? node.data.label.trim() : "";
  const normalizedLabel = normalizeRuleText(label);
  return (
    normalizedLabel ===
      "add agent latest observation and agent latest reward to new events" ||
    normalizedLabel === "add latest observation and reward event to new events" ||
    normalizedLabel === "add latest observation event to new events" ||
    normalizedLabel === "add latest observation and reward turn to new events" ||
    normalizedLabel === "add latest observation reward event to new events" ||
    normalizedLabel === "add latest observation reward turn to new events"
  );
}

function nodeHasObservationAppendOps(
  node: CanvasDiagnosticNode,
  expectedSourceKind: "latest_observation_event" | "latest_observation_and_reward_event"
): boolean {
  const rawOps = node.data?.[NODE_EXECUTABLE_CODE_OPS_DATA_KEY];
  if (!Array.isArray(rawOps)) {
    return false;
  }

  return rawOps.some((rawOp) => {
    if (!rawOp || typeof rawOp !== "object") {
      return false;
    }
    const op = rawOp as Record<string, unknown>;
    const source =
      op.source && typeof op.source === "object" && !Array.isArray(op.source)
        ? (op.source as Record<string, unknown>)
        : null;

    return (
      op.kind === "append_list_item" &&
      typeof op.field === "string" &&
      normalizeRuleText(op.field) === normalizeRuleText(NEW_EVENTS_FIELD_NAME) &&
      source?.kind === expectedSourceKind
    );
  });
}

function nodeDeclaresLocalInput(
  node: CanvasDiagnosticNode,
  name: string
): boolean {
  const rawInputs = node.data?.[NODE_LOCAL_INPUTS_DATA_KEY];
  if (!Array.isArray(rawInputs)) {
    return false;
  }

  return rawInputs.some((rawInput) => {
    if (!rawInput || typeof rawInput !== "object") {
      return false;
    }
    const input = rawInput as Record<string, unknown>;
    return (
      typeof input.name === "string" &&
      input.name.trim() === name
    );
  });
}

function collectStateIngressTemplateDiagnostics(
  nodes: CanvasDiagnosticNode[],
  edges: CanvasDiagnosticEdge[]
): CanvasRuleDiagnostic[] {
  const diagnostics: CanvasRuleDiagnostic[] = [];
  const candidates = nodes.filter(nodeHasStateIngressAppendLabel);

  if (candidates.length === 0) {
    return [
      {
        ruleId: STATE_CANVASES_MUST_START_WITH_EDITABLE_INGRESS_APPEND_CODE_RULE_ID,
        severity: "error",
        summary:
          "state canvas is missing an editable starter ingress Code node that appends the latest observation/reward event to new_events",
        evidence: "ingress_append_code_node_count=0",
      },
    ];
  }

  const startNodes = nodes.filter((node) => node.type === "start");
  const startNode = startNodes.length === 1 ? startNodes[0] : null;
  const startTargets = new Set(
    startNode
      ? edges
          .filter((edge) => edge.source === startNode.id)
          .map((edge) => edge.target)
      : []
  );

  for (const node of candidates) {
    const hasPrimaryObservationInput = nodeDeclaresLocalInput(
      node,
      AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME
    );
    const hasRewardInput = nodeDeclaresLocalInput(
      node,
      AGENT_LATEST_REWARD_PROMPT_VALUE_NAME
    );
    const expectedSourceKind = "latest_observation_and_reward_event";

    if (node.type !== "code" || node.data?.actionType !== "code") {
      diagnostics.push({
        ruleId:
          STATE_CANVASES_MUST_START_WITH_EDITABLE_INGRESS_APPEND_CODE_RULE_ID,
        severity: "error",
        summary: `state ingress append node "${displayNodeLabel(node)}" must be an ordinary Code node`,
        evidence: [
          `node_type=${JSON.stringify(node.type)}`,
          `action_type=${JSON.stringify(node.data?.actionType ?? "")}`,
        ].join(", "),
        nodeId: node.id,
        label: displayNodeLabel(node),
      });
    }

    if (!nodeHasObservationAppendOps(node, expectedSourceKind)) {
      diagnostics.push({
        ruleId:
          STATE_CANVASES_MUST_START_WITH_EDITABLE_INGRESS_APPEND_CODE_RULE_ID,
        severity: "error",
        summary: `state ingress append node "${displayNodeLabel(node)}" is missing executable append_list_item backing for new_events from ${expectedSourceKind}`,
        evidence: `expected_source=${expectedSourceKind}`,
        nodeId: node.id,
        label: displayNodeLabel(node),
      });
    }

    const hasValidInputs = hasPrimaryObservationInput && hasRewardInput;
    if (!hasValidInputs) {
      diagnostics.push({
        ruleId:
          STATE_CANVASES_MUST_START_WITH_EDITABLE_INGRESS_APPEND_CODE_RULE_ID,
        severity: "error",
        summary: `state ingress append node "${displayNodeLabel(node)}" must declare agent_latest_observation plus agent_latest_reward`,
        evidence: [
          `has_agent_latest_observation=${hasPrimaryObservationInput}`,
          `has_agent_latest_reward=${hasRewardInput}`,
        ].join(", "),
        nodeId: node.id,
        label: displayNodeLabel(node),
      });
    }

    if (nodeIsMarkedReadOnly(node)) {
      diagnostics.push({
        ruleId:
          STATE_CANVASES_MUST_START_WITH_EDITABLE_INGRESS_APPEND_CODE_RULE_ID,
        severity: "error",
        summary: `state ingress append node "${displayNodeLabel(node)}" must be editable, not runtime-managed/read-only`,
        evidence: `nonEditableReason=${JSON.stringify(
          node.data?.nonEditableReason ?? ""
        )}`,
        nodeId: node.id,
        label: displayNodeLabel(node),
      });
    }

    if (startNode && !startTargets.has(node.id)) {
      diagnostics.push({
        ruleId:
          STATE_CANVASES_MUST_START_WITH_EDITABLE_INGRESS_APPEND_CODE_RULE_ID,
        severity: "error",
        summary: `state ingress append node "${displayNodeLabel(node)}" should be the first node after Start`,
        evidence: `start_node_id=${startNode.id}`,
        nodeId: node.id,
        label: displayNodeLabel(node),
      });
    }
  }

  if (candidates.length > 1) {
    for (const node of candidates.slice(1)) {
      diagnostics.push({
        ruleId:
          STATE_CANVASES_MUST_START_WITH_EDITABLE_INGRESS_APPEND_CODE_RULE_ID,
        severity: "error",
        summary:
          "state canvas has multiple starter ingress append nodes; keep one canonical node immediately after Start",
        evidence: `ingress_append_code_node_count=${candidates.length}`,
        nodeId: node.id,
        label: displayNodeLabel(node),
      });
    }
  }

  return diagnostics;
}

const STATE_SUMMARY_GATE_LABEL =
  `summary plus new_events exceeds ${DEFAULT_CONVERSATION_MEMORY_LIMIT} characters`;
const STATE_SUMMARY_UPDATE_LABEL =
  "Update summary with a concise summary of summary plus new_events.";
const STATE_CLEAR_NEW_EVENTS_LABEL = "Set new_events to empty list.";

function nodeHasStateSummaryGateLabel(node: CanvasDiagnosticNode): boolean {
  if (node.type !== "condition") {
    return false;
  }

  const label =
    typeof node.data?.label === "string" ? node.data.label.trim() : "";
  const normalizedLabel = normalizeRuleText(label);
  return (
    normalizedLabel === normalizeRuleText(STATE_SUMMARY_GATE_LABEL) ||
    (normalizedLabel.includes("summary plus new events exceeds") &&
      normalizedLabel.includes(String(DEFAULT_CONVERSATION_MEMORY_LIMIT)))
  );
}

function nodeHasStateSummaryUpdateLabel(node: CanvasDiagnosticNode): boolean {
  const label =
    typeof node.data?.label === "string" ? node.data.label.trim() : "";
  const normalizedLabel = normalizeRuleText(label);
  return (
    normalizedLabel === normalizeRuleText(STATE_SUMMARY_UPDATE_LABEL) ||
    (normalizedLabel.includes("update summary") &&
      normalizedLabel.includes("summary plus new events"))
  );
}

function nodeHasStateClearNewEventsLabel(node: CanvasDiagnosticNode): boolean {
  const label =
    typeof node.data?.label === "string" ? node.data.label.trim() : "";
  return (
    normalizeRuleText(label) === normalizeRuleText(STATE_CLEAR_NEW_EVENTS_LABEL)
  );
}

function nodeHasClearNewEventsOps(node: CanvasDiagnosticNode): boolean {
  const rawOps = node.data?.[NODE_EXECUTABLE_CODE_OPS_DATA_KEY];
  if (!Array.isArray(rawOps)) {
    return false;
  }

  return rawOps.some((rawOp) => {
    if (!rawOp || typeof rawOp !== "object") {
      return false;
    }
    const op = rawOp as Record<string, unknown>;
    const source =
      op.source && typeof op.source === "object" && !Array.isArray(op.source)
        ? (op.source as Record<string, unknown>)
        : null;
    const value = source?.value;

    return (
      op.kind === "set_field" &&
      typeof op.field === "string" &&
      normalizeRuleText(op.field) === normalizeRuleText(NEW_EVENTS_FIELD_NAME) &&
      source?.kind === "constant" &&
      Array.isArray(value) &&
      value.length === 0
    );
  });
}

function nodeIsOrdinaryPrompt(node: CanvasDiagnosticNode): boolean {
  const subtype = getNodeActionSubtype({
    type: node.type,
    data: node.data ?? {},
  });
  return subtype === "prompt" || subtype === "default";
}

function nodeIsOrdinaryCode(node: CanvasDiagnosticNode): boolean {
  return (
    getNodeActionSubtype({
      type: node.type,
      data: node.data ?? {},
    }) === "code"
  );
}

function collectStateSummaryMemoryGateDiagnostics(
  nodes: CanvasDiagnosticNode[],
  edges: CanvasDiagnosticEdge[]
): CanvasRuleDiagnostic[] {
  const diagnostics: CanvasRuleDiagnostic[] = [];
  const gates = nodes.filter(nodeHasStateSummaryGateLabel);
  const summaryNodes = nodes.filter(nodeHasStateSummaryUpdateLabel);
  const clearNodes = nodes.filter(nodeHasStateClearNewEventsLabel);

  if (gates.length === 0) {
    diagnostics.push({
      ruleId: STATE_CANVASES_MUST_INCLUDE_SUMMARY_MEMORY_GATE_RULE_ID,
      severity: "error",
      summary:
        `state canvas is missing condition "${STATE_SUMMARY_GATE_LABEL}"`,
      evidence: "summary_memory_gate_count=0",
    });
  }

  if (summaryNodes.length === 0) {
    diagnostics.push({
      ruleId: STATE_CANVASES_MUST_INCLUDE_SUMMARY_MEMORY_GATE_RULE_ID,
      severity: "error",
      summary:
        `state canvas is missing Prompt "${STATE_SUMMARY_UPDATE_LABEL}"`,
      evidence: "summary_update_prompt_count=0",
    });
  }

  if (clearNodes.length === 0) {
    diagnostics.push({
      ruleId: STATE_CANVASES_MUST_INCLUDE_SUMMARY_MEMORY_GATE_RULE_ID,
      severity: "error",
      summary: `state canvas is missing Code "${STATE_CLEAR_NEW_EVENTS_LABEL}"`,
      evidence: "clear_new_events_code_count=0",
    });
  }

  for (const node of summaryNodes) {
    if (!nodeIsOrdinaryPrompt(node)) {
      diagnostics.push({
        ruleId: STATE_CANVASES_MUST_INCLUDE_SUMMARY_MEMORY_GATE_RULE_ID,
        severity: "error",
        summary: `state summary update node "${displayNodeLabel(node)}" must be an ordinary Prompt node`,
        evidence: [
          `node_type=${JSON.stringify(node.type)}`,
          `action_type=${JSON.stringify(node.data?.actionType ?? "")}`,
        ].join(", "),
        nodeId: node.id,
        label: displayNodeLabel(node),
      });
    }
  }

  for (const node of clearNodes) {
    if (!nodeIsOrdinaryCode(node)) {
      diagnostics.push({
        ruleId: STATE_CANVASES_MUST_INCLUDE_SUMMARY_MEMORY_GATE_RULE_ID,
        severity: "error",
        summary: `state clear-new_events node "${displayNodeLabel(node)}" must be an ordinary Code node`,
        evidence: [
          `node_type=${JSON.stringify(node.type)}`,
          `action_type=${JSON.stringify(node.data?.actionType ?? "")}`,
        ].join(", "),
        nodeId: node.id,
        label: displayNodeLabel(node),
      });
    }

    if (!nodeHasClearNewEventsOps(node)) {
      diagnostics.push({
        ruleId: STATE_CANVASES_MUST_INCLUDE_SUMMARY_MEMORY_GATE_RULE_ID,
        severity: "error",
        summary: `state clear-new_events node "${displayNodeLabel(node)}" is missing executable set_field backing for new_events=[]`,
        evidence: "expected_op=set_field,new_events=[]",
        nodeId: node.id,
        label: displayNodeLabel(node),
      });
    }
  }

  if (gates.length > 1) {
    for (const node of gates.slice(1)) {
      diagnostics.push({
        ruleId: STATE_CANVASES_MUST_INCLUDE_SUMMARY_MEMORY_GATE_RULE_ID,
        severity: "error",
        summary:
          "state canvas has multiple summary memory gates; keep one canonical gate after the ingress append node",
        evidence: `summary_memory_gate_count=${gates.length}`,
        nodeId: node.id,
        label: displayNodeLabel(node),
      });
    }
  }

  const gate = gates[0];
  if (!gate) {
    return diagnostics;
  }

  const outgoing = edges.filter((edge) => edge.source === gate.id);
  const trueEdge = outgoing.find((edge) => edge.sourceHandle === "true");
  const falseEdge = outgoing.find((edge) => edge.sourceHandle === "false");
  const trueTarget = trueEdge?.target ?? null;
  const falseTarget = falseEdge?.target ?? null;
  const summaryTargetNode = trueTarget
    ? nodes.find((node) => node.id === trueTarget)
    : null;

  if (!trueEdge || !summaryTargetNode || !nodeHasStateSummaryUpdateLabel(summaryTargetNode)) {
    diagnostics.push({
      ruleId: STATE_CANVASES_MUST_INCLUDE_SUMMARY_MEMORY_GATE_RULE_ID,
      severity: "error",
      summary:
        `condition "${displayNodeLabel(gate)}" TRUE branch should target the summary-update Prompt`,
      evidence: `true_target=${trueTarget ?? "none"}`,
      nodeId: gate.id,
      label: displayNodeLabel(gate),
    });
  }

  if (!falseEdge) {
    diagnostics.push({
      ruleId: STATE_CANVASES_MUST_INCLUDE_SUMMARY_MEMORY_GATE_RULE_ID,
      severity: "error",
      summary:
        `condition "${displayNodeLabel(gate)}" is missing the FALSE branch to remaining state update`,
      evidence: "false_target=none",
      nodeId: gate.id,
      label: displayNodeLabel(gate),
    });
  }

  const summaryNode =
    summaryTargetNode && nodeHasStateSummaryUpdateLabel(summaryTargetNode)
      ? summaryTargetNode
      : summaryNodes[0];
  const summaryOutgoing = summaryNode
    ? edges.filter((edge) => edge.source === summaryNode.id)
    : [];
  const clearEdge = summaryOutgoing.find((edge) => {
    const targetNode = nodes.find((node) => node.id === edge.target);
    return !!targetNode && nodeHasStateClearNewEventsLabel(targetNode);
  });
  const clearNode = clearEdge
    ? nodes.find((node) => node.id === clearEdge.target)
    : clearNodes[0];

  if (!summaryNode || !clearEdge) {
    diagnostics.push({
      ruleId: STATE_CANVASES_MUST_INCLUDE_SUMMARY_MEMORY_GATE_RULE_ID,
      severity: "error",
      summary:
        "state summary-update Prompt should flow to the clear-new_events Code node",
      evidence: `summary_node=${summaryNode?.id ?? "none"}`,
      nodeId: summaryNode?.id,
      label: summaryNode ? displayNodeLabel(summaryNode) : undefined,
    });
  }

  const clearOutgoing = clearNode
    ? edges.filter((edge) => edge.source === clearNode.id)
    : [];
  const clearTarget = clearOutgoing[0]?.target ?? null;
  if (clearNode && clearOutgoing.length === 0) {
    diagnostics.push({
      ruleId: STATE_CANVASES_MUST_INCLUDE_SUMMARY_MEMORY_GATE_RULE_ID,
      severity: "error",
      summary:
        "state clear-new_events Code node should continue to remaining state update",
      evidence: "clear_target=none",
      nodeId: clearNode.id,
      label: displayNodeLabel(clearNode),
    });
  }

  if (falseTarget && clearTarget && falseTarget !== clearTarget) {
    diagnostics.push({
      ruleId: STATE_CANVASES_MUST_INCLUDE_SUMMARY_MEMORY_GATE_RULE_ID,
      severity: "error",
      summary:
        "state summary gate FALSE path and clear-new_events path should rejoin the same remaining state-update node",
      evidence: [
        `false_target=${falseTarget}`,
        `clear_target=${clearTarget}`,
      ].join(", "),
      nodeId: gate.id,
      label: displayNodeLabel(gate),
    });
  }

  return diagnostics;
}

function workflowGraphHasStageCycle(
  nodes: CanvasDiagnosticNode[],
  edges: CanvasDiagnosticEdge[]
): boolean {
  const stageNodeIds = new Set(
    nodes.filter((node) => node.type === "stage").map((node) => node.id)
  );
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!stageNodeIds.has(edge.source) || !stageNodeIds.has(edge.target)) {
      continue;
    }
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) {
      return true;
    }
    if (visited.has(nodeId)) {
      return false;
    }
    visiting.add(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) {
      if (visit(target)) {
        return true;
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  return Array.from(stageNodeIds).some((nodeId) => visit(nodeId));
}

function workflowLabelImpliesLoop(label: string): boolean {
  const normalized = normalizeRuleText(label);
  return /\b(repeat|retry|again|iterate|loop|until|revisit|revise|reassess|failed|fails)\b/.test(normalized) ||
    /\b(back|return) to\b/.test(normalized) ||
    /\bdoes not pass\b/.test(normalized) ||
    /\bnot pass\b/.test(normalized) ||
    /\bneeds? revision\b/.test(normalized) ||
    /\botherwise\b.*\b(go|return|back)\b/.test(normalized);
}

function collectWorkflowTemporalStageDiagnostics(
  nodes: CanvasDiagnosticNode[],
  edges: CanvasDiagnosticEdge[]
): CanvasRuleDiagnostic[] {
  const stageNodes = nodes.filter((node) => node.type === "stage");
  if (stageNodes.length === 0) {
    return [
      {
        ruleId: WORKFLOW_CANVASES_MUST_SHOW_TEMPORAL_STAGE_PROCESS_RULE_ID,
        severity: "error",
        summary:
          "workflow canvas has no stage nodes; concrete temporal workflow stages should use node type stage",
      },
    ];
  }

  const stageNodeIds = new Set(stageNodes.map((node) => node.id));
  const stageTransitionEdges = edges.filter(
    (edge) => stageNodeIds.has(edge.source) && stageNodeIds.has(edge.target)
  );
  const diagnostics: CanvasRuleDiagnostic[] = [];

  if (stageNodes.length > 1 && stageTransitionEdges.length === 0) {
    diagnostics.push({
      ruleId: WORKFLOW_CANVASES_MUST_SHOW_TEMPORAL_STAGE_PROCESS_RULE_ID,
      severity: "error",
      summary:
        "workflow canvas has multiple stage nodes but no explicit stage-to-stage transition edges",
    });
  }

  const loopImplyingNode = stageNodes.find((node) =>
    workflowLabelImpliesLoop(
      typeof node.data?.label === "string" ? node.data.label : ""
    )
  );
  if (loopImplyingNode && !workflowGraphHasStageCycle(nodes, edges)) {
    diagnostics.push({
      ruleId: WORKFLOW_CANVASES_MUST_SHOW_TEMPORAL_STAGE_PROCESS_RULE_ID,
      severity: "error",
      summary:
        "workflow stage text implies repetition or return to an earlier stage, but the workflow graph has no visible loop",
      evidence: `label=${JSON.stringify(displayNodeLabel(loopImplyingNode))}`,
      nodeId: loopImplyingNode.id,
      label: displayNodeLabel(loopImplyingNode),
    });
  }

  return diagnostics;
}

export function collectCanvasRuleDiagnostics(args: {
  nodes: CanvasDiagnosticNode[];
  edges: CanvasDiagnosticEdge[];
  stateSchema: RuntimeStateField[];
  rules?: readonly CanvasRuleDefinition[];
  target?: CanvasRuleTarget;
}): CanvasRuleDiagnostic[] {
  const scopedRules =
    args.target === "workflow" && !args.rules
      ? []
      : filterRulesForTarget(args.rules, args.target);

  return [
    ...collectDeclarativeRuleDiagnostics(
      args.nodes,
      scopedRules,
      args.stateSchema
    ),
    ...(ruleIsActive(scopedRules, CANVAS_MUST_HAVE_SINGLE_START_NODE_RULE_ID) &&
    !hasDeclarativeCheck(scopedRules, CANVAS_MUST_HAVE_SINGLE_START_NODE_RULE_ID)
      ? collectStartNodeSingletonDiagnostics(args.nodes)
      : []),
    ...(ruleIsActive(scopedRules, CONDITION_NODES_MUST_BE_REAL_CONDITIONS_RULE_ID) ||
    ruleIsActive(scopedRules, IF_CONDITIONS_MUST_HAVE_DISTINCT_TRUE_FALSE_BRANCHES_RULE_ID)
      ? collectConditionRuleDiagnostics(args.nodes, args.edges, args.stateSchema).filter(
          (diagnostic) => ruleIsActive(scopedRules, diagnostic.ruleId)
        )
      : []),
    ...(ruleIsActive(scopedRules, LOCAL_INPUTS_MUST_BE_DEFINED_ON_ALL_PATHS_RULE_ID)
      ? collectLocalInputAvailabilityDiagnostics(
          args.nodes,
          args.edges,
          args.stateSchema
        )
      : []),
    ...(ruleIsActive(
      scopedRules,
      DETERMINISTIC_STATE_UPDATES_SHOULD_USE_CODE_NODES_RULE_ID
    )
      ? collectDeterministicStatePromptDiagnostics(args.nodes, args.stateSchema)
      : []),
    ...(ruleIsExplicitlyActive(
      scopedRules,
      POLICY_CANVASES_MUST_HAVE_EDITABLE_COMMIT_CODE_RULE_ID
    )
      ? collectPolicyCommitTemplateDiagnostics(args.nodes)
      : []),
    ...(ruleIsExplicitlyActive(
      scopedRules,
      STATE_CANVASES_MUST_START_WITH_EDITABLE_INGRESS_APPEND_CODE_RULE_ID
    )
      ? collectStateIngressTemplateDiagnostics(args.nodes, args.edges)
      : []),
    ...(ruleIsExplicitlyActive(
      scopedRules,
      STATE_CANVASES_MUST_INCLUDE_SUMMARY_MEMORY_GATE_RULE_ID
    )
      ? collectStateSummaryMemoryGateDiagnostics(args.nodes, args.edges)
      : []),
    ...(ruleIsActive(
      scopedRules,
      PROMPT_SUBTREE_STEPS_MUST_NOT_OVERLAP_ON_EXECUTION_PATH_RULE_ID
    )
      ? collectPromptSubtreeExecutionOverlapDiagnostics(
          args.nodes,
          args.edges,
          args.stateSchema,
          args.target
        )
      : []),
    ...(args.target === "workflow" &&
    ruleIsActive(
      scopedRules,
      WORKFLOW_CANVASES_MUST_SHOW_TEMPORAL_STAGE_PROCESS_RULE_ID
    )
      ? collectWorkflowTemporalStageDiagnostics(args.nodes, args.edges)
      : []),
  ];
}

export function collectCanvasRuleDiagnosticsForDoc(
  doc: CanvasDoc | null,
  stateSchema: RuntimeStateField[],
  rules?: readonly CanvasRuleDefinition[],
  target?: CanvasRuleTarget
): CanvasRuleDiagnostic[] {
  if (!doc) {
    return [];
  }

  return doc.canvases.flatMap((canvas) =>
    collectCanvasRuleDiagnostics({
      nodes: canvas.graph.nodes,
      edges: canvas.graph.edges,
      stateSchema,
      rules,
      target,
    }).map((diagnostic) => ({
      ...diagnostic,
      canvasId: canvas.id,
      canvasName: canvas.name,
    }))
  );
}
