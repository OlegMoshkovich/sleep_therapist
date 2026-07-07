import type {
  SimulationPlayerDataset,
  SimulationPlayerDatasetRecord,
} from "@airlab/canvas-core/components/setup/dataset-schema";
import { isCanvasRuleRegistryDatasetName } from "@airlab/canvas-core/lib/canvas-rule-registry";

type DatasetIdFactory = () => string;

export const EXTERNAL_EPISODES_DATASET_NAME = "external_episodes";
export const EXTERNAL_EPISODES_COLUMN_NAME = "episode";
export const WORKFLOW_HISTORICAL_RECORDS_DATASET_NAME =
  "workflow_historical_records";
export const WORKFLOW_REFERENCE_MATERIALS_DATASET_NAME =
  "workflow_reference_materials";
export const WORKFLOW_SOURCE_NAME_COLUMN_NAME = "source_name";
export const WORKFLOW_SOURCE_TYPE_COLUMN_NAME = "source_type";
export const WORKFLOW_SOURCE_CONTENT_COLUMN_NAME = "content";

export type WorkflowBootstrapSourceKind =
  | "historical_records"
  | "reference_material";

export interface WorkflowBootstrapSourceInput {
  sourceName: string;
  sourceType?: string | null;
  content: string;
}

function normalizeDatasetName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function isExternalEpisodesDatasetName(name: string): boolean {
  return normalizeDatasetName(name) === EXTERNAL_EPISODES_DATASET_NAME;
}

export function isExternalEpisodesDataset(
  dataset: Pick<SimulationPlayerDataset, "name"> | null | undefined
): boolean {
  return !!dataset && isExternalEpisodesDatasetName(dataset.name);
}

export function isWorkflowBootstrapSourceDatasetName(name: string): boolean {
  const normalized = normalizeDatasetName(name);
  return (
    normalized === WORKFLOW_HISTORICAL_RECORDS_DATASET_NAME ||
    normalized === WORKFLOW_REFERENCE_MATERIALS_DATASET_NAME
  );
}

export function getWorkflowBootstrapSourceDatasetName(
  kind: WorkflowBootstrapSourceKind
): string {
  return kind === "reference_material"
    ? WORKFLOW_REFERENCE_MATERIALS_DATASET_NAME
    : WORKFLOW_HISTORICAL_RECORDS_DATASET_NAME;
}

function getWorkflowBootstrapSourceDatasetNotes(
  kind: WorkflowBootstrapSourceKind
): string {
  return kind === "reference_material"
    ? "Bootstrap context uploaded before or during project creation. These guidelines, books, articles, or reference notes should inform the first workflow abstraction."
    : "Bootstrap context uploaded before or during project creation. These historical records show likely workflow inputs, outputs, handoffs, and examples.";
}

function createWorkflowBootstrapSourceDataset(
  kind: WorkflowBootstrapSourceKind,
  makeId: DatasetIdFactory
): SimulationPlayerDataset {
  const sourceNameColumnId = makeId();
  const sourceTypeColumnId = makeId();
  const contentColumnId = makeId();

  return {
    id: makeId(),
    name: getWorkflowBootstrapSourceDatasetName(kind),
    notes: getWorkflowBootstrapSourceDatasetNotes(kind),
    columns: [
      {
        id: sourceNameColumnId,
        name: WORKFLOW_SOURCE_NAME_COLUMN_NAME,
        type: "string",
      },
      {
        id: sourceTypeColumnId,
        name: WORKFLOW_SOURCE_TYPE_COLUMN_NAME,
        type: "string",
      },
      {
        id: contentColumnId,
        name: WORKFLOW_SOURCE_CONTENT_COLUMN_NAME,
        type: "string",
      },
    ],
    records: [],
  };
}

function findColumnByName(dataset: SimulationPlayerDataset, name: string) {
  return dataset.columns.find((column) => column.name.trim() === name);
}

