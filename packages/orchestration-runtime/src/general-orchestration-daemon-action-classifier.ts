import OpenAI from "openai";

import { getNodeActionSubtype } from "@airlab/canvas-core/components/canvas/action-subtype";
import { normalizePromptOutputFields } from "@airlab/canvas-core/components/canvas/prompt-output-fields";
import {
  getRuntimeOperationKindFromNode,
  type CanvasDoc,
  type CanvasEntry,
  type CanvasNodeRecord,
} from "@airlab/canvas-compiler/types";
import type {
  RuntimeStateField,
  StateCodeOperation,
} from "@airlab/canvas-planner/canvas-hybrid-runtime";
import {
  NODE_EXECUTABLE_CODE_OPS_DATA_KEY,
  normalizeNodeExecutableStateCodeOps,
  readExplicitNodeExecutableStateCodeOps,
} from "@airlab/canvas-core/lib/canvas-node-code-ops";
import { nodeHasExecutableCodeSource } from "@airlab/canvas-core/lib/canvas-node-code-script";
import { parseStateActionLabel } from "@airlab/canvas-planner/canvas-structural-planner";
import type { OrchestrationProject } from "@airlab/orchestration-core/general-orchestration";
import { parseJsonObject } from "./json-object-extraction";
import { buildRuntimeStateSchema } from "./orchestration-run-runtime";

type DaemonCanvasPhase = "policy" | "state";

const DEFAULT_DAEMON_ACTION_CLASSIFIER_MAX_COMPLETION_TOKENS = 3000;

let daemonActionClassifierOpenAiModel = "";
let daemonActionClassifierMaxCompletionTokens =
  DEFAULT_DAEMON_ACTION_CLASSIFIER_MAX_COMPLETION_TOKENS;

export function registerDaemonActionClassifierOpenAiConfig(config: {
  model: string;
  maxCompletionTokens?: number;
}): void {
  daemonActionClassifierOpenAiModel = config.model.trim();
  if (
    typeof config.maxCompletionTokens === "number" &&
    Number.isFinite(config.maxCompletionTokens) &&
    config.maxCompletionTokens > 0
  ) {
    daemonActionClassifierMaxCompletionTokens = Math.trunc(
      config.maxCompletionTokens
    );
  }
}

function getDaemonActionClassifierOpenAiModel(): string {
  if (!daemonActionClassifierOpenAiModel) {
    throw new Error("Daemon action classifier OpenAI model is not registered.");
  }
  return daemonActionClassifierOpenAiModel;
}

interface DaemonActionClassificationCandidate {
  nodeKey: string;
  phase: DaemonCanvasPhase;
  canvasId: string;
  canvasName: string;
  nodeId: string;
  label: string;
  actionType: string;
  actionTypeSource: string;
  promptOutputFields: Array<{
    name: string;
    type: string;
    instruction: string;
  }>;
  hasExecutableCodeOps: boolean;
}

interface DaemonActionClassificationDecision {
  nodeKey?: unknown;
  actionType?: unknown;
  executableCodeOps?: unknown;
}

interface DaemonActionResolution {
  actionType: "code" | "prompt";
  executableCodeOps: StateCodeOperation[] | null;
}

function collectCandidatesFromDoc(
  doc: CanvasDoc | null,
  phase: DaemonCanvasPhase,
  stateSchema: RuntimeStateField[]
): DaemonActionClassificationCandidate[] {
  if (!doc) {
    return [];
  }

  return doc.canvases.flatMap((canvas: CanvasEntry) =>
    canvas.graph.nodes.flatMap((node: CanvasNodeRecord) => {
      if (
        (node.type !== "action" && node.type !== "prompt") ||
        getRuntimeOperationKindFromNode(node)
      ) {
        return [];
      }

      const actionType = getNodeActionSubtype(node);
      if (
        actionType === "tool_call" ||
        actionType === "code" ||
        actionType === "display" ||
        actionType === "prompt_transform"
      ) {
        return [];
      }

      const label = String(node.data?.label ?? "").trim();
      if (!label) {
        return [];
      }

      return [
        {
          nodeKey: `${phase}:${canvas.id}:${node.id}`,
          phase,
          canvasId: canvas.id,
          canvasName: canvas.name,
          nodeId: node.id,
          label,
          actionType,
          actionTypeSource:
            typeof node.data?.actionTypeSource === "string"
              ? node.data.actionTypeSource.trim()
              : "",
          promptOutputFields: normalizePromptOutputFields(
            node.data?.promptOutputFields
          ),
          hasExecutableCodeOps:
            readExplicitNodeExecutableStateCodeOps(node, stateSchema) !== null,
        },
      ];
    })
  );
}

function collectCandidates(
  project: OrchestrationProject,
  stateSchema: RuntimeStateField[]
): DaemonActionClassificationCandidate[] {
  return [
    ...collectCandidatesFromDoc(project.policyCanvases, "policy", stateSchema),
    ...collectCandidatesFromDoc(project.statePolicyCanvases, "state", stateSchema),
  ];
}

