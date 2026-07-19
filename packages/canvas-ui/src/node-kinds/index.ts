import { createElement } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  canRuntimeOperationQueueAsAsync,
  getAsyncRuntimeOperationResultVariableFallback,
  readAsyncJobPollIntervalMs,
  readAsyncJobResultVariable,
  readAsyncJobSourceVariable,
  readAsyncJobTimeoutMs,
  readCanvasAsyncExecutionMode,
} from "@airlab/canvas-core/lib/canvas-async-job-config";
import type {
  CanvasNode,
  NodeKindDef,
  RuntimeOperationNodeKind,
} from "../types";
import { CODE, PROMPT } from "./Action";
import { CALL_AGENT } from "./CallAgent";
import { CONDITION } from "./Condition";
import { CONTINUE_STAGE } from "./Continue";
import { DISPLAY } from "./Display";
import { EXPAND } from "./Expand";
import { FOR } from "./For";
import { START } from "./Start";
import { STAGE } from "./Stage";
import { TERMINATE } from "./Terminate";
import {
  TERMINATE_STAGE,
  TERMINATE_STAGE_IMMEDIATE,
} from "./TerminateStage";
import { TOOL_CALL } from "./ToolCall";
import { WHILE } from "./While";
import { YIELD_TURN } from "./Yield";
import { ClampedNodeText } from "./ClampedNodeText";

const runtimeOperationBaseClass =
  "px-3 py-2 text-sm font-sans border rounded shadow-sm min-w-[10rem] max-w-[16rem] text-center";
const inspectorFieldLabel =
  "block text-[10px] uppercase tracking-widest text-gray-500 font-sans mt-2";
const inspectorInput =
  "w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-2 py-1.5 text-xs font-mono text-gray-800 focus:outline-none focus:border-gray-500";

interface RuntimeOperationChrome {
  title: string;
  toolbarLabel: string;
  toolbarClassName: string;
  container: string;
  ring: string;
  handle: string;
  eyebrow: string;
  defaultLabel: string;
  helpText: string;
}

