import {
  evaluateStateCondition,
  executePolicyCodePlan,
  renderPolicyActionMessage,
  type CanvasExecutionSourceNodeRef,
  type PolicyCodeAction,
  type PolicyExecutionGraph,
  type PolicyExecutionGraphStep,
  type PolicyRuntimeOperationExecutionStep,
  type PolicyStageHandoff,
  type PromptValueSnapshot,
  type RuntimeStateField,
  type StateCodeRuntimeContext,
  type StatePromptExtractionPlan,
  type StateSnapshot,
} from "@airlab/canvas-planner/canvas-hybrid-runtime";
import {
  CANVAS_CODE_NODE_ERROR_PROMPT_VALUE_NAME,
  CANVAS_TOOL_CALL_ERROR_PROMPT_VALUE_NAME,
  CARRIED_OUTPUT_PROMPT_VALUE_NAME,
} from "@airlab/canvas-core/lib/canvas-flow-values";
import { executeTypeScriptCodeStep } from "@airlab/canvas-core/lib/canvas-code-script-runtime";

const POLICY_EXECUTION_GRAPH_DEFAULT_MAX_STEPS = 8;
const POLICY_EXECUTION_GRAPH_HARD_MAX_STEPS = 64;
const EXECUTION_GRAPH_ERROR_MESSAGE_MAX_LENGTH = 500;

export interface PolicyExecutionGraphRuntimeArgs {
  updatedState: StateSnapshot;
  stateSchema: RuntimeStateField[];
  graph: PolicyExecutionGraph;
  initialPromptValues?: PromptValueSnapshot;
  runtimeContext?: StateCodeRuntimeContext;
  onStep?: (step: PolicyExecutionGraphTraceStep) => void;
  runFullPromptDecision: (
    currentState: StateSnapshot,
    existingPromptValues: PromptValueSnapshot
  ) => Promise<string>;
  runPromptSubtreeDecision: (
    currentState: StateSnapshot,
    subtreePrompt: string,
    currentOutput: string,
    existingPromptValues: PromptValueSnapshot
  ) => Promise<string>;
  runPromptSubtreeDecisionWithExtraction?: (
    currentState: StateSnapshot,
    subtreePrompt: string,
    promptPlan: StatePromptExtractionPlan | undefined,
    existingPromptValues: PromptValueSnapshot,
    currentOutput: string
  ) => Promise<{ output: string; promptValues: PromptValueSnapshot | null }>;
  runPromptTransform: (
    currentState: StateSnapshot,
    incomingOutput: string,
    instruction: string,
    existingPromptValues: PromptValueSnapshot
  ) => Promise<string>;
  runPromptExtraction: (
    currentState: StateSnapshot,
    promptPlan: StatePromptExtractionPlan | undefined,
    existingPromptValues: PromptValueSnapshot
  ) => Promise<PromptValueSnapshot | null>;
  runRuntimeOperation?: (
    step: PolicyRuntimeOperationExecutionStep,
    incomingOutput: string,
    promptValues: PromptValueSnapshot,
    currentState: StateSnapshot
  ) => Promise<
    | void
    | {
        output?: string | null;
        promptValues?: PromptValueSnapshot | null;
      }
  >;
  runDirectTool?: (
    toolName: string,
    resultVariable?: string,
    inputContributions?: unknown[]
  ) => Promise<PromptValueSnapshot>;
  shouldPropagateToolError?: (error: unknown) => boolean;
  runExpandPrompt?: (
    currentState: StateSnapshot,
    label: string,
    currentOutput: string,
    existingPromptValues: PromptValueSnapshot
  ) => Promise<string>;
}

export interface PolicyExecutionGraphTraceStep {
  stepId: string;
  stepType: PolicyExecutionGraphStep["type"];
  sourceNodeRefs?: CanvasExecutionSourceNodeRef[];
  toolName?: string;
  skipped?: boolean;
  interactionTerminated?: boolean;
  stageHandoff?: PolicyStageHandoff | null;
}

export interface PolicyExecutionGraphResult {
  output: string;
  visibleOutput: string;
  nextState: StateSnapshot;
  interactionTerminated: boolean;
  stageHandoff?: PolicyStageHandoff | null;
  handledToolError?: string;
}

