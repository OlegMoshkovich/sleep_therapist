import { GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE } from "@airlab/orchestration-core/general-orchestration-daemon-config";
import { GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE } from "@airlab/orchestration-core/general-orchestration-daemon-drafts";
import { GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE } from "@airlab/orchestration-core/general-orchestration-daemon-published-demos";

// Tables whose rows carry the serialized `datasets` (and `guideline_blocks`)
// columns that dataset/knowledge tools may read and write. Writes against any
// other table are rejected so a mis-threaded setupTable can't touch arbitrary
// rows with the admin client.
export const SUPPORTED_SETUP_TABLES = new Set([
  "nutrition",
  "sleep_inputs",
  "dnd_inputs",
  "research_assistant_inputs",
  GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE,
  GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE,
  GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE,
]);

export interface DatasetToolSupabaseClient {
  from: (table: string) => any;
}

export type DatasetToolSupabaseFactory = () => DatasetToolSupabaseClient;

let datasetToolSupabaseFactory: DatasetToolSupabaseFactory | null = null;

export function registerDatasetToolSupabaseFactory(
  factory: DatasetToolSupabaseFactory | null
): void {
  datasetToolSupabaseFactory = factory;
}

export function createDatasetToolSupabaseClient(): DatasetToolSupabaseClient {
  if (!datasetToolSupabaseFactory) {
    throw new Error("Dataset tool Supabase factory is not registered.");
  }
  return datasetToolSupabaseFactory();
}

export function registerDatasetToolSupportedSetupTables(
  tables: Iterable<string>
): void {
  for (const table of tables) {
    const normalized = table.trim();
    if (normalized) {
      SUPPORTED_SETUP_TABLES.add(normalized);
    }
  }
}

export type DatasetColumnType =
  | "string"
  | "url"
  | "string[]"
  | "integer"
  | "number"
  | "boolean";
export type DatasetRecordValue = string | string[] | number | boolean | null;

export interface StoredDatasetColumn {
  name: string;
  type: DatasetColumnType;
}

export interface StoredDataset {
  name: string;
  notes: string;
  columns: StoredDatasetColumn[];
  records: Array<Record<string, DatasetRecordValue>>;
}

export interface DatasetToolRuntimeEnvironmentPlayer {
  id: string;
  datasets: StoredDataset[];
}

/**
 * Mutable, request-scoped dataset state for a run. Routes build this from the
 * submitted project snapshot so dataset tools read what the user currently
 * sees, not whatever the saved draft row happened to contain before autosave.
 */
export interface DatasetToolRuntime {
  primaryDatasets: StoredDataset[];
  sharedDatasets: StoredDataset[];
  environmentPlayers: DatasetToolRuntimeEnvironmentPlayer[];
}

export interface DatasetRuntimeTarget {
  datasets: StoredDataset[];
  datasetIndex: number;
  dataset: StoredDataset;
  scope: "primary" | "player" | "shared";
  environmentPlayerId?: string;
}

export function normalizeColumnType(raw: unknown): DatasetColumnType {
  return raw === "url" ||
    raw === "string[]" ||
    raw === "integer" ||
    raw === "number" ||
    raw === "boolean"
    ? raw
    : "string";
}

export function normalizeDatasetName(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

export function normalizeDatasetKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export function safeParseJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeStoredDatasets(raw: unknown): StoredDataset[] {
  const items =
    Array.isArray(raw) ? raw : typeof raw === "string" ? safeParseJsonArray(raw) : [];

  return items.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const dataset = item as Record<string, unknown>;
    const rawColumns = Array.isArray(dataset.columns) ? dataset.columns : [];
    const rawRecords = Array.isArray(dataset.records) ? dataset.records : [];
    const name = normalizeDatasetName(dataset.name) || `Dataset ${index + 1}`;
    const notes = typeof dataset.notes === "string" ? dataset.notes : "";
    const columns = rawColumns
      .map((column, columnIndex) => {
        if (!column || typeof column !== "object" || Array.isArray(column)) {
          return null;
        }

        const value = column as Record<string, unknown>;
        const columnName = normalizeDatasetName(value.name) || `column_${columnIndex + 1}`;
        return {
          name: columnName,
          type: normalizeColumnType(value.type),
        };
      })
      .filter((column): column is StoredDatasetColumn => column !== null);

    if (columns.length === 0) {
      return [];
    }

    const records = rawRecords
      .filter((record) => !!record && typeof record === "object" && !Array.isArray(record))
      .map((record) => record as Record<string, DatasetRecordValue>);

    return [{ name, notes, columns, records }];
  });
}