const RUNTIME_OPERATION_CHROME: Record<RuntimeOperationNodeKind, RuntimeOperationChrome> = {
  read_async_job: {
    title: "Read async job",
    toolbarLabel: "+ Read async job",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-indigo-500 text-indigo-900 bg-indigo-50 hover:bg-indigo-100 rounded-full",
    container: "bg-indigo-50 border-indigo-500 text-indigo-900",
    ring: "ring-indigo-500",
    handle: "!bg-indigo-500",
    eyebrow: "text-indigo-700",
    defaultLabel:
      "Load the latest status for a previously queued async job into local variables.",
    helpText:
      "Reads the latest stored status for an Airlab async job without blocking. Point it at a variable that already contains a job id or job handle.",
  },
  await_async_job: {
    title: "Await async job",
    toolbarLabel: "+ Await async job",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-blue-600 text-blue-950 bg-blue-50 hover:bg-blue-100 rounded-full",
    container: "bg-blue-50 border-blue-600 text-blue-950",
    ring: "ring-blue-600",
    handle: "!bg-blue-600",
    eyebrow: "text-blue-800",
    defaultLabel:
      "Poll a previously queued async job until it finishes or the timeout elapses.",
    helpText:
      "Waits on an Airlab async job and republishes its latest terminal status, result, or failure into local variables.",
  },
  build_default_primary_state_schema: {
    title: "Build primary schema",
    toolbarLabel: "+ Primary schema",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-cyan-500 text-cyan-900 bg-cyan-50 hover:bg-cyan-100 rounded-full",
    container: "bg-cyan-50 border-cyan-500 text-cyan-900",
    ring: "ring-cyan-500",
    handle: "!bg-cyan-500",
    eyebrow: "text-cyan-700",
    defaultLabel:
      "Build the default primary-agent state schema for first-draft seeding before planner extras are merged.",
    helpText:
      "Deterministically inserts the required primary-agent state fields for first-draft seeding. The planner should only add extra fields or justified refinements on top.",
  },
  build_default_environment_state_schema: {
    title: "Build env schemas",
    toolbarLabel: "+ Env schemas",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-sky-500 text-sky-900 bg-sky-50 hover:bg-sky-100 rounded-full",
    container: "bg-sky-50 border-sky-500 text-sky-900",
    ring: "ring-sky-500",
    handle: "!bg-sky-500",
    eyebrow: "text-sky-700",
    defaultLabel:
      "Build the default environment-agent state schemas for any planner-requested environment agents before planner extras are merged.",
    helpText:
      "Deterministically inserts the required environment-agent state fields for any environment agents chosen by the planner during first-draft seeding.",
  },
  materialize_initial_canvas_structures: {
    title: "Materialize shapes",
    toolbarLabel: "+ Materialize shapes",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-violet-500 text-violet-900 bg-violet-50 hover:bg-violet-100 rounded-full",
    container: "bg-violet-50 border-violet-500 text-violet-900",
    ring: "ring-violet-500",
    handle: "!bg-violet-500",
    eyebrow: "text-violet-700",
    defaultLabel:
      "If the structured planner patch still contains abstract initial canvas shapes, ask a model to materialize them into concrete InitialCanvasStructure IR before patch application.",
    helpText:
      "Runs the shared shape-to-structure model call only when the planner supplied abstract initial canvas shapes without concrete InitialCanvasStructure IR.",
  },
  build_initial_canvas_shape_materialization_requests: {
    title: "Build shape requests",
    toolbarLabel: "+ Shape requests",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-fuchsia-500 text-fuchsia-900 bg-fuchsia-50 hover:bg-fuchsia-100 rounded-full",
    container: "bg-fuchsia-50 border-fuchsia-500 text-fuchsia-900",
    ring: "ring-fuchsia-500",
    handle: "!bg-fuchsia-500",
    eyebrow: "text-fuchsia-700",
    defaultLabel:
      "Build the local initial-canvas-shape materialization requests from the current structured planner patch without changing the carried planner JSON.",
    helpText:
      "Deterministically inspects the current structured planner patch, derives any abstract initial-canvas-shape requests that still need concrete InitialCanvasStructure IR, and stores those requests as local values for later nodes.",
  },
  merge_materialized_initial_canvas_structures: {
    title: "Merge structures",
    toolbarLabel: "+ Merge structures",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-pink-500 text-pink-900 bg-pink-50 hover:bg-pink-100 rounded-full",
    container: "bg-pink-50 border-pink-500 text-pink-900",
    ring: "ring-pink-500",
    handle: "!bg-pink-500",
    eyebrow: "text-pink-700",
    defaultLabel:
      "Merge the local materialized InitialCanvasStructure IR back into the carried structured planner patch.",
    helpText:
      "Deterministically normalizes the extracted materialized structures and writes them back into the carried planner JSON before later patch-application code runs.",
  },
  prepare_canvas_rule_detection_requests: {
    title: "Prep rule check",
    toolbarLabel: "+ Prep rule check",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-rose-500 text-rose-900 bg-rose-50 hover:bg-rose-100 rounded-full",
    container: "bg-rose-50 border-rose-500 text-rose-900",
    ring: "ring-rose-500",
    handle: "!bg-rose-500",
    eyebrow: "text-rose-700",
    defaultLabel:
      "Inspect the current draft canvases in code, canonicalize them, and build local model-detection requests for the canvas-rule repair pass.",
    helpText:
      "Runs deterministic preflight inspection over the draft canvases, applies safe canonicalization in code, and prepares the local detection-request bundle for the following repair prompt step.",
  },
  build_canvas_rule_repair_requests: {
    title: "Prep repair reqs",
    toolbarLabel: "+ Prep repair reqs",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-red-500 text-red-900 bg-red-50 hover:bg-red-100 rounded-full",
    container: "bg-red-50 border-red-500 text-red-900",
    ring: "ring-red-500",
    handle: "!bg-red-500",
    eyebrow: "text-red-700",
    defaultLabel:
      "Build local canvas-rule repair requests from the detected issues and the current inspected canvas summaries.",
    helpText:
      "Turns the detected canvas-rule issues into focused repair-request bundles for the next model step without mutating the draft yet.",
  },
  apply_canvas_rule_repairs: {
    title: "Apply repairs",
    toolbarLabel: "+ Apply repairs",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-orange-500 text-orange-900 bg-orange-50 hover:bg-orange-100 rounded-full",
    container: "bg-orange-50 border-orange-500 text-orange-900",
    ring: "ring-orange-500",
    handle: "!bg-orange-500",
    eyebrow: "text-orange-700",
    defaultLabel:
      "Apply the local model-proposed canvas-rule repair edits to the inspected draft canvases.",
    helpText:
      "Deterministically applies the structured repair edits generated by the model to the relevant draft canvases and records the resulting change summaries.",
  },
  prepare_canvas_rule_recheck_requests: {
    title: "Prep recheck",
    toolbarLabel: "+ Prep recheck",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-amber-600 text-amber-950 bg-amber-50 hover:bg-amber-100 rounded-full",
    container: "bg-amber-50 border-amber-600 text-amber-950",
    ring: "ring-amber-600",
    handle: "!bg-amber-600",
    eyebrow: "text-amber-800",
    defaultLabel:
      "Re-inspect the repaired draft canvases in code, canonicalize them again if needed, and build local recheck requests for the final canvas-rule pass.",
    helpText:
      "Runs a second deterministic inspection pass after any repairs so the next prompt can verify which canvas-rule issues still remain.",
  },
  finalize_canvas_rule_repair_pass: {
    title: "Finalize repair",
    toolbarLabel: "+ Finalize repair",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-rose-700 text-rose-950 bg-rose-100 hover:bg-rose-200 rounded-full",
    container: "bg-rose-100 border-rose-700 text-rose-950",
    ring: "ring-rose-700",
    handle: "!bg-rose-700",
    eyebrow: "text-rose-800",
    defaultLabel:
      "Publish the canvas-rule repair pass results, merge any repair summary into the carried planner reply, and expose whether another visible retry pass is still needed.",
    helpText:
      "Aggregates the repair-pass outcomes into the final local canvas-rule flags and optionally updates the carried planner reply when the draft actually changed.",
  },
  apply_structured_patch: {
    title: "Apply patch",
    toolbarLabel: "+ Apply patch",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-teal-500 text-teal-900 bg-teal-50 hover:bg-teal-100 rounded-full",
    container: "bg-teal-50 border-teal-500 text-teal-900",
    ring: "ring-teal-500",
    handle: "!bg-teal-500",
    eyebrow: "text-teal-700",
    defaultLabel:
      "Apply the already-normalized structured planner patch to the target draft.",
    helpText:
      "Deterministically merges the structured planner output into the current draft after any shared schema-prep and shape-materialization steps have normalized it.",
  },
  scaffold_tools: {
    title: "Scaffold tools",
    toolbarLabel: "+ Scaffold tools",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-amber-500 text-amber-900 bg-amber-50 hover:bg-amber-100 rounded-full",
    container: "bg-amber-50 border-amber-500 text-amber-900",
    ring: "ring-amber-500",
    handle: "!bg-amber-500",
    eyebrow: "text-amber-700",
    defaultLabel:
      "Synthesize requested tools, add any needed dataset hooks, and append tool canvases.",
    helpText:
      "Turns abstract missing-capability requests into concrete supported tool definitions and tool canvases.",
  },
  sync_derived_prompts: {
    title: "Sync prompts",
    toolbarLabel: "+ Sync prompts",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-slate-500 text-slate-900 bg-slate-50 hover:bg-slate-100 rounded-full",
    container: "bg-slate-50 border-slate-500 text-slate-900",
    ring: "ring-slate-500",
    handle: "!bg-slate-500",
    eyebrow: "text-slate-700",
    defaultLabel:
      "Recompile the draft's derived policy and state prompts after structural edits.",
    helpText:
      "Keeps the draft's compiled policy prompt and state-update prompt synchronized with its latest canvases and schema.",
  },
  repair_canvas_rules: {
    title: "Repair canvases",
    toolbarLabel: "+ Repair canvases",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-rose-500 text-rose-900 bg-rose-50 hover:bg-rose-100 rounded-full",
    container: "bg-rose-50 border-rose-500 text-rose-900",
    ring: "ring-rose-500",
    handle: "!bg-rose-500",
    eyebrow: "text-rose-700",
    defaultLabel:
      "Check the draft for canvas-rule violations, ask a model for the needed structured repairs, apply those repairs in code, and report whether another repair pass is still needed.",
    helpText:
      "Uses a model to propose structured canvas repairs, applies those edits in code, and keeps derived prompts synchronized after any repair.",
  },
  finalize_assistant_reply: {
    title: "Finalize reply",
    toolbarLabel: "+ Finalize reply",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-indigo-500 text-indigo-900 bg-indigo-50 hover:bg-indigo-100 rounded-full",
    container: "bg-indigo-50 border-indigo-500 text-indigo-900",
    ring: "ring-indigo-500",
    handle: "!bg-indigo-500",
    eyebrow: "text-indigo-700",
    defaultLabel:
      "Finalize the visible assistant reply so it only claims concrete updates when the workflow actually applied them.",
    helpText:
      "Deterministically turns the planner's reply intent plus the real applied changes into the final user-facing assistant message.",
  },
  raise_error: {
    title: "Raise error",
    toolbarLabel: "+ Raise error",
    toolbarClassName:
      "text-xs font-sans uppercase tracking-widest px-2.5 py-1 border border-red-700 text-red-950 bg-red-100 hover:bg-red-200 rounded-full",
    container: "bg-red-100 border-red-700 text-red-950",
    ring: "ring-red-700",
    handle: "!bg-red-700",
    eyebrow: "text-red-800",
    defaultLabel:
      "Abort policy execution with an explicit runtime error.",
    helpText:
      "Stops policy execution immediately and throws a runtime error. Use this only for impossible branches or hard consistency checks that should never silently continue.",
  },
};