function buildClassificationPrompt(args: {
  stateSchema: RuntimeStateField[];
  candidates: DaemonActionClassificationCandidate[];
}): string {
  return [
    "Classify each unresolved daemon canvas action node as either deterministic code or prompt.",
    "Return JSON only.",
    "",
    "Decision rules:",
    "- Choose code only when the node should run with deterministic executable state ops and no open-ended model reasoning.",
    "- Choose prompt when the node requires summarization, synthesis, interpretation, rewriting, extraction, or judgment.",
    "- If a node has promptOutputFields, it must be prompt because those local outputs are model-produced values.",
    "- Do not classify by label style alone; reason about the intended runtime behavior.",
    "- For code nodes, executableCodeOps must be a valid array of supported StateCodeOperation objects.",
    "- Use only these operation kinds: set_field, set_local, clear_field, append_list_item.",
    "- Supported sources are: constant, prompt_variable, current_build_snapshot, conversation_turns, latest_user_turn, latest_assistant_turn, latest_observation_event, latest_observation_and_reward_event, latest_primary_action_event, agent_latest_observation, extract_age, extract_gender, regex_capture, boolean_from_regex.",
    "- Prefer prompt if you are unsure or if the behavior is not exactly representable.",
    "",
    'Return exactly this JSON shape:',
    "{",
    '  "decisions": [',
    "    {",
    '      "nodeKey": string,',
    '      "actionType": "code" | "prompt",',
    '      "executableCodeOps": StateCodeOperation[]',
    "    }",
    "  ]",
    "}",
    "",
    "Daemon state schema:",
    JSON.stringify(
      args.stateSchema.map((field) => ({
        fieldName: field.fieldName,
        type: field.type,
        initialValue: field.initialValue,
      })),
      null,
      2
    ),
    "",
    "Unresolved candidate nodes:",
    JSON.stringify(args.candidates, null, 2),
  ].join("\n");
}

function resolveDeterministicActionSubtype(
  node: Pick<CanvasNodeRecord, "data">,
  stateSchema: RuntimeStateField[]
): DaemonActionResolution | null {
  if (normalizePromptOutputFields(node.data?.promptOutputFields).length > 0) {
    return {
      actionType: "prompt",
      executableCodeOps: null,
    };
  }

  const explicitOps = readExplicitNodeExecutableStateCodeOps(node, stateSchema);
  if (explicitOps) {
    return {
      actionType: "code",
      executableCodeOps: explicitOps,
    };
  }

  if (nodeHasExecutableCodeSource(node)) {
    return {
      actionType: "code",
      executableCodeOps: null,
    };
  }

  const parsedOps = parseStateActionLabel(String(node.data?.label ?? ""), stateSchema);
  if (parsedOps) {
    return {
      actionType: "code",
      executableCodeOps: parsedOps,
    };
  }

  return null;
}

function applyDecisionsToDoc(
  doc: CanvasDoc | null,
  decisions: Map<string, DaemonActionClassificationDecision>,
  stateSchema: RuntimeStateField[],
  phase: DaemonCanvasPhase
): CanvasDoc | null {
  if (!doc) {
    return doc;
  }

  let changed = false;

  const canvases = doc.canvases.map((canvas) => {
    let canvasChanged = false;
    const nodes = canvas.graph.nodes.map((node) => {
      if (
        (node.type !== "action" && node.type !== "prompt") ||
        getRuntimeOperationKindFromNode(node)
      ) {
        return node;
      }

      const actionType = getNodeActionSubtype(node);
      if (
        actionType === "tool_call" ||
        actionType === "code" ||
        actionType === "display" ||
        actionType === "prompt_transform"
      ) {
        return node;
      }

      const nodeKey = `${phase}:${canvas.id}:${node.id}`;
      const decision = decisions.get(nodeKey);
      const deterministicResolution = resolveDeterministicActionSubtype(
        node,
        stateSchema
      );
      const normalizedDecisionActionType =
        decision?.actionType === "code" || decision?.actionType === "prompt"
          ? decision.actionType
          : null;
      const normalizedDecisionOps =
        normalizedDecisionActionType === "code"
          ? normalizeNodeExecutableStateCodeOps(
              decision?.executableCodeOps,
              stateSchema
            )
          : null;

      const nextData: CanvasNodeRecord["data"] = {
        ...(node.data ?? {}),
        label: typeof node.data?.label === "string" ? node.data.label : "",
      };
      let nextActionType: "code" | "prompt" = "prompt";
      let nextActionTypeSource =
        typeof nextData.actionTypeSource === "string"
          ? nextData.actionTypeSource
          : undefined;
      let nextExecutableCodeOps: StateCodeOperation[] | null =
        deterministicResolution?.executableCodeOps ?? null;

      if (deterministicResolution) {
        nextActionType = deterministicResolution.actionType;
        nextActionTypeSource = "auto";
        nextExecutableCodeOps = deterministicResolution.executableCodeOps;
      } else if (normalizedDecisionActionType === "code" && normalizedDecisionOps) {
        nextActionType = "code";
        nextActionTypeSource = "auto";
        nextExecutableCodeOps = normalizedDecisionOps;
      } else if (normalizedDecisionActionType === "prompt") {
        nextActionType = "prompt";
        nextActionTypeSource = "auto";
        nextExecutableCodeOps = null;
      } else {
        return node;
      }

      nextData.actionType = nextActionType;
      nextData.actionTypeSource = nextActionTypeSource;
      if (nextExecutableCodeOps) {
        nextData[NODE_EXECUTABLE_CODE_OPS_DATA_KEY] = nextExecutableCodeOps;
      } else {
        delete nextData[NODE_EXECUTABLE_CODE_OPS_DATA_KEY];
      }

      const previousSerialized = JSON.stringify(node.data ?? {});
      const nextSerialized = JSON.stringify(nextData);
      if (previousSerialized === nextSerialized) {
        return node;
      }

      changed = true;
      canvasChanged = true;
      return {
        ...node,
        type: nextActionType === "code" ? "code" : "prompt",
        data: nextData,
      };
    });

    return canvasChanged
      ? {
          ...canvas,
          graph: {
            ...canvas.graph,
            nodes,
          },
        }
      : canvas;
  });

  return changed
    ? {
        ...doc,
        canvases,
      }
    : doc;
}

