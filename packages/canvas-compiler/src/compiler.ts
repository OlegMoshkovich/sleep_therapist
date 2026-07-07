import type {
  CanvasDoc,
  CanvasEntry,
  CanvasNodeRecord,
  CompiledToolDef,
  CompilerFn,
} from "./types";
import { getRuntimeOperationKindFromNode, normalizeCanvasDoc } from "./types";
import { DEFAULT_OPENCLAW_BRIDGE_PATH } from "@airlab/openclaw-runtime";
import { readCanvasAsyncContinuationPolicy } from "@airlab/canvas-core/lib/canvas-async-job-config";
import { CARRIED_OUTPUT_PROMPT_VALUE_NAME } from "@airlab/canvas-core/lib/canvas-flow-values";
import { normalizeSourceType, type ToolDispatchConfig } from "./tool-types";
import {
  getNodeActionSubtype,
  type ActionSubtype,
} from "@airlab/canvas-core/components/canvas/action-subtype";

function getActionSubtype(node: CanvasNodeRecord): ActionSubtype {
  return getNodeActionSubtype(node);
}

function sanitizeToolFunctionName(raw: string): string {
  const collapsed = raw
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

  if (!collapsed) {
    return "";
  }

  const prefixed = /^[a-z_]/.test(collapsed) ? collapsed : `tool_${collapsed}`;
  return prefixed.slice(0, 64);
}

function inferToolFunctionName(node: CanvasNodeRecord, data: Record<string, unknown>): string {
  const explicitName = typeof data.toolName === "string" ? data.toolName.trim() : "";
  if (explicitName) {
    return sanitizeToolFunctionName(explicitName);
  }

  const fallbackLabel = typeof data.label === "string" ? data.label.trim() : "";
  if (!fallbackLabel) {
    return "";
  }

  return sanitizeToolFunctionName(fallbackLabel);
}

function normalizeCanvasKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[_\s]+/g, " ");
}

function isDefaultStartLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized === "" || normalized === "start";
}

function readLoopMaxIterations(
  node: Pick<CanvasNodeRecord, "data">
): number {
  const raw = node.data?.maxIterations;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1
    ? Math.min(Math.trunc(raw), 12)
    : 3;
}

function readPromptTransformInputVariable(
  node: Pick<CanvasNodeRecord, "data">
): string {
  const inputVariable =
    typeof node.data?.inputVariable === "string"
      ? node.data.inputVariable.trim()
      : "";
  return inputVariable || CARRIED_OUTPUT_PROMPT_VALUE_NAME;
}

function readPromptTransformOutputVariable(
  node: Pick<CanvasNodeRecord, "data">
): string {
  const outputVariable =
    typeof node.data?.outputVariable === "string"
      ? node.data.outputVariable.trim()
      : "";
  return outputVariable || CARRIED_OUTPUT_PROMPT_VALUE_NAME;
}

function formatPromptTransformLine(
  node: Pick<CanvasNodeRecord, "data">,
  label: string
): string {
  return `PROMPT_TRANSFORM ${readPromptTransformInputVariable(node)} -> ${readPromptTransformOutputVariable(node)} PER: ${label}`;
}

function buildCanvasKeyMap(
  doc: CanvasDoc | undefined,
  supplementalDoc?: CanvasDoc,
  fallbackEntry?: CanvasEntry
) {
  const byCanvasKey = new Map<string, CanvasEntry>();
  const candidates = [
    ...(doc?.canvases ?? []),
    ...(supplementalDoc?.canvases ?? []),
    ...(doc || supplementalDoc || !fallbackEntry ? [] : [fallbackEntry]),
  ];

  for (const canvas of candidates) {
    const key = normalizeCanvasKey(canvas.name || canvas.id);
    if (key && !byCanvasKey.has(key)) {
      byCanvasKey.set(key, canvas);
    }
  }
  return byCanvasKey;
}

function getCanvasStartPrompt(entry: CanvasEntry | null | undefined): string {
  const start = entry?.graph.nodes.find((node) => node.type === "start");
  const label = typeof start?.data?.label === "string" ? start.data.label.trim() : "";
  return label && !isDefaultStartLabel(label) ? label : "";
}