function makeRuntimeOperationComponent(kind: RuntimeOperationNodeKind) {
  const chrome = RUNTIME_OPERATION_CHROME[kind];

  return function RuntimeOperationNode({
    data,
    selected,
  }: NodeProps<CanvasNode>) {
    const body =
      typeof data.label === "string" && data.label.trim()
        ? data.label.trim()
        : chrome.defaultLabel;
    const modeSuffix =
      canRuntimeOperationQueueAsAsync(kind) &&
      readCanvasAsyncExecutionMode(data) === "async"
        ? " · async"
        : "";

    return createElement(
      "div",
      {
        className: `${runtimeOperationBaseClass} ${chrome.container} ${
          selected ? `ring-2 ${chrome.ring}` : ""
        }`,
      },
      createElement(Handle, {
        type: "target",
        position: Position.Top,
        className: chrome.handle,
      }),
      createElement(
        "div",
        {
          className: `text-[10px] uppercase tracking-widest mb-0.5 ${chrome.eyebrow}`,
        },
        `${chrome.title}${modeSuffix}`
      ),
      createElement(
        ClampedNodeText,
        {
          className: "text-xs leading-snug",
          lines: 4,
          title: body,
          children: body,
        },
      ),
      createElement(Handle, {
        type: "source",
        position: Position.Bottom,
        className: chrome.handle,
      })
    );
  };
}