export function daemonProjectNeedsActionClassification(
  project: OrchestrationProject
): boolean {
  const normalizedProject = normalizeDaemonProjectActionNodes(project);
  const stateSchema = buildRuntimeStateSchema(normalizedProject.fields);
  return collectCandidates(normalizedProject, stateSchema).some((candidate) => {
    if (candidate.promptOutputFields.length > 0) {
      return candidate.actionType !== "prompt";
    }

    if (candidate.hasExecutableCodeOps) {
      return candidate.actionType !== "code";
    }

    const parsedOps = parseStateActionLabel(candidate.label, stateSchema);
    if (parsedOps) {
      return candidate.actionType !== "code" || !candidate.hasExecutableCodeOps;
    }

    return true;
  });
}

export function normalizeDaemonProjectActionNodes(
  project: OrchestrationProject
): OrchestrationProject {
  const stateSchema = buildRuntimeStateSchema(project.fields);
  const emptyDecisions = new Map<string, DaemonActionClassificationDecision>();

  return {
    ...project,
    policyCanvases: applyDecisionsToDoc(
      project.policyCanvases,
      emptyDecisions,
      stateSchema,
      "policy"
    ),
    statePolicyCanvases: applyDecisionsToDoc(
      project.statePolicyCanvases,
      emptyDecisions,
      stateSchema,
      "state"
    ),
  };
}

export async function classifyDaemonProjectActionNodes(args: {
  openai: OpenAI;
  project: OrchestrationProject;
}): Promise<OrchestrationProject> {
  const normalizedProject = normalizeDaemonProjectActionNodes(args.project);
  const stateSchema = buildRuntimeStateSchema(normalizedProject.fields);
  const decisionMap = new Map<string, DaemonActionClassificationDecision>();
  const unresolvedCandidates = collectCandidates(normalizedProject, stateSchema).filter(
    (candidate) =>
      candidate.promptOutputFields.length === 0 &&
      !candidate.hasExecutableCodeOps &&
      !parseStateActionLabel(candidate.label, stateSchema)
  );

  if (unresolvedCandidates.length > 0) {
    const completion = await args.openai.chat.completions.create({
      model: getDaemonActionClassifierOpenAiModel(),
      max_completion_tokens: daemonActionClassifierMaxCompletionTokens,
      messages: [
        {
          role: "system",
          content:
            "You classify daemon canvas action nodes into deterministic code or prompt and emit JSON only.",
        },
        {
          role: "user",
          content: buildClassificationPrompt({
            stateSchema,
            candidates: unresolvedCandidates,
          }),
        },
      ],
    });

    const text = completion.choices[0]?.message?.content ?? "";
    const parsed = parseJsonObject<{
      decisions?: DaemonActionClassificationDecision[];
    }>(text);

    for (const entry of parsed?.decisions ?? []) {
      const nodeKey =
        typeof entry?.nodeKey === "string" ? entry.nodeKey.trim() : "";
      if (!nodeKey) {
        continue;
      }
      decisionMap.set(nodeKey, entry);
    }
  }

  return {
    ...normalizedProject,
    policyCanvases: applyDecisionsToDoc(
      normalizedProject.policyCanvases,
      decisionMap,
      stateSchema,
      "policy"
    ),
    statePolicyCanvases: applyDecisionsToDoc(
      normalizedProject.statePolicyCanvases,
      decisionMap,
      stateSchema,
      "state"
    ),
  };
}
