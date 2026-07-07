export type SimulationPlayerDatasetColumnType =
  | "string"
  | "url"
  | "string[]"
  | "integer"
  | "number"
  | "boolean";

export interface SimulationPlayerDatasetColumn {
  id: string;
  name: string;
  type: SimulationPlayerDatasetColumnType;
}

export interface SimulationPlayerDatasetRecord {
  id: string;
  values: Record<string, string>;
}

export interface SimulationPlayerDataset {
  id: string;
  name: string;
  notes: string;
  columns: SimulationPlayerDatasetColumn[];
  records: SimulationPlayerDatasetRecord[];
}

type IdFactory = () => string;

interface StoredDatasetColumn {
  name: string;
  type: SimulationPlayerDatasetColumnType;
}

function normalizeColumnType(raw: unknown): SimulationPlayerDatasetColumnType {
  return raw === "url" ||
    raw === "string[]" ||
    raw === "integer" ||
    raw === "number" ||
    raw === "boolean"
    ? raw
    : "string";
}

function formatStoredValueForCell(
  value: unknown,
  type: SimulationPlayerDatasetColumnType
): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (type === "boolean") {
    if (value === true || value === false) {
      return String(value);
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "false") {
        return normalized;
      }
    }
  }

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  return String(value);
}

function parseCellValue(
  rawValue: string,
  type: SimulationPlayerDatasetColumnType
): string | string[] | number | boolean | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  if (type === "boolean") {
    if (/^(true|yes|1)$/i.test(trimmed)) {
      return true;
    }
    if (/^(false|no|0)$/i.test(trimmed)) {
      return false;
    }
    return trimmed;
  }

  if (type === "integer") {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : trimmed;
  }

  if (type === "number") {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : trimmed;
  }

  if (type === "string[]") {
    const values = rawValue
      .split(/\r?\n|,/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return values.length > 0 ? values : null;
  }

  return rawValue;
}

function buildStoredColumns(
  columns: SimulationPlayerDatasetColumn[]
): Array<StoredDatasetColumn & { id: string }> {
  const seen = new Set<string>();

  return columns.map((column, index) => {
    const baseName = column.name.trim() || `column_${index + 1}`;
    let nextName = baseName;
    let suffix = 2;

    while (seen.has(nextName.toLowerCase())) {
      nextName = `${baseName}_${suffix}`;
      suffix += 1;
    }

    seen.add(nextName.toLowerCase());

    return {
      id: column.id,
      name: nextName,
      type: column.type,
    };
  });
}

function readSerializableRecordCell(
  record: unknown,
  column: StoredDatasetColumn & { id: string }
): string {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return "";
  }

  const rawRecord = record as Record<string, unknown>;
  const rawValues = rawRecord.values;
  if (rawValues && typeof rawValues === "object" && !Array.isArray(rawValues)) {
    return formatStoredValueForCell(
      (rawValues as Record<string, unknown>)[column.id],
      column.type
    );
  }

  return formatStoredValueForCell(rawRecord[column.name], column.type);
}

function createLegacyTextDataset(
  text: string,
  makeId: IdFactory,
  index: number
): SimulationPlayerDataset {
  const columnId = makeId();
  return {
    id: makeId(),
    name: `Dataset ${index + 1}`,
    notes: "",
    columns: [{ id: columnId, name: "text", type: "string" }],
    records: [{ id: makeId(), values: { [columnId]: text } }],
  };
}

export function createEmptyDatasetColumn(
  makeId: IdFactory,
  index: number
): SimulationPlayerDatasetColumn {
  return {
    id: makeId(),
    name: `column_${index + 1}`,
    type: "string",
  };
}

export function createEmptyDataset(makeId: IdFactory, index = 0): SimulationPlayerDataset {
  return {
    id: makeId(),
    name: `Dataset ${index + 1}`,
    notes: "",
    columns: [createEmptyDatasetColumn(makeId, 0)],
    records: [],
  };
}

export function createEmptyDatasetRecord(
  columns: SimulationPlayerDatasetColumn[],
  makeId: IdFactory
): SimulationPlayerDatasetRecord {
  return {
    id: makeId(),
    values: columns.reduce<Record<string, string>>((acc, column) => {
      acc[column.id] = "";
      return acc;
    }, {}),
  };
}

export function resizeDatasetColumns(
  dataset: SimulationPlayerDataset,
  nextCount: number,
  makeId: IdFactory
): SimulationPlayerDataset {
  const safeCount = Math.max(1, Math.min(25, Math.floor(nextCount || 1)));
  const nextColumns = [...dataset.columns];

  while (nextColumns.length < safeCount) {
    nextColumns.push(createEmptyDatasetColumn(makeId, nextColumns.length));
  }

  const removedColumns = nextColumns.slice(safeCount);
  nextColumns.length = safeCount;

  const removedIds = new Set(removedColumns.map((column) => column.id));
  const nextRecords = dataset.records.map((record) => {
    const nextValues = { ...record.values };
    for (const removedId of removedIds) {
      delete nextValues[removedId];
    }
    for (const column of nextColumns) {
      if (!(column.id in nextValues)) {
        nextValues[column.id] = "";
      }
    }
    return {
      ...record,
      values: nextValues,
    };
  });

  return {
    ...dataset,
    columns: nextColumns,
    records: nextRecords,
  };
}