function normalizeGraphStepId(stepId: string | null | undefined): string | null {
  const normalized = typeof stepId === "string" ? stepId.trim() : "";
  return normalized.length > 0 ? normalized : null;
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

function hasPromptExtractionFields(
  promptPlan: StatePromptExtractionPlan | undefined
): boolean {
  return Array.isArray(promptPlan?.fields) && promptPlan.fields.length > 0;
}

function resolvePolicyExecutionGraphMaxSteps(graph: PolicyExecutionGraph): number {
  const requested =
    typeof graph.max_steps === "number" && Number.isFinite(graph.max_steps)
      ? Math.trunc(graph.max_steps)
      : POLICY_EXECUTION_GRAPH_DEFAULT_MAX_STEPS;

  return Math.min(
    Math.max(requested, 1),
    POLICY_EXECUTION_GRAPH_HARD_MAX_STEPS
  );
}

function normalizePolicyOutputValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
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
    normalizePolicyOutputValue(value)
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
    return normalizePolicyOutputValue(promptValues[inputVariable]);
  }

  if (Object.prototype.hasOwnProperty.call(currentState, inputVariable)) {
    return normalizePolicyOutputValue(currentState[inputVariable]);
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

function resolveCurrentPolicyOutput(promptValues: PromptValueSnapshot): string {
  return normalizePolicyOutputValue(
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

  const inputVariable =
    typeof action.input_variable === "string" ? action.input_variable.trim() : "";
  const displayType = action.display_type === "video" ? "video" : "text";

  if (displayType === "video" && typeof action.video_url === "string") {
    const videoUrl = action.video_url.trim();
    if (videoUrl) {
      return videoUrl;
    }
  }

  const key = inputVariable || CARRIED_OUTPUT_PROMPT_VALUE_NAME;
  if (key in promptValues) {
    return normalizePolicyOutputValue(promptValues[key]);
  }
  if (key in currentState) {
    return normalizePolicyOutputValue(currentState[key]);
  }
  if (typeof action.message === "string" && action.message.trim()) {
    return renderPolicyActionMessage(action.message, currentState, promptValues);
  }
  return "";
}

function formatExecutionGraphErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : "Code script execution failed.";
  const trimmed = raw.trim() || "Code script execution failed.";
  return trimmed.length > EXECUTION_GRAPH_ERROR_MESSAGE_MAX_LENGTH
    ? `${trimmed.slice(0, EXECUTION_GRAPH_ERROR_MESSAGE_MAX_LENGTH - 1)}...`
    : trimmed;
}

function resolveSkippedPolicyExecutionGraphStepTarget(
  step: PolicyExecutionGraphStep
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

async function resolvePolicyActionOutput(
  args: PolicyExecutionGraphRuntimeArgs,
  currentState: StateSnapshot,
  action: PolicyCodeAction,
  promptValues: PromptValueSnapshot = {}
): Promise<string | null> {
  if (action.kind === "use_prompt") {
    return null;
  }

  if (action.kind === "expand") {
    if (!args.runExpandPrompt) {
      throw new Error(
        `Policy execution graph requested expand("${action.label}") but no expand handler was provided.`
      );
    }
    return args.runExpandPrompt(
      currentState,
      action.label,
      resolveCurrentPolicyOutput(promptValues),
      promptValues
    );
  }

  if (action.kind === "display") {
    return resolvePolicyDisplayOutput(action, currentState, promptValues);
  }

  throw new Error(`Unsupported policy code action: ${JSON.stringify(action)}`);
}

export async function runPolicyExecutionGraphWithHandlers(
  args: PolicyExecutionGraphRuntimeArgs
): Promise<PolicyExecutionGraphResult> {
  const steps = Array.isArray(args.graph.steps) ? args.graph.steps : [];
  if (steps.length === 0) {
    const output = await args.runFullPromptDecision(
      args.updatedState,
      args.initialPromptValues ?? {}
    );
    return {
      output,
      visibleOutput: "",
      nextState: args.updatedState,
      interactionTerminated: false,
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

  const entryStepId =
    normalizeGraphStepId(args.graph.entry_step_id) ??
    normalizeGraphStepId(steps[0]?.id);
  if (!entryStepId || !stepById.has(entryStepId)) {
    throw new Error("Policy execution graph entry step is missing.");
  }

  let currentStepId: string | null = entryStepId;
  let currentState = args.updatedState;
  let promptValues: PromptValueSnapshot = {
    ...(args.initialPromptValues ?? {}),
  };
  const displayedOutputs: string[] = [];
  const appendDisplayedOutput = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      displayedOutputs.push(trimmed);
    }
  };
  const resolveVisibleOutput = () => displayedOutputs.join("\n\n");
  let handledToolError: string | null = null;
  const withHandledToolError = (
    result: Omit<PolicyExecutionGraphResult, "handledToolError">
  ): PolicyExecutionGraphResult =>
    handledToolError ? { ...result, handledToolError } : result;
  let stepsRun = 0;
  const maxSteps = resolvePolicyExecutionGraphMaxSteps(args.graph);

  while (currentStepId) {
    if (stepsRun >= maxSteps) {
      throw new Error(
        `Policy execution graph exceeded max_steps (${maxSteps}).`
      );
    }

    const step = stepById.get(currentStepId);
    if (!step) {
      throw new Error(
        `Policy execution graph step "${currentStepId}" was not found.`
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
      stageHandoff:
        step.type === "end" ? step.stage_handoff ?? null : undefined,
    });

    if (skippedByWhen) {
      currentStepId = resolveSkippedPolicyExecutionGraphStepTarget(step);
      continue;
    }

    if (step.type === "end") {
      const interactionTerminated = Boolean(step.terminates_interaction);
      const stageHandoff = step.stage_handoff ?? null;
      const explicitMessage =
        "message" in step && typeof step.message === "string"
          ? step.message.trim()
          : "";

      if (explicitMessage) {
          return withHandledToolError({
            output: renderPolicyActionMessage(explicitMessage, currentState, promptValues),
            visibleOutput: resolveVisibleOutput(),
            nextState: currentState,
            interactionTerminated,
            stageHandoff,
          });
        }
      return withHandledToolError({
        output: resolveCurrentPolicyOutput(promptValues) || resolveVisibleOutput(),
        visibleOutput: resolveVisibleOutput(),
        nextState: currentState,
        interactionTerminated,
        stageHandoff,
      });
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
            promptValues = setPromptValue(
              promptValues,
              step.output_variable.trim(),
              outputObject
            );
          }
        }
        const action = codeResult.action;

        if (!action) {
          currentStepId = normalizeGraphStepId(
            (codeResult.matchedAnyRule ? step.on_match_step_id : step.on_no_match_step_id) ??
              step.next_step_id
          );
          continue;
        }

        if (action.kind === "use_prompt") {
          currentStepId = normalizeGraphStepId(
            step.on_use_prompt_step_id ?? step.next_step_id
          );
          continue;
        }

        const continuationStepId = normalizeGraphStepId(
          step.on_match_step_id ?? step.next_step_id
        );
        const preparedOutput: string =
          (await resolvePolicyActionOutput(args, currentState, action, promptValues)) ?? "";
        if (action.kind === "display") {
          appendDisplayedOutput(preparedOutput);
        }

        if (continuationStepId) {
          if (action.kind !== "display") {
            promptValues = setCarriedOutput(promptValues, preparedOutput);
            if (step.output_variable?.trim()) {
              promptValues = setPromptValue(
                promptValues,
                step.output_variable.trim(),
                preparedOutput
              );
            }
          }
          currentStepId = continuationStepId;
          continue;
        }

        return withHandledToolError({
          output:
            action.kind === "display"
              ? resolveVisibleOutput() ||
                resolveCurrentPolicyOutput(promptValues) ||
                preparedOutput
              : preparedOutput,
          visibleOutput: resolveVisibleOutput(),
          nextState: currentState,
          interactionTerminated: false,
        });
      } catch (error) {
        const errorStepId = normalizeGraphStepId(step.on_error_step_id);
        if (errorStepId) {
          promptValues = setPromptValue(
            promptValues,
            CANVAS_CODE_NODE_ERROR_PROMPT_VALUE_NAME,
            formatExecutionGraphErrorMessage(error)
          );
          currentStepId = errorStepId;
          continue;
        }
        throw error;
      }
    }

    if (step.type === "prompt_extract") {
      const extractedPromptValues = await args.runPromptExtraction(
        currentState,
        step.prompt_extraction_plan,
        promptValues
      );

      if (extractedPromptValues) {
        promptValues = mergePromptValueUpdates(promptValues, extractedPromptValues);
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
          `Policy execution graph requested tool_call("${step.tool_name}") but no tool handler was provided.`
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
        promptValues = mergePromptValueUpdates(promptValues, toolPromptValues);
        promptValues = setCarriedOutput(
          promptValues,
          toolPromptValues[toolResultKey]
        );
        if (shouldYieldAfterAsyncTool(promptValues, toolResultKey)) {
          const visibleOutput = resolveVisibleOutput();
          return withHandledToolError({
            output: renderAsyncYieldOutput(
              promptValues,
              toolResultKey,
              visibleOutput
            ),
            visibleOutput,
            nextState: currentState,
            interactionTerminated: false,
          });
        }
        currentStepId = normalizeGraphStepId(step.next_step_id);
        continue;
      } catch (error) {
        if (args.shouldPropagateToolError?.(error)) {
          throw error;
        }
        const errorStepId = normalizeGraphStepId(step.on_error_step_id);
        if (errorStepId) {
          const formattedError = formatExecutionGraphErrorMessage(error);
          handledToolError = formattedError;
          promptValues = setPromptValue(
            promptValues,
            CANVAS_TOOL_CALL_ERROR_PROMPT_VALUE_NAME,
            formattedError
          );
          currentStepId = errorStepId;
          continue;
        }
        throw error;
      }
    }

    if (step.type === "prompt_subtree_decision") {
      const subtreeResult = hasPromptExtractionFields(step.prompt_extraction_plan)
        ? await (() => {
            if (!args.runPromptSubtreeDecisionWithExtraction) {
              throw new Error(
                "Policy execution graph requested prompt_subtree_decision extraction but no extraction-capable subtree handler was provided."
              );
            }
            return args.runPromptSubtreeDecisionWithExtraction(
              currentState,
              step.subtree_prompt,
              step.prompt_extraction_plan,
              promptValues,
              resolveCurrentPolicyOutput(promptValues)
            );
          })()
        : {
          output: await args.runPromptSubtreeDecision(
            currentState,
            step.subtree_prompt,
            resolveCurrentPolicyOutput(promptValues),
            promptValues
          ),
          promptValues: null,
        };
      const subtreeOutput = subtreeResult.output;
      if (subtreeResult.promptValues) {
        promptValues = mergePromptValueUpdates(
          promptValues,
          subtreeResult.promptValues
        );
      }
      const continuationStepId = normalizeGraphStepId(step.next_step_id);

      if (continuationStepId) {
        promptValues = setCarriedOutput(promptValues, subtreeOutput);
        if (step.output_variable?.trim()) {
          promptValues = setPromptValue(
            promptValues,
            step.output_variable.trim(),
            subtreeOutput
          );
        }
        currentStepId = continuationStepId;
        continue;
      }

      return withHandledToolError({
        output: subtreeOutput,
        visibleOutput: resolveVisibleOutput(),
        nextState: currentState,
        interactionTerminated: false,
      });
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
      const continuationStepId = normalizeGraphStepId(step.next_step_id);

      if (continuationStepId) {
        promptValues = setPromptTransformOutput(
          promptValues,
          outputVariable,
          transformedOutput
        );
        currentStepId = continuationStepId;
        continue;
      }

      return withHandledToolError({
        output: transformedOutput,
        visibleOutput: resolveVisibleOutput(),
        nextState: currentState,
        interactionTerminated: false,
      });
    }

    if (step.type === "runtime_operation") {
      if (!args.runRuntimeOperation) {
        throw new Error(
          `Policy execution graph requested runtime_operation("${step.operation}") but no runtime operation handler was provided.`
        );
      }

      const currentOutput = resolveCurrentPolicyOutput(promptValues);
      const operationResult = await args.runRuntimeOperation(
        step,
        currentOutput,
        promptValues,
        currentState
      );
      if (operationResult?.promptValues) {
        promptValues = mergePromptValueUpdates(
          promptValues,
          operationResult.promptValues
        );
      }
      promptValues = setCarriedOutput(
        promptValues,
        operationResult && "output" in operationResult
          ? operationResult.output ?? currentOutput
          : currentOutput
      );
      currentStepId = normalizeGraphStepId(step.next_step_id);
      continue;
    }

    const promptDecisionOutput = await args.runFullPromptDecision(
      currentState,
      promptValues
    );
    const continuationStepId = normalizeGraphStepId(step.next_step_id);

    if (continuationStepId) {
      promptValues = setCarriedOutput(promptValues, promptDecisionOutput);
      currentStepId = continuationStepId;
      continue;
    }

    return withHandledToolError({
      output: promptDecisionOutput,
      visibleOutput: resolveVisibleOutput(),
      nextState: currentState,
      interactionTerminated: false,
    });
  }

  return withHandledToolError({
    output: resolveCurrentPolicyOutput(promptValues) || resolveVisibleOutput(),
    visibleOutput: resolveVisibleOutput(),
    nextState: currentState,
    interactionTerminated: false,
  });
}
