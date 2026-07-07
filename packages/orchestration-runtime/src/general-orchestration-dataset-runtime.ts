import type { CompiledToolDef } from "@airlab/canvas-compiler/types";
import {
  serializeDatasets,
  type SimulationPlayerDataset,
} from "@airlab/canvas-core/components/setup/dataset-schema";
import type { DatasetToolRuntime } from "@airlab/canvas-compiler/tool-types";

/**
 * Renders dataset SCHEMAS for injection into target-agent system prompts.
 * Records are deliberately not inlined — agents fetch them through dataset
 * tools — so the per-turn prompt cost stays flat as datasets grow.
 */
export function buildDatasetSchemasContext(
  datasets: SimulationPlayerDataset[]
): string {
  const serialized = serializeDatasets(datasets);
  if (serialized.length === 0) {
    return "";
  }

  const lines = serialized.map((dataset) => {
    const columns = dataset.columns
      .map((column) => `${column.name} (${column.type})`)
      .join(", ");
    const notes = dataset.notes.trim();
    return `- "${dataset.name}" (${dataset.records.length} records)${
      notes ? `: ${notes}` : ""
    }\n  columns: ${columns || "(none)"}`;
  });

  return [
    "Datasets available through dataset tools (records are NOT inlined here; use the dataset read tools to fetch them):",
    ...lines,
  ].join("\n");
}

export function appendContextToPrompt(prompt: string, context: string): string {
  const trimmedContext = context.trim();
  if (!trimmedContext) {
    return prompt;
  }
  const trimmedPrompt = prompt.trim();
  return trimmedPrompt ? `${trimmedPrompt}\n\n${trimmedContext}` : trimmedContext;
}

/**
 * True when any compiled tool needs request-scoped dataset context. Routes
 * should pass the submitted project snapshot; saved-draft identity is only
 * needed when they also want best-effort persistence.
 */
export function compiledToolsNeedDatasetContext(
  toolsByName: Record<string, CompiledToolDef>
): boolean {
  return Object.values(toolsByName).some(
    (tool) =>
      tool.config.sourceType === "dataset_read" ||
      (tool.config.sourceType === "knowledge_save" &&
        tool.config.saveTarget === "dataset")
  );
}

/**
 * Collects tool-call failures during a run. The compiled policy graph now
 * replies with a generic apology on tool errors instead of speaking the raw
 * error, so builder surfaces (simulate / live-session) return these
 * diagnostics separately and the server log always carries them.
 */
export function createToolErrorCollector(scope: string): {
  toolErrors: string[];
  recordToolError: (toolName: string, error: unknown) => void;
} {
  const toolErrors: string[] = [];
  return {
    toolErrors,
    recordToolError: (toolName, error) => {
      const message = error instanceof Error ? error.message : String(error);
      toolErrors.push(`${toolName}: ${message}`);
      console.error(`[${scope}] tool "${toolName}" failed:`, message);
    },
  };
}

export interface DatasetWriteRecord {
  datasetName: string;
  record: Record<string, string | string[] | number | boolean | null>;
  /** Tier the record landed on; missing means the primary agent's datasets. */
  scope?: "primary" | "player" | "shared";
  /** Set when the record landed on an environment player's datasets. */
  environmentPlayerId?: string;
}

/**
 * Collects dataset writes made during a run so the route can both keep its
 * server-side project copy fresh and return the writes to the client for
 * merging (the client otherwise clobbers them on its next wholesale save).
 */
export function createDatasetWriteCollector(): {
  writes: DatasetWriteRecord[];
  onDatasetSave: (event: DatasetWriteRecord) => void;
} {
  const writes: DatasetWriteRecord[] = [];
  return {
    writes,
    onDatasetSave: (event) => {
      writes.push({
        datasetName: event.datasetName,
        record: event.record,
        ...(event.scope ? { scope: event.scope } : {}),
        ...(event.environmentPlayerId
          ? { environmentPlayerId: event.environmentPlayerId }
          : {}),
      });
    },
  };
}

export function createDatasetToolRuntime(args: {
  primaryDatasets: SimulationPlayerDataset[];
  sharedDatasets?: SimulationPlayerDataset[];
  environmentPlayers?: Array<{
    id: string;
    datasets: SimulationPlayerDataset[];
  }>;
}): DatasetToolRuntime {
  return {
    primaryDatasets: serializeDatasets(args.primaryDatasets),
    sharedDatasets: serializeDatasets(args.sharedDatasets ?? []),
    environmentPlayers: (args.environmentPlayers ?? []).map((player) => ({
      id: player.id,
      datasets: serializeDatasets(player.datasets),
    })),
  };
}

/**
 * Datasets an agent sees in its prompt context: its own datasets first, plus
 * shared draft-level datasets that aren't shadowed by a same-named own one.
 * Mirrors the runtime resolution order of the dataset tools.
 */
export function mergeDatasetsForAgentContext(
  ownDatasets: SimulationPlayerDataset[],
  sharedDatasets: SimulationPlayerDataset[]
): SimulationPlayerDataset[] {
  const ownNames = new Set(
    ownDatasets.map((dataset) => dataset.name.trim().toLowerCase())
  );
  return [
    ...ownDatasets,
    ...sharedDatasets.filter(
      (dataset) => !ownNames.has(dataset.name.trim().toLowerCase())
    ),
  ];
}