function makeRuntimeOperationNodeKind(kind: RuntimeOperationNodeKind): NodeKindDef {
  const chrome = RUNTIME_OPERATION_CHROME[kind];
  const isAsyncJobInspectorKind =
    kind === "read_async_job" || kind === "await_async_job";
  const canQueueAsAsync = canRuntimeOperationQueueAsAsync(kind);
  const asyncResultVariableFallback =
    getAsyncRuntimeOperationResultVariableFallback(kind);

  return {
    kind,
    toolbarLabel: chrome.toolbarLabel,
    toolbarClassName: chrome.toolbarClassName,
    component: makeRuntimeOperationComponent(kind),
    defaultLabel: chrome.defaultLabel,
    inspector: {
      showLabelField: kind === "raise_error",
      labelTitle: kind === "raise_error" ? "Error message" : undefined,
      renderExtra: isAsyncJobInspectorKind
        ? (data, update) =>
            createElement(
              "div",
              null,
              createElement(
                "label",
                { className: inspectorFieldLabel },
                "Job source variable"
              ),
              createElement("input", {
                className: inspectorInput,
                placeholder: "queued_job",
                value: readAsyncJobSourceVariable(data),
                onChange: (event) =>
                  update({ jobSourceVariable: event.currentTarget.value }),
              }),
              createElement(
                "label",
                { className: inspectorFieldLabel },
                "Output variable base"
              ),
              createElement("input", {
                className: inspectorInput,
                placeholder: "async_job",
                value: readAsyncJobResultVariable(data),
                onChange: (event) =>
                  update({ resultVariable: event.currentTarget.value }),
              }),
              kind === "await_async_job"
                ? createElement(
                    "div",
                    null,
                    createElement(
                      "label",
                      { className: inspectorFieldLabel },
                      "Timeout (ms)"
                    ),
                    createElement("input", {
                      className: inspectorInput,
                      placeholder: "20000",
                      value: readAsyncJobTimeoutMs(data)?.toString() ?? "",
                      onChange: (event) => {
                        const raw = event.currentTarget.value.trim();
                        update({
                          timeoutMs: raw
                            ? Number.parseInt(raw, 10) || undefined
                            : undefined,
                        });
                      },
                    }),
                    createElement(
                      "label",
                      { className: inspectorFieldLabel },
                      "Poll interval (ms)"
                    ),
                    createElement("input", {
                      className: inspectorInput,
                      placeholder: "750",
                      value: readAsyncJobPollIntervalMs(data)?.toString() ?? "",
                      onChange: (event) => {
                        const raw = event.currentTarget.value.trim();
                        update({
                          pollIntervalMs: raw
                            ? Number.parseInt(raw, 10) || undefined
                            : undefined,
                        });
                      },
                    })
                  )
                : null
            )
        : canQueueAsAsync
          ? (data, update) =>
              createElement(
                "div",
                null,
                createElement(
                  "label",
                  { className: inspectorFieldLabel },
                  "Node execution mode"
                ),
                createElement(
                  "select",
                  {
                    className: inspectorInput,
                    value: readCanvasAsyncExecutionMode(data),
                    onChange: (event) => {
                      const target = event.currentTarget as HTMLSelectElement;
                      update({
                        executionMode: target.value as "sync" | "async",
                      });
                    },
                  },
                  createElement("option", { value: "sync" }, "Sync"),
                  createElement("option", { value: "async" }, "Async job")
                ),
                readCanvasAsyncExecutionMode(data) === "async"
                  ? createElement(
                      "div",
                      null,
                      createElement(
                        "label",
                        { className: inspectorFieldLabel },
                        "Output variable base"
                      ),
                      createElement("input", {
                        className: inspectorInput,
                        placeholder: asyncResultVariableFallback,
                        value: readAsyncJobResultVariable(
                          data,
                          asyncResultVariableFallback
                        ),
                        onChange: (event) =>
                          update({ resultVariable: event.currentTarget.value }),
                      })
                    )
                  : null
              )
          : undefined,
    },
  };
}