function buildCanvasExpansionMap(
  doc: CanvasDoc,
  byCanvasKey: Map<string, CanvasEntry>
): Map<string, string[]> {
  const targetsByCanvasId = new Map<string, string[]>();

  for (const canvas of doc.canvases) {
    const targets: string[] = [];
    const seenTargetIds = new Set<string>();

    for (const node of canvas.graph.nodes) {
      if (node.type !== "expand") {
        continue;
      }

      const label = typeof node.data?.label === "string" ? node.data.label.trim() : "";
      if (!label) {
        continue;
      }

      const target = byCanvasKey.get(normalizeCanvasKey(label));
      if (!target || seenTargetIds.has(target.id)) {
        continue;
      }

      seenTargetIds.add(target.id);
      targets.push(target.id);
    }

    targetsByCanvasId.set(canvas.id, targets);
  }

  return targetsByCanvasId;
}

function resolveAncestorCanvasIds(doc: CanvasDoc, canvasId: string): string[] {
  const rootCanvas = doc.canvases[0] ?? null;
  if (!rootCanvas || rootCanvas.id === canvasId) {
    return [];
  }

  const byCanvasKey = buildCanvasKeyMap(doc);
  const expansionMap = buildCanvasExpansionMap(doc, byCanvasKey);
  let bestPath: string[] = [];

  const visit = (currentCanvasId: string, path: string[]) => {
    for (const targetCanvasId of expansionMap.get(currentCanvasId) ?? []) {
      if (path.includes(targetCanvasId)) {
        continue;
      }

      if (targetCanvasId === canvasId) {
        if (path.length > bestPath.length) {
          bestPath = [...path];
        }
        continue;
      }

      visit(targetCanvasId, [...path, targetCanvasId]);
    }
  };

  visit(rootCanvas.id, [rootCanvas.id]);
  return bestPath;
}

function buildCanvasPromptPreamble(
  entry: CanvasEntry,
  promptContextDoc?: CanvasDoc
): string[] {
  const promptContext = promptContextDoc ?? {
    version: 2 as const,
    activeId: entry.id,
    canvases: [entry],
  };
  const byCanvasId = new Map(promptContext.canvases.map((canvas) => [canvas.id, canvas]));
  const prompts = resolveAncestorCanvasIds(promptContext, entry.id)
    .map((canvasId) => getCanvasStartPrompt(byCanvasId.get(canvasId) ?? null))
    .filter((prompt) => prompt.length > 0);
  const ownPrompt = getCanvasStartPrompt(entry);

  if (ownPrompt) {
    prompts.push(ownPrompt);
  }

  if (prompts.length === 0) {
    return [];
  }

  return ["General-purpose prompt:", prompts.join("\n\n"), "", "Flow:"];
}

function buildOutgoingMap(entry: CanvasEntry) {
  const byId = new Map(entry.graph.nodes.map((node) => [node.id, node]));
  const compareTargetsByVisualOrder = (
    left: (typeof entry.graph.edges)[number],
    right: (typeof entry.graph.edges)[number]
  ): number => {
    const leftNode = byId.get(left.target);
    const rightNode = byId.get(right.target);
    if (!leftNode || !rightNode) {
      return left.target.localeCompare(right.target);
    }

    const yDelta = leftNode.position.y - rightNode.position.y;
    if (Math.abs(yDelta) > 12) {
      return yDelta;
    }

    const xDelta = leftNode.position.x - rightNode.position.x;
    if (Math.abs(xDelta) > 12) {
      return xDelta;
    }

    return left.target.localeCompare(right.target);
  };
  const outgoing = new Map<string, typeof entry.graph.edges>();
  for (const edge of entry.graph.edges) {
    const arr = outgoing.get(edge.source) ?? [];
    arr.push(edge);
    outgoing.set(edge.source, arr);
  }
  for (const edges of outgoing.values()) {
    edges.sort(compareTargetsByVisualOrder);
  }
  return outgoing;
}

