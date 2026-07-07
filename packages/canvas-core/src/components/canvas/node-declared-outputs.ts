import { getNodeActionSubtype } from "./action-subtype";
import { normalizePromptOutputFields } from "./prompt-output-fields";
import { CARRIED_OUTPUT_PROMPT_VALUE_NAME } from "../../lib/canvas-flow-values";
import {
  canRuntimeOperationQueueAsAsync,
  describeAsyncJobDeclaredOutputFields,
  getAsyncRuntimeOperationResultVariableFallback,
  isAsyncJobRuntimeOperation,
  readAsyncJobResultVariable,
  readCanvasAsyncExecutionMode,
} from "../../lib/canvas-async-job-config";
import {
  getRuntimeOperationKindFromNode,
  type CanvasNodeRecord,
} from "./types";
import { readExplicitNodeLocalOutputNames } from "../../lib/canvas-node-code-ops";
import { readNodeCodeLocalOutputFields } from "../../lib/canvas-node-code-script";

export interface CanvasDeclaredOutputField {
  name: string;
  type: string;
  origin: string;
}

function readToolResultVariableName(
  node: Pick<CanvasNodeRecord, "type" | "data">
): string {
  const explicit =
    typeof node.data?.resultVariable === "string"
      ? node.data.resultVariable.trim()
      : "";
  if (explicit) {
    return explicit;
  }

  const toolName =
    typeof node.data?.toolName === "string" ? node.data.toolName.trim() : "";
  if (toolName) {
    return toolName;
  }

  const label =
    typeof node.data?.label === "string" ? node.data.label.trim() : "";
  return label;
}

function isToolCallNode(node: Pick<CanvasNodeRecord, "type" | "data">): boolean {
  return (
    node.type === "tool_call" ||
    getNodeActionSubtype(node) === "tool_call"
  );
}

function readPromptTransformOutputVariableName(
  node: Pick<CanvasNodeRecord, "type" | "data">
): string {
  if (getNodeActionSubtype(node) !== "prompt_transform") {
    return "";
  }

  const raw =
    typeof node.data?.outputVariable === "string"
      ? node.data.outputVariable.trim()
      : "";
  const inputVariableRaw =
    typeof node.data?.inputVariable === "string"
      ? node.data.inputVariable.trim()
      : CARRIED_OUTPUT_PROMPT_VALUE_NAME;
  const inputVariable = inputVariableRaw || CARRIED_OUTPUT_PROMPT_VALUE_NAME;
  return raw === CARRIED_OUTPUT_PROMPT_VALUE_NAME || raw === inputVariable
    ? ""
    : raw;
}