function ensureWorkflowBootstrapSourceColumns(
  dataset: SimulationPlayerDataset,
  makeId: DatasetIdFactory
) {
  const sourceNameColumn =
    findColumnByName(dataset, WORKFLOW_SOURCE_NAME_COLUMN_NAME) ?? {
      id: makeId(),
      name: WORKFLOW_SOURCE_NAME_COLUMN_NAME,
      type: "string" as const,
    };
  const sourceTypeColumn =
    findColumnByName(dataset, WORKFLOW_SOURCE_TYPE_COLUMN_NAME) ?? {
      id: makeId(),
      name: WORKFLOW_SOURCE_TYPE_COLUMN_NAME,
      type: "string" as const,
    };
  const contentColumn =
    findColumnByName(dataset, WORKFLOW_SOURCE_CONTENT_COLUMN_NAME) ?? {
      id: makeId(),
      name: WORKFLOW_SOURCE_CONTENT_COLUMN_NAME,
      type: "string" as const,
    };
  const existingColumns = dataset.columns.filter(
    (column) =>
      column.id !== sourceNameColumn.id &&
      column.id !== sourceTypeColumn.id &&
      column.id !== contentColumn.id
  );

  return {
    columns: [
      sourceNameColumn,
      sourceTypeColumn,
      contentColumn,
      ...existingColumns,
    ],
    sourceNameColumn,
    sourceTypeColumn,
    contentColumn,
  };
}

