import type {
  ToolDispatchConfig,
  ToolDispatchContext,
  ToolDispatchResult,
} from "@airlab/canvas-compiler/tool-types";
import {
  SUPPORTED_SETUP_TABLES,
  coerceDatasetValue,
  createDatasetToolSupabaseClient,
  loadStoredDatasets,
  normalizeDatasetKey,
  normalizeDatasetName,
  resolveRuntimeDatasets,
  type DatasetRecordValue,
  type StoredDataset,
} from "./dataset-store";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// `query` and `limit` are reserved control args; every other arg whose name
// matches a column becomes an equality filter.
const RESERVED_ARG_KEYS = new Set(["query", "limit"]);

function normalizeLimit(rawValue: unknown): number {
  const numeric =
    typeof rawValue === "number"
      ? rawValue
      : typeof rawValue === "string"
        ? Number.parseInt(rawValue.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(numeric)));
}

function matchesQuery(
  record: Record<string, DatasetRecordValue>,
  dataset: StoredDataset,
  query: string
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }

  return dataset.columns.some((column) => {
    const value = record[column.name];
    if (typeof value === "string") {
      return value.toLowerCase().includes(needle);
    }
    if (Array.isArray(value)) {
      return value.some((entry) => entry.toLowerCase().includes(needle));
    }
    return false;
  });
}

function matchesEqualityFilter(
  recordValue: DatasetRecordValue,
  filterValue: DatasetRecordValue
): boolean {
  if (filterValue === null) {
    return true;
  }
  if (recordValue === null) {
    return false;
  }
  if (typeof filterValue === "string") {
    if (Array.isArray(recordValue)) {
      return recordValue.some(
        (entry) => entry.trim().toLowerCase() === filterValue.trim().toLowerCase()
      );
    }
    return (
      typeof recordValue === "string" &&
      recordValue.trim().toLowerCase() === filterValue.trim().toLowerCase()
    );
  }
  if (Array.isArray(filterValue)) {
    return (
      Array.isArray(recordValue) &&
      filterValue.every((entry) =>
        recordValue.some(
          (candidate) => candidate.trim().toLowerCase() === entry.trim().toLowerCase()
        )
      )
    );
  }
  return recordValue === filterValue;
}

function readRecordsFromDatasets(
  datasets: StoredDataset[],
  datasetName: string,
  args: Record<string, unknown>
): ToolDispatchResult {
  const dataset = datasets.find(
    (candidate) => normalizeDatasetKey(candidate.name) === normalizeDatasetKey(datasetName)
  );

  if (!dataset) {
    return {
      ok: false,
      error: `dataset "${datasetName}" was not found in the current setup.`,
    };
  }

  const query = typeof args.query === "string" ? args.query : "";
  const limit = normalizeLimit(args.limit);

  const columnsByKey = new Map(
    dataset.columns.map((column) => [normalizeDatasetKey(column.name), column] as const)
  );
  const filters = Object.entries(args).flatMap(([key, rawValue]) => {
    if (RESERVED_ARG_KEYS.has(key)) {
      return [];
    }
    const column = columnsByKey.get(normalizeDatasetKey(key));
    if (!column) {
      return [];
    }
    const filterValue = coerceDatasetValue(rawValue, column.type);
    // A filter that coerces to null carries no constraint — skip it instead
    // of filtering everything out.
    return filterValue === null ? [] : [{ columnName: column.name, filterValue }];
  });

  const matching = dataset.records.filter(
    (record) =>
      matchesQuery(record, dataset, query) &&
      filters.every((filter) =>
        matchesEqualityFilter(record[filter.columnName] ?? null, filter.filterValue)
      )
  );

  const records = matching.slice(0, limit);

  return {
    ok: true,
    data: {
      dataset: dataset.name,
      notes: dataset.notes,
      columns: dataset.columns,
      totalMatching: matching.length,
      returned: records.length,
      records,
    },
  };
}

export async function readDatasetRecords(
  config: ToolDispatchConfig,
  args: Record<string, unknown>,
  context: ToolDispatchContext
): Promise<ToolDispatchResult> {
  const datasetName = normalizeDatasetName(config.datasetName);
  if (!datasetName) {
    return {
      ok: false,
      error: "dataset read requires a dataset name in the tool configuration.",
    };
  }

  if (context.datasetRuntime) {
    return readRecordsFromDatasets(
      resolveRuntimeDatasets(
        context.datasetRuntime,
        context.environmentPlayerId
      ),
      datasetName,
      args
    );
  }

  if (!context.setupTable || !context.setupId) {
    return {
      ok: false,
      error: "dataset read requires a demo setup context.",
    };
  }

  if (!SUPPORTED_SETUP_TABLES.has(context.setupTable)) {
    return {
      ok: false,
      error: `dataset read is not enabled for setup table "${context.setupTable}".`,
    };
  }

  try {
    const supabase = createDatasetToolSupabaseClient();
    const loaded = await loadStoredDatasets(
      supabase,
      context.setupTable,
      context.setupId,
      context.environmentPlayerId
    );
    if (loaded.error !== undefined) {
      return { ok: false, error: loaded.error };
    }

    return readRecordsFromDatasets(loaded.datasets, datasetName, args);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown dataset read error",
    };
  }
}
