import {
  evaluateStateCondition,
  executeStateCodePlan,
  renderPolicyActionMessage,
  type CanvasExecutionSourceNodeRef,
  type PromptValueSnapshot,
  type RuntimeStateField,
  type StateCodeRuntimeContext,
  type StateExecutionGraph,
  type StateExecutionGraphStep,
  type StatePromptExtractionPlan,
  type StateSnapshot,
} from "@airlab/canvas-planner/canvas-hybrid-runtime";
import {
  CANVAS_CODE_NODE_ERROR_PROMPT_VALUE_NAME,
  CANVAS_TOOL_CALL_ERROR_PROMPT_VALUE_NAME,
  CARRIED_OUTPUT_PROMPT_VALUE_NAME,
} from "@airlab/canvas-core/lib/canvas-flow-values";
import { executeTypeScriptCodeStep } from "@airlab/canvas-core/lib/canvas-code-script-runtime";

const STATE_EXECUTION_GRAPH_DEFAULT_MAX_STEPS = 8;
const STATE_EXECUTION_GRAPH_HARD_MAX_STEPS = 64;
const EXECUTION_GRAPH_ERROR_MESSAGE_MAX_LENGTH = 500;

export interface StateExecutionGraphRuntimeArgs {
  knownState: StateSnapshot;
  stateSchema: RuntimeStateField[];
  graph: StateExecutionGraph;
  initialPromptValues?: PromptValueSnapshot;
  runtimeContext?: StateCodeRuntimeContext;
  onStep?: (step: StateExecutionGraphTraceStep) => void;
  runFullPromptUpdate: (
    currentState: StateSnapshot,
    existingPromptValues: PromptValueSnapshot
  ) => Promise<StateSnapshot>;
  runPromptSubtreeUpdate: (
    currentState: StateSnapshot,
    subtreePrompt: string,
    existingPromptValues: PromptValueSnapshot
  ) => Promise<StateSnapshot>;
  runPromptTransform: (
    currentState: StateSnapshot,
    incomingOutput: string,
    instruction: string,
    existingPromptValues: PromptValueSnapshot
  ) => Promise<string>;
  runPromptExtraction?: (
    currentState: StateSnapshot,
    promptPlan: StatePromptExtractionPlan | undefined,
    existingPromptValues: PromptValueSnapshot
  ) => Promise<PromptValueSnapshot | null>;
  runDirectTool?: (
    toolName: string,
    resultVariable?: string,
    inputContributions?: unknown[]
  ) => Promise<PromptValueSnapshot>;
  shouldPropagateToolError?: (error: unknown) => boolean;
}

export interface StateExecutionGraphTraceStep {
  stepId: string;
  stepType: StateExecutionGraphStep["type"];
  sourceNodeRefs?: CanvasExecutionSourceNodeRef[];
  toolName?: string;
  skipped?: boolean;
  interactionTerminated?: boolean;
}

export interface StateExecutionGraphResult {
  nextState: StateSnapshot;
  interactionTerminated: boolean;
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

function resolveSkippedStateExecutionGraphStepTarget(
  step: StateExecutionGraphStep
): string | null {
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

function preserveStateFields(
  nextState: StateSnapshot,
  previousState: StateSnapshot,
  fieldNames: string[] | null | undefined
): StateSnapshot {
  const names = Array.isArray(fieldNames)
    ? fieldNames.map((name) => name.trim()).filter(Boolean)
    : [];
  if (names.length === 0) {
    return nextState;
  }

  const preserved = { ...nextState };
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(previousState, name)) {
      preserved[name] = previousState[name] ?? "";
    }
  }
  return preserved;
}