function appendCanvasFlow(
  entry: CanvasEntry,
  byCanvasKey: Map<string, CanvasEntry>,
  lines: string[],
  indent: number,
  expansionTrail: string[],
  rootNodeId?: string
) {
  const { nodes } = entry.graph;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = buildOutgoingMap(entry);
  const start = nodes.find((node) => node.type === "start");

  if (!start) {
    lines.push(`${"  ".repeat(indent)}(add a Start node to begin)`);
    return;
  }

  const appendCompiledLine = (line: string, separateBefore = true) => {
    if (separateBefore && lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(line);
  };

  const walk = (
    nodeId: string,
    nextIndent: number,
    path: Set<string>,
    options?: {
      branchLabel?: string;
      branchIndent?: number;
      separateBefore?: boolean;
      stopAfterNode?: boolean;
    }
  ) => {
    const node = byId.get(nodeId);
    if (!node) return;

    const pathKey = `${entry.id}:${node.id}`;
    const pad = "  ".repeat(nextIndent);
    const pushNodeLine = (text: string) => {
      const line = options?.branchLabel
        ? `${"  ".repeat(options.branchIndent ?? nextIndent)}${options.branchLabel} -> ${text}`
        : `${pad}${text}`;
      appendCompiledLine(line, options?.separateBefore ?? true);
    };
    const rawLabel = node.data.label?.trim() ?? "";
    const label = rawLabel || "(unlabeled)";
    const runtimeOperation = getRuntimeOperationKindFromNode(node);

    if (path.has(pathKey)) {
      pushNodeLine(`↩ loop back to ${label}`);
      return;
    }

    const nextPath = new Set(path);
    nextPath.add(pathKey);

    if (runtimeOperation) {
      if (runtimeOperation === "build_default_primary_state_schema") {
        pushNodeLine("BUILD DEFAULT PRIMARY-AGENT STATE SCHEMA");
      } else if (runtimeOperation === "build_default_environment_state_schema") {
        pushNodeLine("BUILD DEFAULT ENVIRONMENT-AGENT STATE SCHEMAS");
      } else if (
        runtimeOperation === "build_initial_canvas_shape_materialization_requests"
      ) {
        pushNodeLine("BUILD INITIAL CANVAS SHAPE MATERIALIZATION REQUESTS");
      } else if (runtimeOperation === "materialize_initial_canvas_structures") {
        pushNodeLine("MATERIALIZE INITIAL CANVAS STRUCTURES");
      } else if (
        runtimeOperation === "merge_materialized_initial_canvas_structures"
      ) {
        pushNodeLine("MERGE MATERIALIZED INITIAL CANVAS STRUCTURES");
      } else if (runtimeOperation === "prepare_canvas_rule_detection_requests") {
        pushNodeLine("PREPARE CANVAS RULE DETECTION REQUESTS");
      } else if (runtimeOperation === "build_canvas_rule_repair_requests") {
        pushNodeLine("BUILD CANVAS RULE REPAIR REQUESTS");
      } else if (runtimeOperation === "apply_canvas_rule_repairs") {
        pushNodeLine("APPLY CANVAS RULE REPAIRS");
      } else if (runtimeOperation === "prepare_canvas_rule_recheck_requests") {
        pushNodeLine("PREPARE CANVAS RULE RECHECK REQUESTS");
      } else if (runtimeOperation === "finalize_canvas_rule_repair_pass") {
        pushNodeLine("FINALIZE CANVAS RULE REPAIR PASS");
      } else if (runtimeOperation === "apply_structured_patch") {
        pushNodeLine("APPLY STRUCTURED PATCH");
      } else if (runtimeOperation === "scaffold_tools") {
        pushNodeLine("SCAFFOLD TOOLS");
      } else if (runtimeOperation === "sync_derived_prompts") {
        pushNodeLine("SYNC DERIVED PROMPTS");
      } else if (runtimeOperation === "repair_canvas_rules") {
        pushNodeLine("REPAIR CANVAS RULES");
      } else if (runtimeOperation === "raise_error") {
        pushNodeLine(`RAISE ERROR — ${label}`);
      } else {
        pushNodeLine("FINALIZE ASSISTANT REPLY");
      }
    } else {
      switch (node.type) {
      case "start":
        pushNodeLine("START");
        break;
      case "condition":
        pushNodeLine(`IF ${label}`);
        break;
      case "for":
        pushNodeLine(`FOR UP TO ${readLoopMaxIterations(node)} ITERATIONS — ${label}`);
        break;
      case "while":
        pushNodeLine(`WHILE ${label} (max ${readLoopMaxIterations(node)})`);
        break;
      case "prompt": {
        const promptType = getActionSubtype(node);
        if (promptType === "prompt_transform") {
          pushNodeLine(formatPromptTransformLine(node, label));
        } else {
          pushNodeLine(`PROMPT ${label}`);
        }
        break;
      }
      case "code":
        pushNodeLine(`CODE ${label}`);
        break;
      case "call_agent": {
        const targetAgentId =
          typeof node.data.targetAgentId === "string" &&
          node.data.targetAgentId.trim()
            ? node.data.targetAgentId.trim()
            : "";
        const callAgentType =
          node.data.callAgentType === "internal_connection"
            ? "internal_connection"
            : node.data.callAgentType === "external_agent"
              ? "external_agent"
              : node.data.callAgentType === "openclaw"
                ? "openclaw"
                : node.data.callAgentType === "hermes"
                  ? "hermes"
                  : "default";
        const endpoint =
          typeof node.data.url === "string" && node.data.url.trim()
            ? node.data.url.trim()
            : callAgentType === "openclaw"
              ? DEFAULT_OPENCLAW_BRIDGE_PATH
              : "";
        const executionMode = node.data.executionMode === "async" ? "async" : "sync";
        const details = [
          callAgentType !== "default" ? `type=${callAgentType}` : "",
          targetAgentId ? `target_agent_id=${targetAgentId}` : "",
          endpoint ? `endpoint=${endpoint}` : "",
          `mode=${executionMode}`,
        ].filter(Boolean);
        pushNodeLine(
          `CALL AGENT ${label}${details.length > 0 ? ` (${details.join(", ")})` : ""}`
        );
        break;
      }
      case "display": {
        const displayType = node.data.displayType === "video" ? "video" : "text";
        const inputVariable =
          typeof node.data.inputVariable === "string" && node.data.inputVariable.trim()
            ? node.data.inputVariable.trim()
            : "carried_output";
        pushNodeLine(
          displayType === "video"
            ? `DISPLAY VIDEO ${label}`
            : `DISPLAY TEXT ${inputVariable}`
        );
        break;
      }
      case "action": {
        const actionType = getActionSubtype(node);
        if (actionType === "tool_call") {
          pushNodeLine(`CALL ${label}`);
        } else if (actionType === "prompt") {
          pushNodeLine(`PROMPT ${label}`);
        } else if (actionType === "display") {
          pushNodeLine("DISPLAY previous output");
        } else if (actionType === "prompt_transform") {
          pushNodeLine(formatPromptTransformLine(node, label));
        } else if (actionType === "code") {
          pushNodeLine(`CODE ${label}`);
        } else {
          pushNodeLine(`DO ${label}`);
        }
        break;
      }
      case "tool_call":
        pushNodeLine(`CALL ${label}`);
        break;
      case "terminate":
        pushNodeLine(
          `TERMINATE INTERACTION: ${label}. No future turns; use only when the current task is complete.`
        );
        break;
      case "yield":
        pushNodeLine(
          `END TURN: ${label}. The interaction remains open and may resume on the next user, job, or timer event.`
        );
        break;
      case "continue":
        pushNodeLine(
          `CONTINUE STAGE: ${label}. The current action is kept, and the next turn stays in this stage canvas.`
        );
        break;
      case "terminate_stage":
        pushNodeLine(
          `TERMINATE STAGE: ${label}. The current action is kept, and the next turn is controlled by the next stage canvas.`
        );
        break;
      case "terminate_stage_immediate":
        pushNodeLine(
          `TERMINATE STAGE AND MOVE IMMEDIATELY: ${label}. The current action is kept, then the next stage state canvas runs before the other agent acts.`
        );
        break;
      case "expand": {
        const target = byCanvasKey.get(normalizeCanvasKey(label));
        if (!target) {
          pushNodeLine(`MISSING SUBTREE — ${label}`);
          break;
        }

        if (expansionTrail.includes(target.id)) {
          pushNodeLine(`↩ recursive subtree reference to ${target.name || label}`);
          break;
        }

        pushNodeLine(`SUBTREE ${target.name || label}:`);
        appendCanvasFlow(
          target,
          byCanvasKey,
          lines,
          nextIndent + 1,
          [...expansionTrail, target.id]
        );
        break;
      }
    }
    }

    if (
      options?.stopAfterNode ||
      node.type === "terminate" ||
      node.type === "continue" ||
      node.type === "terminate_stage" ||
      node.type === "terminate_stage_immediate"
    ) {
      return;
    }

    const out = outgoing.get(nodeId) ?? [];
    // A branch drawn from the node body (no sourceHandle) is treated as the one
    // missing branch, mirroring getConditionTargets/getLoopTargets in the
    // structural planner so the compiled tree matches what actually runs.
    const fillMissingBranch = (
      a: (typeof out)[number] | undefined,
      b: (typeof out)[number] | undefined
    ): (typeof out)[number] | undefined => {
      if (Boolean(a) === Boolean(b)) return undefined;
      const plain = out.filter((edge) => !edge.sourceHandle);
      return plain.length === 1 ? plain[0] : undefined;
    };
    if (node.type === "condition") {
      const trueEdge = out.find((edge) => edge.sourceHandle === "true");
      const falseEdge = out.find((edge) => edge.sourceHandle === "false");
      const filled = fillMissingBranch(trueEdge, falseEdge);
      const resolvedTrue = trueEdge ?? filled;
      const resolvedFalse = falseEdge ?? filled;
      const branchTargetIds = new Set<string>();
      if (resolvedTrue) {
        branchTargetIds.add(resolvedTrue.target);
        walk(resolvedTrue.target, nextIndent + 2, nextPath, {
          branchLabel: "TRUE",
          branchIndent: nextIndent + 1,
          separateBefore: false,
          stopAfterNode: true,
        });
      }
      if (resolvedFalse) {
        branchTargetIds.add(resolvedFalse.target);
        walk(resolvedFalse.target, nextIndent + 2, nextPath, {
          branchLabel: "FALSE",
          branchIndent: nextIndent + 1,
          separateBefore: false,
          stopAfterNode: true,
        });
      }
      const continuationEdges = [resolvedTrue, resolvedFalse]
        .flatMap((edge) => (edge ? (outgoing.get(edge.target) ?? []) : []))
        .filter((edge) => !branchTargetIds.has(edge.target));
      const seenContinuationTargets = new Set<string>();
      for (const edge of continuationEdges) {
        if (seenContinuationTargets.has(edge.target)) {
          continue;
        }
        seenContinuationTargets.add(edge.target);
        walk(edge.target, nextIndent + 1, nextPath);
      }
      if (!resolvedTrue && !resolvedFalse && out.length > 0) {
        for (const edge of out) walk(edge.target, nextIndent + 1, nextPath);
      }
      return;
    }

    if (node.type === "for" || node.type === "while") {
      const bodyHandleEdge = out.find((edge) => edge.sourceHandle === "body");
      const doneHandleEdge = out.find((edge) => edge.sourceHandle === "done");
      const filled = fillMissingBranch(bodyHandleEdge, doneHandleEdge);
      const bodyEdge = bodyHandleEdge ?? filled;
      const doneEdge = doneHandleEdge ?? filled;
      if (bodyEdge) {
        walk(bodyEdge.target, nextIndent + 2, nextPath, {
          branchLabel: "BODY",
          branchIndent: nextIndent + 1,
          separateBefore: false,
        });
      }
      if (doneEdge) {
        walk(doneEdge.target, nextIndent + 2, nextPath, {
          branchLabel: "DONE",
          branchIndent: nextIndent + 1,
          separateBefore: false,
        });
      }
      if (!bodyEdge && !doneEdge && out.length > 0) {
        for (const edge of out) walk(edge.target, nextIndent + 1, nextPath);
      }
      return;
    }

    if (node.type === "tool_call" || node.type === "call_agent") {
      const successEdges = out.filter((edge) => edge.sourceHandle !== "error");
      const errorEdge = out.find((edge) => edge.sourceHandle === "error");
      for (const edge of successEdges) {
        walk(edge.target, nextIndent, nextPath);
      }
      if (errorEdge) {
        walk(errorEdge.target, nextIndent + 2, nextPath, {
          branchLabel: "ERROR",
          branchIndent: nextIndent + 1,
          separateBefore: false,
        });
      }
      return;
    }

    for (const edge of out) {
      walk(edge.target, nextIndent, nextPath);
    }
  };

  if (rootNodeId) {
    if (!byId.has(rootNodeId)) {
      lines.push(`${"  ".repeat(indent)}(subtree is empty)`);
      return;
    }
    walk(rootNodeId, indent, new Set([`${entry.id}:${start.id}`]));
    return;
  }

  const startOutgoing = outgoing.get(start.id) ?? [];
  if (startOutgoing.length === 0) {
    lines.push(`${"  ".repeat(indent)}(subtree is empty)`);
    return;
  }

  for (const edge of startOutgoing) {
    walk(edge.target, indent, new Set([`${entry.id}:${start.id}`]));
  }
}

/**
 * Generates the per-canvas pseudocode block consumed by the chat runtime
 * (e.g. `IF …`, `DO …`, named subtree references). Output format matches the
 * legacy PolicyFlowEditor so the runtime parser stays unchanged.
 */
export function generatePseudocode(
  entry: CanvasEntry,
  doc?: CanvasDoc,
  promptContextDoc?: CanvasDoc
): string {
  const start = entry.graph.nodes.find((node) => node.type === "start");
  if (!start) return "(add a Start node to begin)";

  const byCanvasKey = buildCanvasKeyMap(doc, promptContextDoc, entry);
  const preamble = buildCanvasPromptPreamble(entry, promptContextDoc ?? doc);

  const lines: string[] = [];
  appendCanvasFlow(entry, byCanvasKey, lines, 0, [entry.id]);
  return [...preamble, ...lines].join("\n");
}

export function generatePseudocodeFromNode(
  entry: CanvasEntry,
  rootNodeId: string,
  doc?: CanvasDoc,
  promptContextDoc?: CanvasDoc
): string {
  const start = entry.graph.nodes.find((node) => node.type === "start");
  if (!start) return "(add a Start node to begin)";

  const byCanvasKey = buildCanvasKeyMap(doc, promptContextDoc, entry);
  const preamble = buildCanvasPromptPreamble(entry, promptContextDoc ?? doc);

  const lines: string[] = [];
  appendCanvasFlow(entry, byCanvasKey, lines, 0, [entry.id], rootNodeId);
  return [...preamble, ...lines].join("\n");
}

const GENERATED_HEADER = "## Policy Flowchart (auto-generated)";
const NOTES_HEADER = "## Additional policy notes";
const FORMAT_HEADER = "## Output format rules (mandatory)";
const WORKFLOW_OVERVIEW_CANVAS_MARKER = "airlab:workflow-overview";

function isRuntimeExcludedCanvas(entry: CanvasEntry): boolean {
  if ((entry.freeText ?? "").includes(WORKFLOW_OVERVIEW_CANVAS_MARKER)) {
    return true;
  }

  return entry.graph.nodes.some(
    (node) =>
      node.data?.workflowOverview === true ||
      node.data?.runtimeRole === "workflow_overview"
  );
}

function buildRuntimeCanvasDoc(doc: CanvasDoc): CanvasDoc {
  const canvases = doc.canvases.filter((canvas) => !isRuntimeExcludedCanvas(canvas));
  const activeCanvas = canvases.find((canvas) => canvas.id === doc.activeId) ?? canvases[0];

  return {
    ...doc,
    activeId: activeCanvas?.id ?? "",
    canvases,
  };
}

/**
 * Collects the instruction text from every prompt_transform action node across all
 * canvases. These rules are hoisted out of the conditional flow into a
 * dedicated global section so the model applies them regardless of which
 * branch it took — otherwise a prompt_transform node positioned inside a FALSE
 * branch would read as a path-specific hint instead of a hard requirement.
 */
function collectPromptTransformRules(doc: CanvasDoc): string[] {
  const rules: string[] = [];
  for (const canvas of doc.canvases) {
    for (const node of canvas.graph.nodes) {
      const d = node.data as { label?: string };
      if (getActionSubtype(node) !== "prompt_transform") {
        continue;
      }
      const text = (d.label ?? "").trim();
      if (text) rules.push(text);
    }
  }
  return rules;
}

export function buildCanvasText(doc: CanvasDoc): string {
  const normalizedDoc = buildRuntimeCanvasDoc(normalizeCanvasDoc(doc) ?? doc);
  const pieces: string[] = [GENERATED_HEADER, ""];

  if (normalizedDoc.canvases.length === 0) {
    pieces.push("(no canvases yet)");
  } else {
    normalizedDoc.canvases.forEach((c, idx) => {
      if (idx > 0) pieces.push("");
      pieces.push(`### Canvas: ${c.name || `Canvas ${idx + 1}`}`);
      pieces.push("");
      pieces.push(generatePseudocode(c, normalizedDoc) || "(flowchart is empty)");
    });
  }

  const notes = normalizedDoc.canvases
    .map((c) => {
      const t = (c.freeText ?? "").trim();
      if (!t) return null;
      return `### ${c.name || c.id}\n${t}`;
    })
    .filter((x): x is string => !!x);

  if (notes.length > 0) {
    pieces.push("", NOTES_HEADER, "", notes.join("\n\n"));
  }

  const promptTransformRules = collectPromptTransformRules(normalizedDoc);
  if (promptTransformRules.length > 0) {
    const formatLines = [
      FORMAT_HEADER,
      "",
      "Your final answer to the user MUST satisfy every rule below.",
      "These apply regardless of which branch of the flowchart ran.",
      "",
      ...promptTransformRules.map((r) => `- ${r}`),
    ];
    pieces.push("", formatLines.join("\n"));
  }

  return pieces.join("\n");
}

export function buildCanvasSubtreeText(
  doc: CanvasDoc,
  canvasId: string,
  rootNodeId?: string,
  promptContextDoc?: CanvasDoc
): string {
  const normalizedDoc = normalizeCanvasDoc(doc) ?? doc;
  const normalizedPromptContextDoc = promptContextDoc
    ? (normalizeCanvasDoc(promptContextDoc) ?? promptContextDoc)
    : normalizedDoc;
  const entry = normalizedDoc.canvases.find((canvas) => canvas.id === canvasId);
  if (!entry) {
    return "(missing canvas)";
  }

  const pieces: string[] = [
    GENERATED_HEADER,
    "",
    `### Canvas: ${entry.name || entry.id}`,
    "",
    rootNodeId
      ? generatePseudocodeFromNode(
          entry,
          rootNodeId,
          normalizedDoc,
          normalizedPromptContextDoc
        )
      : generatePseudocode(entry, normalizedDoc, normalizedPromptContextDoc),
  ];

  const notes = (entry.freeText ?? "").trim();
  if (notes) {
    pieces.push("", NOTES_HEADER, "", `### ${entry.name || entry.id}\n${notes}`);
  }

  return pieces.join("\n");
}

function compileToolsFromDoc(doc: CanvasDoc): CompiledToolDef[] {
  const tools: CompiledToolDef[] = [];
  const seen = new Set<string>();
  const runtimeDoc = buildRuntimeCanvasDoc(doc);

  for (const canvas of runtimeDoc.canvases) {
    for (const node of canvas.graph.nodes) {
      const subtype = getActionSubtype(node);
      const isToolCallNode = node.type === "tool_call" || subtype === "tool_call";
      if (!isToolCallNode) continue;

      const d = node.data as Record<string, unknown>;
      const toolName = inferToolFunctionName(node, d);
      const url = typeof d.url === "string" ? d.url.trim() : "";

      const saveTarget = d.saveTarget === "dataset" ? "dataset" : "knowledge";
      const datasetName = typeof d.datasetName === "string" ? d.datasetName.trim() : "";
      const rawSourceType = normalizeSourceType(d.sourceType);
      const sourceType: ToolDispatchConfig["sourceType"] = rawSourceType;
      const executionMode = d.executionMode === "async" ? "async" : "sync";
      const asyncContinuationPolicy =
        executionMode === "async"
          ? readCanvasAsyncContinuationPolicy(d)
          : undefined;
      const effectiveUrl =
        sourceType === "openclaw" ? url || DEFAULT_OPENCLAW_BRIDGE_PATH : url;

      // An "mcp" tool is a reference, not an implementation: { server, tool }
      // coordinates resolved against the servers map at runtime. The compiler
      // pins the reference; the live server is resolved on dispatch.
      const refObj =
        d.ref && typeof d.ref === "object" && !Array.isArray(d.ref)
          ? (d.ref as { server?: unknown; tool?: unknown })
          : null;
      const mcpServer = refObj && typeof refObj.server === "string" ? refObj.server.trim() : "";
      const mcpRemoteTool = refObj && typeof refObj.tool === "string" ? refObj.tool.trim() : "";
      const openclawObj =
        d.openclaw && typeof d.openclaw === "object" && !Array.isArray(d.openclaw)
          ? (d.openclaw as {
              agentId?: unknown;
              mode?: unknown;
              bearerToken?: unknown;
              responseFormat?: unknown;
            })
          : null;
      const openclawConfig: ToolDispatchConfig["openclaw"] | undefined =
        sourceType === "openclaw"
          ? {
              ...(typeof openclawObj?.agentId === "string" &&
              openclawObj.agentId.trim()
                ? { agentId: openclawObj.agentId.trim() }
                : {}),
              ...(openclawObj?.mode === "sync" || openclawObj?.mode === "async"
                ? { mode: openclawObj.mode }
                : {}),
              ...(typeof openclawObj?.bearerToken === "string" &&
              openclawObj.bearerToken.trim()
                ? { bearerToken: openclawObj.bearerToken.trim() }
                : {}),
              ...(openclawObj?.responseFormat === "text" ||
              openclawObj?.responseFormat === "json"
                ? { responseFormat: openclawObj.responseFormat }
                : {}),
            }
          : undefined;
      // Fetch tools need a URL. Post tools need a tool name and, when they
      // target a dataset, a concrete dataset name as well. Dataset reads need
      // a dataset name and no URL. MCP tools need a server reference; a REST
      // fallback URL is optional.
      let requiredFieldMissing = false;
      if (sourceType === "knowledge_save") {
        requiredFieldMissing = saveTarget === "dataset" && datasetName.length === 0;
      } else if (sourceType === "dataset_read") {
        requiredFieldMissing = datasetName.length === 0;
      } else if (sourceType === "mcp") {
        requiredFieldMissing = mcpServer.length === 0;
      } else if (sourceType === "openclaw") {
        requiredFieldMissing = effectiveUrl.length === 0;
      } else if (sourceType !== "web_search") {
        requiredFieldMissing = !url;
      }
      if (!toolName || requiredFieldMissing || seen.has(toolName)) continue;
      seen.add(toolName);

      // The model only ever sees the OpenAI `description` field, so fold the
      // node's "When to call" hint (stored on d.label) into it. Order:
      //   "<description>. Call this <when-to-call>."
      // Either side may be empty; we drop empty pieces so the result is clean.
      const rawDescription =
        typeof d.description === "string" ? d.description.trim() : "";
      const rawWhenToCall =
        node.type === "tool_call" && typeof d.label === "string" ? d.label.trim() : "";
      const whenSentence = rawWhenToCall
        ? rawWhenToCall.toLowerCase().startsWith("when ")
          ? `Call this ${rawWhenToCall}.`
          : `Call this when ${rawWhenToCall}.`
        : "";
      const pieces = [rawDescription, whenSentence].filter(Boolean);
      const description = pieces.length > 0 ? pieces.join(" ") : undefined;

      let properties: Record<string, unknown> = {};
      const raw = typeof d.paramsSchema === "string" ? d.paramsSchema.trim() : "";
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            properties = parsed as Record<string, unknown>;
          }
        } catch {
          // Malformed JSON — leave properties empty so the tool is still callable.
        }
      }

      const promoteToKnowledge = d.promoteToKnowledge === true;

      const config: ToolDispatchConfig =
        sourceType === "knowledge_save"
          ? {
              sourceType,
              url: "",
              executionMode,
              asyncContinuationPolicy,
              saveTarget,
              datasetName: saveTarget === "dataset" ? datasetName : undefined,
            }
          : sourceType === "dataset_read"
            ? { sourceType, url: "", executionMode, asyncContinuationPolicy, datasetName }
          : sourceType === "mcp"
            ? {
                sourceType,
                // url is the optional REST fallback used when no MCP server is
                // configured for the referenced logical server.
                url: effectiveUrl,
                executionMode,
                asyncContinuationPolicy,
                mcp: { server: mcpServer, remoteTool: mcpRemoteTool || toolName },
                promoteToKnowledge,
              }
            : sourceType === "openclaw"
              ? {
                  sourceType,
                  url: effectiveUrl,
                  executionMode,
                  asyncContinuationPolicy,
                  ...(openclawConfig ? { openclaw: openclawConfig } : {}),
                  promoteToKnowledge,
                }
            : {
                sourceType,
                url: effectiveUrl,
                executionMode,
                asyncContinuationPolicy,
                promoteToKnowledge,
              };

      // Dataset reads always understand the reserved `query`/`limit` control
      // args, so advertise them even when the author declared no params. Only
      // author-declared params are required — the controls stay optional.
      let requiredParams = Object.keys(properties);
      if (sourceType === "dataset_read") {
        properties = {
          query: {
            type: "string",
            description: "Optional substring to match across text columns.",
          },
          limit: {
            type: "integer",
            description: "Max records to return (default 20, max 100).",
          },
          ...properties,
        };
      }
      if (sourceType === "web_search") {
        properties = {
          query: {
            type: "string",
            description: "The web search query.",
          },
          limit: {
            type: "integer",
            description: "Optional number of results to return, up to 10.",
          },
          include_content: {
            type: "boolean",
            description:
              "Optional. When true, ask the provider for fuller page content when supported.",
          },
          time_range: {
            type: "string",
            description:
              'Optional freshness filter such as "day", "week", "month", or "year".',
          },
          ...properties,
        };
        requiredParams = Array.from(new Set(["query", ...requiredParams]));
      }

      tools.push({
        type: "function",
        function: {
          name: toolName,
          description,
          parameters: {
            type: "object",
            properties,
            required: requiredParams,
          },
        },
        config,
      });
    }
  }

  return tools;
}

export const compileCanvas: CompilerFn<string> = (doc) => {
  const normalizedDoc = buildRuntimeCanvasDoc(normalizeCanvasDoc(doc) ?? doc);
  const active =
    normalizedDoc.canvases.find((c) => c.id === normalizedDoc.activeId) ??
    normalizedDoc.canvases[0] ??
    null;
  return {
    output: buildCanvasText(normalizedDoc),
    preview: active ? generatePseudocode(active, normalizedDoc) : "",
    tools: compileToolsFromDoc(normalizedDoc),
  };
};