function getRuntimeOperationOutputFields(
  node: Pick<CanvasNodeRecord, "type" | "data">
): CanvasDeclaredOutputField[] {
  const runtimeOperation = getRuntimeOperationKindFromNode(node);
  if (
    runtimeOperation === "build_initial_canvas_shape_materialization_requests"
  ) {
    return [
      {
        name: "initial_canvas_shape_materialization_requests",
        type: "json",
        origin: "runtime output",
      },
      {
        name: "initial_canvas_shape_materialization_requests_exist",
        type: "boolean",
        origin: "runtime output",
      },
    ];
  }

  if (runtimeOperation === "prepare_canvas_rule_detection_requests") {
    return [
      {
        name: "canvas_rule_detection_requests",
        type: "json",
        origin: "runtime output",
      },
      {
        name: "canvas_rule_preflight_changes_applied",
        type: "boolean",
        origin: "runtime output",
      },
      {
        name: "canvas_rule_preflight_change_summaries",
        type: "json",
        origin: "runtime output",
      },
    ];
  }

  if (runtimeOperation === "build_canvas_rule_repair_requests") {
    return [
      {
        name: "canvas_rule_repair_requests",
        type: "json",
        origin: "runtime output",
      },
    ];
  }

  if (runtimeOperation === "apply_canvas_rule_repairs") {
    return [
      {
        name: "canvas_rule_repair_changes_applied",
        type: "boolean",
        origin: "runtime output",
      },
      {
        name: "canvas_rule_repair_change_summaries",
        type: "json",
        origin: "runtime output",
      },
    ];
  }

  if (runtimeOperation === "prepare_canvas_rule_recheck_requests") {
    return [
      {
        name: "canvas_rule_recheck_requests",
        type: "json",
        origin: "runtime output",
      },
      {
        name: "canvas_rule_any_changes_applied",
        type: "boolean",
        origin: "runtime output",
      },
      {
        name: "canvas_rule_recheck_change_summaries",
        type: "json",
        origin: "runtime output",
      },
    ];
  }

  if (runtimeOperation === "finalize_canvas_rule_repair_pass") {
    return [
      {
        name: "canvas_rule_violations_detected",
        type: "boolean",
        origin: "runtime output",
      },
      {
        name: "canvas_rule_repairs_applied",
        type: "boolean",
        origin: "runtime output",
      },
      {
        name: "canvas_rule_violations_remaining",
        type: "boolean",
        origin: "runtime output",
      },
      {
        name: "canvas_rule_retry_needed",
        type: "boolean",
        origin: "runtime output",
      },
    ];
  }

  if (runtimeOperation === "repair_canvas_rules") {
    return [
      {
        name: "canvas_rule_violations_detected",
        type: "boolean",
        origin: "runtime output",
      },
      {
        name: "canvas_rule_repairs_applied",
        type: "boolean",
        origin: "runtime output",
      },
      {
        name: "canvas_rule_violations_remaining",
        type: "boolean",
        origin: "runtime output",
      },
      {
        name: "canvas_rule_retry_needed",
        type: "boolean",
        origin: "runtime output",
      },
    ];
  }

  return [];
}

export function getCanvasNodeDeclaredOutputFields(
  node: Pick<CanvasNodeRecord, "type" | "data">
): CanvasDeclaredOutputField[] {
  if (isToolCallNode(node)) {
    const name = readToolResultVariableName(node);
    if (!name) {
      return [];
    }
    if (readCanvasAsyncExecutionMode(node.data) === "async") {
      return describeAsyncJobDeclaredOutputFields(name, "async tool job");
    }
    return [
      {
        name,
        type: "json",
        origin: "tool result",
      },
    ];
  }

  const runtimeOperation = getRuntimeOperationKindFromNode(node);
  if (runtimeOperation && isAsyncJobRuntimeOperation(runtimeOperation)) {
    return describeAsyncJobDeclaredOutputFields(
      readAsyncJobResultVariable(node.data),
      "async job runtime output"
    );
  }

  if (
    runtimeOperation &&
    canRuntimeOperationQueueAsAsync(runtimeOperation) &&
    readCanvasAsyncExecutionMode(node.data) === "async"
  ) {
    return describeAsyncJobDeclaredOutputFields(
      readAsyncJobResultVariable(
        node.data,
        getAsyncRuntimeOperationResultVariableFallback(runtimeOperation)
      ),
      "async runtime job"
    );
  }

  const promptOutputs = normalizePromptOutputFields(node.data?.promptOutputFields).map(
    (field) => ({
      name: field.name,
      type: field.type,
      origin: "local output",
    })
  );

  const codeLocalOutputs = readExplicitNodeLocalOutputNames(node).map((name) => ({
    name,
    type: "json",
    origin: "local output",
  }));

  const codeScriptOutputs = readNodeCodeLocalOutputFields(node).map((field) => ({
    name: field.name,
    type: field.type,
    origin: "local output",
  }));
  const promptTransformOutput = readPromptTransformOutputVariableName(node);

  return [
    ...(promptTransformOutput
      ? [
          {
            name: promptTransformOutput,
            type: "string",
            origin: "prompt transform output",
          },
        ]
      : []),
    ...promptOutputs,
    ...codeLocalOutputs,
    ...codeScriptOutputs,
    ...getRuntimeOperationOutputFields(node),
  ];
}