function hasPromptValueData(promptValues: PromptValueSnapshot): boolean {
  return Object.values(promptValues).some((value) => {
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

function formatExecutionGraphErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : "Code script execution failed.";
  const trimmed = raw.trim() || "Code script execution failed.";
  return trimmed.length > EXECUTION_GRAPH_ERROR_MESSAGE_MAX_LENGTH
    ? `${trimmed.slice(0, EXECUTION_GRAPH_ERROR_MESSAGE_MAX_LENGTH - 1)}...`
    : trimmed;
}

function normalizeStateOutputValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
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
    normalizeStateOutputValue(value)
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
    return normalizeStateOutputValue(promptValues[inputVariable]);
  }

  if (Object.prototype.hasOwnProperty.call(currentState, inputVariable)) {
    return normalizeStateOutputValue(currentState[inputVariable]);
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

function getToolResultVariableName(
  toolName: string,
  resultVariable: string | undefined
): string {
  const normalized = resultVariable?.trim();
  return normalized && normalized.length > 0 ? normalized : toolName;
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
    if (value === undefined) {
      continue;
    }
    output[name] = value;
  }

  return Object.keys(output).length > 0 ? output : {};
}

function buildToolInputContributions(
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

export async function runStateExecutionGraphWithHandlers(
  args: StateExecutionGraphRuntimeArgs
): Promise<StateExecutionGraphResult> {
  const steps = Array.isArray(args.graph.steps) ? args.graph.steps : [];
  if (steps.length === 0) {
    return {
      nextState: await args.runFullPromptUpdate(
        args.knownState,
        args.initialPromptValues ?? {}
      ),
      interactionTerminated: false,
    };
  }

  const stepById = new Map(
    steps
      .map((step) => {
        const id = normalizeGraphStepId(step.id);
        return id ? [id, step] : null;
      })
      .filter((entry): entry is [string, StateExecutionGraphStep] => entry !== null)
  );

  const entryStepId =
    normalizeGraphStepId(args.graph.entry_step_id) ??
    normalizeGraphStepId(steps[0]?.id);
  if (!entryStepId || !stepById.has(entryStepId)) {
    throw new Error("State execution graph entry step is missing.");
  }

  let currentStepId: string | null = entryStepId;
  let currentState = args.knownState;
  let promptValues: PromptValueSnapshot = {
    ...(args.initialPromptValues ?? {}),
  };
  let stepsRun = 0;
  let interactionTerminated = false;
  const maxSteps = resolveStateExecutionGraphMaxSteps(args.graph);

  while (currentStepId) {
    if (stepsRun >= maxSteps) {
      throw new Error(
        `State execution graph exceeded max_steps (${maxSteps}).`
      );
    }

    const step = stepById.get(currentStepId);
    if (!step) {
      throw new Error(
        `State execution graph step "${currentStepId}" was not found.`
      );
    }

    stepsRun += 1;

    const skippedByWhen = step.when
      ? !evaluateStateCondition(
        step.when,
        currentState,
        args.stateSchema,
        promptValues
      )
      : false;
    args.onStep?.({
      stepId: step.id,
      stepType: step.type,
      sourceNodeRefs: step.sourceNodeRefs,
      toolName: step.type === "tool_call" ? step.tool_name : undefined,
      skipped: skippedByWhen,
      interactionTerminated:
        step.type === "end" ? Boolean(step.terminates_interaction) : undefined,
    });

    if (skippedByWhen) {
      currentStepId = resolveSkippedStateExecutionGraphStepTarget(step);
      continue;
    }

    if (step.type === "end") {
      interactionTerminated = Boolean(step.terminates_interaction);
      const explicitMessage =
        "message" in step && typeof step.message === "string"
          ? step.message.trim()
          : "";
      if (explicitMessage && !interactionTerminated) {
        throw new Error(
          renderPolicyActionMessage(explicitMessage, currentState, promptValues)
        );
      }
      break;
    }

    if (step.type === "code") {
      try {
        if (step.language === "typescript" && step.script_source?.trim()) {
          const scriptResult = executeTypeScriptCodeStep({
            source: step.script_source,
            currentState,
            stateSchema: args.stateSchema,
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
              promptValues = setCarriedOutput(
                setPromptValue(promptValues, step.output_variable.trim(), outputObject),
                outputObject
              );
            }
          }
          currentStepId = normalizeGraphStepId(
            step.on_match_step_id ?? step.next_step_id
          );
          continue;
        }

        const codeResult = executeStateCodePlan(
          { rules: step.rules },
          currentState,
          args.stateSchema,
          promptValues,
          args.runtimeContext
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
      } catch (error) {
        const errorStepId = normalizeGraphStepId(step.on_error_step_id);
        if (errorStepId) {
          promptValues = {
            ...promptValues,
            [CANVAS_CODE_NODE_ERROR_PROMPT_VALUE_NAME]:
              formatExecutionGraphErrorMessage(error),
          };
          currentStepId = errorStepId;
          continue;
        }
        throw error;
      }
      continue;
    }

    if (step.type === "prompt_extract") {
      if (!args.runPromptExtraction) {
        throw new Error(
          "State execution graph requested prompt_extract but no extraction handler was provided."
        );
      }

      const extractedPromptValues = await args.runPromptExtraction(
        currentState,
        step.prompt_extraction_plan,
        promptValues
      );

      if (extractedPromptValues) {
        promptValues = { ...promptValues, ...extractedPromptValues };
      }

      const extractedAnyValue = extractedPromptValues
        ? hasPromptValueData(extractedPromptValues)
        : false;
      currentStepId = extractedAnyValue
        ? normalizeGraphStepId(step.on_value_step_id ?? step.next_step_id)
        : normalizeGraphStepId(step.on_empty_step_id ?? step.next_step_id);
      continue;
    }

    if (step.type === "tool_call") {
      if (!args.runDirectTool) {
        throw new Error(
          `State execution graph requested tool_call("${step.tool_name}") but no direct tool handler was provided.`
        );
      }

      try {
        const inputContributions = buildToolInputContributions(
          promptValues,
          step.input_object_variables,
          step.input_prompt_value_names
        );
        const toolPromptValues = await args.runDirectTool(
          step.tool_name,
          step.result_variable,
          inputContributions
        );
        const toolResultKey = getToolResultVariableName(
          step.tool_name,
          step.result_variable
        );
        promptValues = setCarriedOutput(
          {
            ...promptValues,
            ...toolPromptValues,
          },
          toolPromptValues[toolResultKey]
        );
        currentStepId = normalizeGraphStepId(step.next_step_id);
        continue;
      } catch (error) {
        if (args.shouldPropagateToolError?.(error)) {
          throw error;
        }
        const errorStepId = normalizeGraphStepId(step.on_error_step_id);
        if (errorStepId) {
          promptValues = {
            ...promptValues,
            [CANVAS_TOOL_CALL_ERROR_PROMPT_VALUE_NAME]:
              formatExecutionGraphErrorMessage(error),
          };
          currentStepId = errorStepId;
          continue;
        }
        throw error;
      }
    }

    if (step.type === "prompt_subtree_update") {
      const previousState = currentState;
      currentState = preserveStateFields(
        await args.runPromptSubtreeUpdate(
          currentState,
          step.subtree_prompt,
          promptValues
        ),
        previousState,
        step.preserve_field_names
      );
      currentStepId = normalizeGraphStepId(step.next_step_id);
      continue;
    }

    if (step.type === "prompt_transform") {
      const inputVariable = getPromptTransformInputVariable(step);
      const outputVariable = getPromptTransformOutputVariable(step);
      const transformedOutput = await args.runPromptTransform(
        currentState,
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

    currentState = await args.runFullPromptUpdate(currentState, promptValues);
    currentStepId = normalizeGraphStepId(step.next_step_id);
  }

  return {
    nextState: currentState,
    interactionTerminated,
  };
}