export const READ_ASYNC_JOB = makeRuntimeOperationNodeKind("read_async_job");
export const AWAIT_ASYNC_JOB = makeRuntimeOperationNodeKind("await_async_job");
export const APPLY_STRUCTURED_PATCH = makeRuntimeOperationNodeKind(
  "apply_structured_patch"
);
export const BUILD_DEFAULT_PRIMARY_STATE_SCHEMA = makeRuntimeOperationNodeKind(
  "build_default_primary_state_schema"
);
export const BUILD_DEFAULT_ENVIRONMENT_STATE_SCHEMA = makeRuntimeOperationNodeKind(
  "build_default_environment_state_schema"
);
export const BUILD_INITIAL_CANVAS_SHAPE_MATERIALIZATION_REQUESTS =
  makeRuntimeOperationNodeKind(
    "build_initial_canvas_shape_materialization_requests"
  );
export const MATERIALIZE_INITIAL_CANVAS_STRUCTURES = makeRuntimeOperationNodeKind(
  "materialize_initial_canvas_structures"
);
export const MERGE_MATERIALIZED_INITIAL_CANVAS_STRUCTURES =
  makeRuntimeOperationNodeKind("merge_materialized_initial_canvas_structures");
export const PREPARE_CANVAS_RULE_DETECTION_REQUESTS =
  makeRuntimeOperationNodeKind("prepare_canvas_rule_detection_requests");