function normalizeWorkflowBootstrapContent(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

export function appendWorkflowBootstrapSourceRecords(
  datasets: SimulationPlayerDataset[],
  kind: WorkflowBootstrapSourceKind,
  sources: WorkflowBootstrapSourceInput[],
  makeId: DatasetIdFactory
): SimulationPlayerDataset[] {
  const normalizedSources = sources
    .map((source) => ({
      sourceName: source.sourceName.trim() || "Uploaded source",
      sourceType: source.sourceType?.trim() || "text/plain",
      content: normalizeWorkflowBootstrapContent(source.content),
    }))
    .filter((source) => source.content.length > 0);
  if (normalizedSources.length === 0) {
    return datasets;
  }

  const datasetName = getWorkflowBootstrapSourceDatasetName(kind);
  const existingDataset = datasets.find(
    (dataset) => normalizeDatasetName(dataset.name) === datasetName
  );
  const ensuredDatasets = existingDataset
    ? datasets
    : [...datasets, createWorkflowBootstrapSourceDataset(kind, makeId)];

  return ensuredDatasets.map((dataset) => {
    if (normalizeDatasetName(dataset.name) !== datasetName) {
      return dataset;
    }

    const {
      columns,
      sourceNameColumn,
      sourceTypeColumn,
      contentColumn,
    } = ensureWorkflowBootstrapSourceColumns(dataset, makeId);

    return {
      ...dataset,
      notes: dataset.notes || getWorkflowBootstrapSourceDatasetNotes(kind),
      columns,
      records: [
        ...dataset.records,
        ...normalizedSources.map((source) => ({
          id: makeId(),
          values: {
            [sourceNameColumn.id]: source.sourceName,
            [sourceTypeColumn.id]: source.sourceType,
            [contentColumn.id]: source.content,
          },
        })),
      ],
    };
  });
}

export function readWorkflowBootstrapSourceContents(
  datasets: SimulationPlayerDataset[],
  kind: WorkflowBootstrapSourceKind
): string[] {
  const datasetName = getWorkflowBootstrapSourceDatasetName(kind);
  const dataset = datasets.find(
    (candidate) => normalizeDatasetName(candidate.name) === datasetName
  );
  if (!dataset) {
    return [];
  }

  const contentColumn =
    findColumnByName(dataset, WORKFLOW_SOURCE_CONTENT_COLUMN_NAME) ??
    dataset.columns[0];
  if (!contentColumn) {
    return [];
  }

  return dataset.records
    .map((record) => record.values[contentColumn.id] ?? "")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function readWorkflowBootstrapSourceNames(
  datasets: SimulationPlayerDataset[],
  kind: WorkflowBootstrapSourceKind
): string[] {
  const datasetName = getWorkflowBootstrapSourceDatasetName(kind);
  const dataset = datasets.find(
    (candidate) => normalizeDatasetName(candidate.name) === datasetName
  );
  if (!dataset) {
    return [];
  }

  const sourceNameColumn =
    findColumnByName(dataset, WORKFLOW_SOURCE_NAME_COLUMN_NAME) ??
    dataset.columns[0];
  if (!sourceNameColumn) {
    return [];
  }

  return dataset.records
    .map((record) => record.values[sourceNameColumn.id] ?? "")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function createExternalEpisodesDataset(
  makeId: DatasetIdFactory
): SimulationPlayerDataset {
  const columnId = makeId();

  return {
    id: makeId(),
    name: EXTERNAL_EPISODES_DATASET_NAME,
    notes:
      "Bootstrap dataset for uploaded sample interaction episodes that guide early daemon seeding.",
    columns: [
      {
        id: columnId,
        name: EXTERNAL_EPISODES_COLUMN_NAME,
        type: "string",
      },
    ],
    records: [],
  };
}

export function getExternalEpisodesDataset(
  datasets: SimulationPlayerDataset[]
): SimulationPlayerDataset | null {
  return datasets.find((dataset) => isExternalEpisodesDataset(dataset)) ?? null;
}

export function ensureExternalEpisodesDataset(
  datasets: SimulationPlayerDataset[],
  makeId: DatasetIdFactory
): SimulationPlayerDataset[] {
  if (datasets.some((dataset) => isExternalEpisodesDataset(dataset))) {
    return datasets;
  }

  return [...datasets, createExternalEpisodesDataset(makeId)];
}

export function readExternalEpisodeTexts(
  datasets: SimulationPlayerDataset[]
): string[] {
  const dataset = getExternalEpisodesDataset(datasets);
  if (!dataset) {
    return [];
  }

  const episodeColumn =
    dataset.columns.find((column) => column.name.trim() === EXTERNAL_EPISODES_COLUMN_NAME) ??
    dataset.columns[0];
  if (!episodeColumn) {
    return [];
  }

  return dataset.records
    .map((record) => record.values[episodeColumn.id] ?? "")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function buildExternalEpisodeRecords(
  episodes: string[],
  columnId: string,
  makeId: DatasetIdFactory
): SimulationPlayerDatasetRecord[] {
  return episodes.map((episode) => ({
    id: makeId(),
    values: {
      [columnId]: episode,
    },
  }));
}

export function replaceExternalEpisodesDatasetRecords(
  datasets: SimulationPlayerDataset[],
  episodes: string[],
  makeId: DatasetIdFactory
): SimulationPlayerDataset[] {
  const ensured = ensureExternalEpisodesDataset(datasets, makeId);

  return ensured.map((dataset) => {
    if (!isExternalEpisodesDataset(dataset)) {
      return dataset;
    }

    const episodeColumn =
      dataset.columns.find((column) => column.name.trim() === EXTERNAL_EPISODES_COLUMN_NAME) ??
      dataset.columns[0] ?? {
        id: makeId(),
        name: EXTERNAL_EPISODES_COLUMN_NAME,
        type: "string" as const,
      };

    return {
      ...dataset,
      columns: [episodeColumn],
      records: buildExternalEpisodeRecords(episodes, episodeColumn.id, makeId),
    };
  });
}

export function clearExternalEpisodesDatasetRecords(
  datasets: SimulationPlayerDataset[],
  makeId: DatasetIdFactory
): SimulationPlayerDataset[] {
  return replaceExternalEpisodesDatasetRecords(datasets, [], makeId);
}

function truncateEpisode(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function renderExternalEpisodesPrompt(
  datasets: SimulationPlayerDataset[],
  maxEpisodes = 4,
  maxLength = 360
): string {
  const episodes = readExternalEpisodeTexts(datasets);
  if (episodes.length === 0) {
    return "- (none)";
  }

  const preview = episodes
    .slice(0, maxEpisodes)
    .map((episode, index) => `- Episode ${index + 1}: ${truncateEpisode(episode, maxLength)}`)
    .join("\n");
  const remaining =
    episodes.length > maxEpisodes
      ? `\n- (${episodes.length - maxEpisodes} more episode${episodes.length - maxEpisodes === 1 ? "" : "s"})`
      : "";

  return `${preview}${remaining}`;
}

function normalizeEpisodeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function splitDelimitedEpisodes(text: string): string[] {
  return text
    .split(/\n(?:---+|\*\*\*+)\n/g)
    .map(normalizeEpisodeText)
    .filter((episode) => episode.length > 0);
}

function splitTitledEpisodes(text: string): string[] {
  const matches = [...text.matchAll(/(^|\n)(?:#{1,6}\s*)?episode\s+\d+[:\-\s]/gim)];
  if (matches.length < 2) {
    return [];
  }

  const episodes: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index]?.index ?? 0;
    const nextStart = matches[index + 1]?.index ?? text.length;
    const slice = normalizeEpisodeText(text.slice(start, nextStart));
    if (slice) {
      episodes.push(slice);
    }
  }
  return episodes;
}

function splitParagraphEpisodes(text: string): string[] {
  return text
    .split(/\n\s*\n(?=\S)/g)
    .map(normalizeEpisodeText)
    .filter((episode) => episode.length >= 40);
}

function extractEpisodesFromJson(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => {
          if (typeof entry === "string") {
            return normalizeEpisodeText(entry);
          }
          if (entry && typeof entry === "object") {
            const record = entry as Record<string, unknown>;
            const candidate =
              typeof record.episode === "string"
                ? record.episode
                : typeof record.text === "string"
                  ? record.text
                  : typeof record.content === "string"
                    ? record.content
                    : "";
            return normalizeEpisodeText(candidate);
          }
          return "";
        })
        .filter((episode) => episode.length > 0);
    }
  } catch {
    // Fall through to text heuristics.
  }

  return [];
}

export function extractExternalEpisodesFromText(args: {
  fileName: string;
  fileType?: string | null;
  text: string;
}): string[] {
  const normalized = normalizeEpisodeText(args.text);
  if (!normalized) {
    return [];
  }

  const fileName = args.fileName.trim().toLowerCase();
  const fileType = (args.fileType ?? "").trim().toLowerCase();
  if (fileType.includes("json") || fileName.endsWith(".json")) {
    const fromJson = extractEpisodesFromJson(normalized);
    if (fromJson.length > 0) {
      return fromJson;
    }
  }

  const titled = splitTitledEpisodes(normalized);
  if (titled.length > 0) {
    return titled;
  }

  const delimited = splitDelimitedEpisodes(normalized);
  if (delimited.length > 1) {
    return delimited;
  }

  const paragraphBlocks = splitParagraphEpisodes(normalized);
  if (paragraphBlocks.length > 1) {
    return paragraphBlocks;
  }

  return [normalized];
}

export function splitProjectDatasets(datasets: SimulationPlayerDataset[]): {
  bootstrapDatasets: SimulationPlayerDataset[];
  authoredDatasets: SimulationPlayerDataset[];
} {
  const bootstrapDatasets: SimulationPlayerDataset[] = [];
  const authoredDatasets: SimulationPlayerDataset[] = [];

  for (const dataset of datasets) {
    if (
      isExternalEpisodesDataset(dataset) ||
      isWorkflowBootstrapSourceDatasetName(dataset.name) ||
      isCanvasRuleRegistryDatasetName(dataset.name)
    ) {
      bootstrapDatasets.push(dataset);
      continue;
    }
    authoredDatasets.push(dataset);
  }

  return {
    bootstrapDatasets,
    authoredDatasets,
  };
}