export function coerceDatasetValue(
  rawValue: unknown,
  type: DatasetColumnType
): DatasetRecordValue {
  if (rawValue === undefined || rawValue === null) {
    return null;
  }

  if (type === "boolean") {
    if (typeof rawValue === "boolean") {
      return rawValue;
    }
    if (typeof rawValue === "string") {
      const normalized = rawValue.trim().toLowerCase();
      if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
      if (normalized === "false" || normalized === "no" || normalized === "0") return false;
    }
    return null;
  }

  if (type === "integer") {
    const numeric =
      typeof rawValue === "number"
        ? rawValue
        : typeof rawValue === "string"
          ? Number.parseInt(rawValue.trim(), 10)
          : Number.NaN;
    return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
  }

  if (type === "number") {
    const numeric =
      typeof rawValue === "number"
        ? rawValue
        : typeof rawValue === "string"
          ? Number(rawValue.trim())
          : Number.NaN;
    return Number.isFinite(numeric) ? numeric : null;
  }

  if (type === "string[]") {
    if (Array.isArray(rawValue)) {
      const values = rawValue
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0);
      return values.length > 0 ? values : null;
    }

    if (typeof rawValue === "string") {
      const values = rawValue
        .split(/\r?\n|,/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      return values.length > 0 ? values : null;
    }

    const text = String(rawValue).trim();
    return text.length > 0 ? [text] : null;
  }

  const text = String(rawValue).trim();
  return text.length > 0 ? text : null;
}

export function hasMeaningfulDatasetValue(
  record: Record<string, DatasetRecordValue>
): boolean {
  return Object.values(record).some((value) => {
    if (value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "string") return value.trim().length > 0;
    return true;
  });
}

/**
 * Finds an environment player entry (stored under the setup row's
 * environment_players jsonb column) by its id.
 */
export function findEnvironmentPlayerEntry(
  raw: unknown,
  environmentPlayerId: string
): Record<string, unknown> | null {
  const items =
    Array.isArray(raw) ? raw : typeof raw === "string" ? safeParseJsonArray(raw) : [];

  for (const item of items) {
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).id === environmentPlayerId
    ) {
      return item as Record<string, unknown>;
    }
  }

  return null;
}

function findAgentBindingEntry(
  raw: unknown,
  agentId: string
): Record<string, unknown> | null {
  const normalized = agentId.trim();
  if (!normalized) {
    return null;
  }
  const items =
    Array.isArray(raw) ? raw : typeof raw === "string" ? safeParseJsonArray(raw) : [];

  for (const item of items) {
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).id === normalized
    ) {
      return item as Record<string, unknown>;
    }
  }

  return null;
}

function readAgentBindingTemplateVersionId(
  binding: Record<string, unknown> | null
): string {
  if (!binding) {
    return "";
  }
  const raw = binding.template_version_id ?? binding.templateVersionId;
  return typeof raw === "string" ? raw.trim() : "";
}

async function loadAgentBindingDatasets(args: {
  supabase: DatasetToolSupabaseClient;
  binding: Record<string, unknown> | null;
}): Promise<StoredDataset[]> {
  if (!args.binding) {
    return [];
  }

  const overrides = normalizeStoredDatasets(
    args.binding.dataset_overrides ?? args.binding.datasetOverrides
  );
  if (overrides.length > 0) {
    return overrides;
  }

  const templateVersionId = readAgentBindingTemplateVersionId(args.binding);
  if (!templateVersionId) {
    return [];
  }

  const { data, error } = await args.supabase
    .from("agent_template_versions")
    .select("default_datasets")
    .eq("id", templateVersionId)
    .maybeSingle();

  if (error || !data) {
    return [];
  }

  return normalizeStoredDatasets(data.default_datasets);
}

/** Name-keyed union where `primary` datasets shadow same-named `fallback` ones. */
export function mergeStoredDatasetsWithPrecedence(
  primary: StoredDataset[],
  fallback: StoredDataset[]
): StoredDataset[] {
  const primaryKeys = new Set(primary.map((dataset) => normalizeDatasetKey(dataset.name)));
  return [
    ...primary,
    ...fallback.filter((dataset) => !primaryKeys.has(normalizeDatasetKey(dataset.name))),
  ];
}