export const BUILD_CANVAS_RULE_REPAIR_REQUESTS = makeRuntimeOperationNodeKind(
  "build_canvas_rule_repair_requests"
);
export const APPLY_CANVAS_RULE_REPAIRS = makeRuntimeOperationNodeKind(
  "apply_canvas_rule_repairs"
);
export const PREPARE_CANVAS_RULE_RECHECK_REQUESTS =
  makeRuntimeOperationNodeKind("prepare_canvas_rule_recheck_requests");
export const FINALIZE_CANVAS_RULE_REPAIR_PASS = makeRuntimeOperationNodeKind(
  "finalize_canvas_rule_repair_pass"
);
export const SCAFFOLD_TOOLS = makeRuntimeOperationNodeKind("scaffold_tools");
export const SYNC_DERIVED_PROMPTS = makeRuntimeOperationNodeKind(
  "sync_derived_prompts"
);
export const REPAIR_CANVAS_RULES = makeRuntimeOperationNodeKind(
  "repair_canvas_rules"
);
export const FINALIZE_ASSISTANT_REPLY = makeRuntimeOperationNodeKind(
  "finalize_assistant_reply"
);
export const RAISE_ERROR = makeRuntimeOperationNodeKind("raise_error");

function hideFromToolbar(kind: NodeKindDef): NodeKindDef {
  return {
    ...kind,
    hideFromToolbar: true,
  };
}

export {
  CODE,
  CALL_AGENT,
  CONDITION,
  CONTINUE_STAGE,
  DISPLAY,
  EXPAND,
  FOR,
  PROMPT,
  START,
  STAGE,
  TERMINATE,
  TERMINATE_STAGE,
  TERMINATE_STAGE_IMMEDIATE,
  TOOL_CALL,
  WHILE,
};

export const BASE_CANVAS_NODE_KINDS: NodeKindDef[] = [
  START,
  CONDITION,
  FOR,
  WHILE,
  PROMPT,
  CODE,
  TOOL_CALL,
  CALL_AGENT,
  DISPLAY,
  EXPAND,
  YIELD_TURN,
  CONTINUE_STAGE,
  TERMINATE_STAGE,
  TERMINATE_STAGE_IMMEDIATE,
  TERMINATE,
];

export const STATE_CANVAS_NODE_KINDS: NodeKindDef[] = BASE_CANVAS_NODE_KINDS;

export const WORKFLOW_CANVAS_NODE_KINDS: NodeKindDef[] = [
  START,
  STAGE,
  CONDITION,
  FOR,
  WHILE,
  PROMPT,
  CODE,
  TOOL_CALL,
  CALL_AGENT,
  DISPLAY,
  EXPAND,
  YIELD_TURN,
  CONTINUE_STAGE,
  TERMINATE_STAGE,
  TERMINATE_STAGE_IMMEDIATE,
  TERMINATE,
];