export function normalizeDatasets(
  raw: unknown,
  makeId: IdFactory
): SimulationPlayerDataset[] {
  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      items = Array.isArray(parsed) ? parsed : [];
    } catch {
      items = [];
    }
  }

  return items.flatMap((item, index) => {
    if (typeof item === "string") {
      return [createLegacyTextDataset(item, makeId, index)];
    }

    if (!item || typeof item !== "object") {
      return [];
    }

    const rawDataset = item as Record<string, unknown>;

    if (
      typeof rawDataset.text === "string" &&
      !Array.isArray(rawDataset.columns) &&
      !Array.isArray(rawDataset.records)
    ) {
      return [createLegacyTextDataset(rawDataset.text, makeId, index)];
    }

    const rawColumns = Array.isArray(rawDataset.columns) ? rawDataset.columns : [];
    const rawRecords = Array.isArray(rawDataset.records) ? rawDataset.records : [];

    const derivedColumns =
      rawColumns.length > 0
        ? rawColumns
            .map((column, columnIndex) => {
              if (!column || typeof column !== "object") {
                return null;
              }

              const rawColumn = column as Record<string, unknown>;
              return {
                id: makeId(),
                name:
                  typeof rawColumn.name === "string" && rawColumn.name.trim()
                    ? rawColumn.name.trim()
                    : `column_${columnIndex + 1}`,
                type: normalizeColumnType(rawColumn.type),
              };
            })
            .filter(
              (column): column is SimulationPlayerDatasetColumn => column !== null
            )
        : (() => {
            const firstObjectRecord = rawRecords.find(
              (record) =>
                !!record &&
                typeof record === "object" &&
                !Array.isArray(record)
            ) as Record<string, unknown> | undefined;

            if (!firstObjectRecord) {
              return [createEmptyDatasetColumn(makeId, 0)];
            }

            const keys = Object.keys(firstObjectRecord);
            return (keys.length > 0 ? keys : ["column_1"]).map((key, columnIndex) => ({
              id: makeId(),
              name: key || `column_${columnIndex + 1}`,
              type: "string" as const,
            }));
          })();

    const columns = derivedColumns.length > 0 ? derivedColumns : [createEmptyDatasetColumn(makeId, 0)];

    const records = rawRecords.flatMap((record) => {
      if (Array.isArray(record)) {
        const values = columns.reduce<Record<string, string>>((acc, column, columnIndex) => {
          acc[column.id] = formatStoredValueForCell(record[columnIndex], column.type);
          return acc;
        }, {});
        return [{ id: makeId(), values }];
      }

      if (!record || typeof record !== "object") {
        if (columns.length === 1) {
          return [
            {
              id: makeId(),
              values: {
                [columns[0].id]: formatStoredValueForCell(record, columns[0].type),
              },
            },
          ];
        }
        return [];
      }

      const rawRecord = record as Record<string, unknown>;
      return [
        {
          id: makeId(),
          values: columns.reduce<Record<string, string>>((acc, column) => {
            acc[column.id] = formatStoredValueForCell(rawRecord[column.name], column.type);
            return acc;
          }, {}),
        },
      ];
    });

    return [
      {
        id: makeId(),
        name:
          typeof rawDataset.name === "string" && rawDataset.name.trim()
            ? rawDataset.name.trim()
            : `Dataset ${index + 1}`,
        notes: typeof rawDataset.notes === "string" ? rawDataset.notes : "",
        columns,
        records,
      },
    ];
  });
}

/**
 * Merges runtime dataset writes (name-keyed records reported by the
 * simulate/live-session routes) into the client's in-memory datasets. Without
 * this merge, the next wholesale draft save would overwrite the records the
 * runtime just wrote to the database. Writes naming unknown datasets are
 * skipped — the database is still correct and the next draft load rehydrates.
 */
export function appendStoredRecordsToDatasets(
  datasets: SimulationPlayerDataset[],
  writes: Array<{ datasetName: string; record: Record<string, unknown> }>,
  makeId: IdFactory
): SimulationPlayerDataset[] {
  if (writes.length === 0) {
    return datasets;
  }

  return datasets.map((dataset) => {
    const matching = writes.filter(
      (write) =>
        write.datasetName.trim().toLowerCase() === dataset.name.trim().toLowerCase()
    );
    if (matching.length === 0) {
      return dataset;
    }

    const appended = matching.map((write) => ({
      id: makeId(),
      values: dataset.columns.reduce<Record<string, string>>((acc, column) => {
        acc[column.id] = formatStoredValueForCell(write.record[column.name], column.type);
        return acc;
      }, {}),
    }));

    return {
      ...dataset,
      records: [...dataset.records, ...appended],
    };
  });
}

export function serializeDatasets(
  datasets: SimulationPlayerDataset[]
): Array<{
  name: string;
  notes: string;
  columns: StoredDatasetColumn[];
  records: Array<Record<string, string | string[] | number | boolean | null>>;
}> {
  return datasets.map((dataset, datasetIndex) => {
    const storedColumns = buildStoredColumns(
      Array.isArray(dataset.columns) ? dataset.columns : []
    );
    const rawRecords = Array.isArray(dataset.records) ? dataset.records : [];
    const records = rawRecords
      .map((record) =>
        storedColumns.reduce<Record<string, string | string[] | number | boolean | null>>((acc, column) => {
          acc[column.name] = parseCellValue(
            readSerializableRecordCell(record, column),
            column.type
          );
          return acc;
        }, {})
      )
      .filter((record) =>
        Object.values(record).some(
          (value) => value !== null && String(value).trim().length > 0
        )
      );

    return {
      name: dataset.name.trim() || `Dataset ${datasetIndex + 1}`,
      notes: dataset.notes,
      columns: storedColumns.map(({ name, type }) => ({ name, type })),
      records,
    };
  });
}