export function getRuntimeOwnDatasets(
  runtime: DatasetToolRuntime,
  environmentPlayerId?: string
): StoredDataset[] {
  if (!environmentPlayerId) {
    return runtime.primaryDatasets;
  }

  return (
    runtime.environmentPlayers.find((player) => player.id === environmentPlayerId)
      ?.datasets ?? []
  );
}

export function resolveRuntimeDatasets(
  runtime: DatasetToolRuntime,
  environmentPlayerId?: string
): StoredDataset[] {
  return mergeStoredDatasetsWithPrecedence(
    getRuntimeOwnDatasets(runtime, environmentPlayerId),
    runtime.sharedDatasets
  );
}

export function findDatasetRuntimeTarget(
  runtime: DatasetToolRuntime,
  datasetName: string,
  environmentPlayerId?: string
): DatasetRuntimeTarget | null {
  const ownDatasets = getRuntimeOwnDatasets(runtime, environmentPlayerId);
  const findDatasetIndex = (datasets: StoredDataset[]) =>
    datasets.findIndex(
      (dataset) =>
        normalizeDatasetKey(dataset.name) === normalizeDatasetKey(datasetName)
    );
  const ownIndex = findDatasetIndex(ownDatasets);
  if (ownIndex >= 0) {
    return {
      datasets: ownDatasets,
      datasetIndex: ownIndex,
      dataset: ownDatasets[ownIndex],
      scope: environmentPlayerId ? "player" : "primary",
      ...(environmentPlayerId ? { environmentPlayerId } : {}),
    };
  }

  const sharedIndex = findDatasetIndex(runtime.sharedDatasets);
  if (sharedIndex < 0) {
    return null;
  }

  return {
    datasets: runtime.sharedDatasets,
    datasetIndex: sharedIndex,
    dataset: runtime.sharedDatasets[sharedIndex],
    scope: "shared",
  };
}

export function appendDatasetRuntimeRecord(
  target: DatasetRuntimeTarget,
  record: Record<string, DatasetRecordValue>
): void {
  target.datasets[target.datasetIndex] = {
    ...target.dataset,
    records: [...target.dataset.records, record],
  };
  target.dataset = target.datasets[target.datasetIndex];
}

/**
 * Daemon-authored setups can carry a shared_datasets tier every agent falls
 * back to. Older fixed demos keep a single datasets column.
 */
export function setupTableSupportsSharedDatasets(setupTable: string): boolean {
  return (
    setupTable === GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE ||
    setupTable === GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE
  );
}

/**
 * Loads the datasets a dataset tool may address: the agent's own datasets
 * first (the row's top-level datasets, or the environment player's datasets
 * when `environmentPlayerId` is set), then the draft's shared datasets as
 * fallback. Same-named own datasets shadow shared ones.
 */
export async function loadStoredDatasets(
  supabase: DatasetToolSupabaseClient,
  setupTable: string,
  setupId: string,
  environmentPlayerId?: string
): Promise<{ datasets: StoredDataset[]; error?: never } | { datasets?: never; error: string }> {
  const supportsSharedTier = setupTableSupportsSharedDatasets(setupTable);
  const columns = [
    "datasets",
    ...(supportsSharedTier ? ["shared_datasets"] : []),
    ...(environmentPlayerId ? ["environment_players", "agent_bindings"] : []),
  ].join(", ");

  const { data: row, error: loadError } = await supabase
    .from(setupTable)
    .select(columns)
    .eq("id", setupId)
    .single();

  if (loadError || !row) {
    return {
      error: `${loadError?.code ?? "load_error"}: ${loadError?.message ?? "Setup not found"}`,
    };
  }

  const environmentPlayerEntry = environmentPlayerId
    ? findEnvironmentPlayerEntry(row.environment_players, environmentPlayerId)
    : null;
  const bindingEntry =
    environmentPlayerId && !environmentPlayerEntry
      ? findAgentBindingEntry(row.agent_bindings, environmentPlayerId)
      : null;
  const ownDatasets = environmentPlayerId
    ? environmentPlayerEntry
      ? normalizeStoredDatasets(environmentPlayerEntry.datasets)
      : await loadAgentBindingDatasets({ supabase, binding: bindingEntry })
    : normalizeStoredDatasets(row.datasets);
  const sharedDatasets = supportsSharedTier
    ? normalizeStoredDatasets(row.shared_datasets)
    : [];

  return {
    datasets: mergeStoredDatasetsWithPrecedence(ownDatasets, sharedDatasets),
  };
}