export const DEFAULT_POLICY_NODE_KINDS: NodeKindDef[] = [
  // Toolbar matches the state canvas core set (Start, Control structure, Prompt,
  // Code, Tool call, Call agent, Display, Expand) plus Terminate. Stage/async/
  // runtime-only kinds stay registered so existing graphs still render, but
  // remain hidden from the add-node palette.
  START,
  CONDITION,
  hideFromToolbar(FOR),
  hideFromToolbar(WHILE),
  PROMPT,
  CODE,
  TOOL_CALL,
  CALL_AGENT,
  DISPLAY,
  EXPAND,
  hideFromToolbar(YIELD_TURN),
  hideFromToolbar(CONTINUE_STAGE),
  hideFromToolbar(TERMINATE_STAGE),
  hideFromToolbar(TERMINATE_STAGE_IMMEDIATE),
  TERMINATE,
  hideFromToolbar(READ_ASYNC_JOB),
  hideFromToolbar(AWAIT_ASYNC_JOB),
  hideFromToolbar(BUILD_DEFAULT_PRIMARY_STATE_SCHEMA),
  hideFromToolbar(BUILD_DEFAULT_ENVIRONMENT_STATE_SCHEMA),
  hideFromToolbar(BUILD_INITIAL_CANVAS_SHAPE_MATERIALIZATION_REQUESTS),
  hideFromToolbar(MATERIALIZE_INITIAL_CANVAS_STRUCTURES),
  hideFromToolbar(MERGE_MATERIALIZED_INITIAL_CANVAS_STRUCTURES),
  hideFromToolbar(PREPARE_CANVAS_RULE_DETECTION_REQUESTS),
  hideFromToolbar(BUILD_CANVAS_RULE_REPAIR_REQUESTS),
  hideFromToolbar(APPLY_CANVAS_RULE_REPAIRS),
  hideFromToolbar(PREPARE_CANVAS_RULE_RECHECK_REQUESTS),
  hideFromToolbar(FINALIZE_CANVAS_RULE_REPAIR_PASS),
  hideFromToolbar(APPLY_STRUCTURED_PATCH),
  hideFromToolbar(RAISE_ERROR),
  hideFromToolbar(SCAFFOLD_TOOLS),
  hideFromToolbar(SYNC_DERIVED_PROMPTS),
  hideFromToolbar(REPAIR_CANVAS_RULES),
  hideFromToolbar(FINALIZE_ASSISTANT_REPLY),
];

export const DAEMON_POLICY_NODE_KINDS: NodeKindDef[] = [
  ...BASE_CANVAS_NODE_KINDS,
  READ_ASYNC_JOB,
  AWAIT_ASYNC_JOB,
  BUILD_DEFAULT_PRIMARY_STATE_SCHEMA,
  BUILD_DEFAULT_ENVIRONMENT_STATE_SCHEMA,
  BUILD_INITIAL_CANVAS_SHAPE_MATERIALIZATION_REQUESTS,
  hideFromToolbar(MATERIALIZE_INITIAL_CANVAS_STRUCTURES),
  MERGE_MATERIALIZED_INITIAL_CANVAS_STRUCTURES,
  PREPARE_CANVAS_RULE_DETECTION_REQUESTS,
  BUILD_CANVAS_RULE_REPAIR_REQUESTS,
  APPLY_CANVAS_RULE_REPAIRS,
  PREPARE_CANVAS_RULE_RECHECK_REQUESTS,
  FINALIZE_CANVAS_RULE_REPAIR_PASS,
  APPLY_STRUCTURED_PATCH,
  RAISE_ERROR,
  SCAFFOLD_TOOLS,
  SYNC_DERIVED_PROMPTS,
  hideFromToolbar(REPAIR_CANVAS_RULES),
  FINALIZE_ASSISTANT_REPLY,
];
