import type {
  PolicyRuntimeOperationExecutionStep,
  PromptValueSnapshot,
} from "@airlab/canvas-planner/canvas-hybrid-runtime";
import {
  type AsyncRuntimeOperationCompletionPayload,
  awaitAsyncRuntimeJobCompletion,
  buildAsyncRuntimeJobPromptValueUpdates,
  extractAsyncRuntimeJobId,
  getAsyncRuntimeJob,
  isAsyncRuntimeOperationCompletionPayload,
  type AsyncRuntimeJobResult,
} from "./async-job-runtime";

function buildFailedAsyncJobResult(
  jobId: string,
  error: string,
  summary: string
): AsyncRuntimeJobResult {
  return {
    kind: "airlab_async_job",
    status: "failed",
    jobId,
    jobKind: "runtime_operation",
    error,
    summary,
  };
}

function shouldMirrorAsyncJobUpdatesToSourceVariable(
  sourceVariable: string,
  resultBase: string,
  sourceValue: unknown
): boolean {
  if (!sourceVariable || sourceVariable === resultBase) {
    return false;
  }

  return !!sourceValue && typeof sourceValue === "object" && !Array.isArray(sourceValue);
}

function getAsyncJobMirroredOutputBases(args: {
  sourceVariable: string;
  resultBase: string;
  sourceValue: unknown;
}): string[] {
  const bases = new Set<string>();
  const sourceVariable = args.sourceVariable.trim();
  const resultBase = args.resultBase.trim();

  if (
    shouldMirrorAsyncJobUpdatesToSourceVariable(
      sourceVariable,
      resultBase,
      args.sourceValue
    )
  ) {
    bases.add(sourceVariable);
  }

  if (sourceVariable.endsWith("_job_id")) {
    const derivedBase = sourceVariable.slice(0, -"_job_id".length).trim();
    if (derivedBase && derivedBase !== resultBase) {
      bases.add(derivedBase);
    }
  }

  return Array.from(bases);
}

function renderAsyncJobResultOutput(result: AsyncRuntimeJobResult): string {
  if (result.status === "completed") {
    if ("result" in result) {
      const payload = result.result;
      if (typeof payload === "string") {
        return payload;
      }
      if (payload !== undefined && payload !== null) {
        try {
          return JSON.stringify(payload, null, 2);
        } catch {
          return String(payload);
        }
      }
    }

    return result.summary?.trim() || `Async job "${result.jobId}" completed.`;
  }

  if (result.status === "failed") {
    const detail = result.error?.trim() || result.summary?.trim();
    return detail
      ? `Async job failed: ${detail}`
      : `Async job "${result.jobId}" failed.`;
  }

  return result.summary?.trim() || `Async job "${result.jobId}" is ${result.status}.`;
}

export function isAsyncJobPolicyRuntimeStep(
  step: Pick<PolicyRuntimeOperationExecutionStep, "operation">
): boolean {
  return step.operation === "read_async_job" || step.operation === "await_async_job";
}

export async function runAsyncJobPolicyRuntimeStep(args: {
  step: PolicyRuntimeOperationExecutionStep;
  promptValues: PromptValueSnapshot;
  onCompletedRuntimeOperationJob?: (
    jobId: string,
    result: AsyncRuntimeOperationCompletionPayload
  ) => void | Promise<void>;
}): Promise<{ promptValues: PromptValueSnapshot; output?: string | null } | null> {
  if (!isAsyncJobPolicyRuntimeStep(args.step)) {
    return null;
  }

  const resultBase = args.step.result_variable?.trim() || "async_job";
  const sourceVariable = args.step.job_source_variable?.trim() || "";
  const sourceValue = sourceVariable ? args.promptValues[sourceVariable] : undefined;
  const jobId = extractAsyncRuntimeJobId(sourceValue);

  let result: AsyncRuntimeJobResult;
  if (!sourceVariable) {
    result = buildFailedAsyncJobResult(
      "",
      "Missing async job source variable.",
      "The async runtime operation has no job source variable configured."
    );
  } else if (!jobId) {
    result = buildFailedAsyncJobResult(
      "",
      `No async job id could be resolved from "${sourceVariable}".`,
      "The configured async job source variable did not contain a job id."
    );
  } else if (args.step.operation === "await_async_job") {
    result = await awaitAsyncRuntimeJobCompletion(jobId, {
      timeoutMs: args.step.timeout_ms ?? undefined,
      pollIntervalMs: args.step.poll_interval_ms ?? undefined,
    });
  } else {
    result =
      (await getAsyncRuntimeJob(jobId)) ??
      buildFailedAsyncJobResult(
        jobId,
        `Async runtime job "${jobId}" was not found.`,
        "No async runtime job is stored under that id."
      );
  }

  const updates = buildAsyncRuntimeJobPromptValueUpdates(resultBase, result);
  const mirroredBases = getAsyncJobMirroredOutputBases({
    sourceVariable,
    resultBase,
    sourceValue,
  });
  const promptValueUpdates = mirroredBases.reduce<PromptValueSnapshot>(
    (acc, baseName) => ({
      ...acc,
      ...buildAsyncRuntimeJobPromptValueUpdates(baseName, result),
    }),
    updates
  );
  if (
    result.status === "completed" &&
    isAsyncRuntimeOperationCompletionPayload(result.result)
  ) {
    await args.onCompletedRuntimeOperationJob?.(result.jobId, result.result);
    return {
      promptValues: {
        ...promptValueUpdates,
        ...(result.result.promptValues ?? {}),
      },
      output: result.result.output,
    };
  }

  return {
    promptValues: promptValueUpdates,
    output: renderAsyncJobResultOutput(result),
  };
}
