import type {
  ToolDispatchConfig,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolSaveTarget,
} from "@airlab/canvas-compiler/tool-types";
import {
  SUPPORTED_SETUP_TABLES,
  appendDatasetRuntimeRecord,
  coerceDatasetValue,
  createDatasetToolSupabaseClient,
  type DatasetToolSupabaseClient,
  findDatasetRuntimeTarget,
  findEnvironmentPlayerEntry,
  hasMeaningfulDatasetValue,
  normalizeDatasetKey,
  normalizeDatasetName,
  normalizeStoredDatasets,
  safeParseJsonArray,
  setupTableSupportsSharedDatasets,
  type DatasetRuntimeTarget,
  type DatasetRecordValue,
  type StoredDataset,
} from "./dataset-store";

const CONTENT_LIMIT = 8_000;

interface GuidelineBlock {
  topic: string;
  content: string;
  problem: string;
  recommendation: string;
}

function normalizeSaveTarget(raw: unknown): ToolSaveTarget {
  return raw === "dataset" ? "dataset" : "knowledge";
}

function buildTopic(toolName: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    parts.push(`${k}=${typeof v === "string" ? `"${v.slice(0, 40)}"` : JSON.stringify(v)}`);
    if (parts.join(", ").length > 80) break;
  }
  const summary = parts.join(", ");
  return summary ? `${toolName}(${summary})` : toolName;
}

function buildContent(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 1) {
    const value = args[keys[0]];
    if (typeof value === "string") return value.slice(0, CONTENT_LIMIT);
  }
  try {
    return JSON.stringify(args, null, 2).slice(0, CONTENT_LIMIT);
  } catch {
    return String(args).slice(0, CONTENT_LIMIT);
  }
}

function normalizeGuidelineBlocks(raw: unknown): GuidelineBlock[] {
  const items =
    Array.isArray(raw) ? raw : typeof raw === "string" ? safeParseJsonArray(raw) : [];

  return items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const value = item as Record<string, unknown>;
    return [
      {
        topic: typeof value.topic === "string" ? value.topic : "",
        content: typeof value.content === "string" ? value.content : "",
        problem: typeof value.problem === "string" ? value.problem : "",
        recommendation: typeof value.recommendation === "string" ? value.recommendation : "",
      },
    ];
  });
}

function readStoredArray(raw: unknown): unknown[] {
  return Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? safeParseJsonArray(raw)
      : [];
}

function findAgentBindingEntry(
  raw: unknown,
  agentId: string
): Record<string, unknown> | null {
  const normalized = agentId.trim();
  if (!normalized) {
    return null;
  }

  return (
    readStoredArray(raw).find(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).id === normalized
    ) as Record<string, unknown> | undefined
  ) ?? null;
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

async function loadAgentTemplateDefaultDatasets(
  supabase: DatasetToolSupabaseClient,
  templateVersionId: string
): Promise<StoredDataset[]> {
  if (!templateVersionId) {
    return [];
  }

  const { data, error } = await supabase
    .from("agent_template_versions")
    .select("default_datasets")
    .eq("id", templateVersionId)
    .maybeSingle();

  if (error || !data) {
    return [];
  }

  return normalizeStoredDatasets(data.default_datasets);
}

async function resolveAgentBindingDatasets(args: {
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

  return loadAgentTemplateDefaultDatasets(
    args.supabase,
    readAgentBindingTemplateVersionId(args.binding)
  );
}

function writeAgentBindingDatasetOverrides(args: {
  rawBindings: unknown;
  agentId: string;
  datasets: StoredDataset[];
}): unknown[] {
  return readStoredArray(args.rawBindings).map((entry) =>
    entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    (entry as Record<string, unknown>).id === args.agentId
      ? {
          ...(entry as Record<string, unknown>),
          dataset_overrides: args.datasets,
        }
      : entry
  );
}

async function saveToDomainKnowledge(
  args: Record<string, unknown>,
  context: ToolDispatchContext
): Promise<ToolDispatchResult> {
  try {
    const supabase = createDatasetToolSupabaseClient();
    if (context.configId) {
      const { data, error } = await supabase
        .from("sandbox_knowledge_blocks")
        .insert({
          config_id: context.configId,
          topic: buildTopic(context.toolName, args),
          content: buildContent(args),
          sort_order: Math.floor(Date.now() / 1000),
        })
        .select()
        .single();

      if (error) {
        return { ok: false, error: `${error.code ?? "insert_error"}: ${error.message}` };
      }
      return { ok: true, data };
    }

    if (!context.setupTable || !context.setupId) {
      return {
        ok: false,
        error: "knowledge_save: no setup or sandbox context was provided.",
      };
    }

    if (!SUPPORTED_SETUP_TABLES.has(context.setupTable)) {
      return {
        ok: false,
        error: `knowledge save is not enabled for setup table "${context.setupTable}".`,
      };
    }

    const { data: row, error: loadError } = await supabase
      .from(context.setupTable)
      .select("guideline_blocks")
      .eq("id", context.setupId)
      .single();

    if (loadError || !row) {
      return {
        ok: false,
        error: `${loadError?.code ?? "load_error"}: ${loadError?.message ?? "Setup not found"}`,
      };
    }

    const nextBlock: GuidelineBlock = {
      topic: buildTopic(context.toolName, args),
      content: buildContent(args),
      problem: "",
      recommendation: "",
    };
    const nextBlocks = [...normalizeGuidelineBlocks(row.guideline_blocks), nextBlock];
    const { error: updateError } = await supabase
      .from(context.setupTable)
      .update({ guideline_blocks: nextBlocks })
      .eq("id", context.setupId);

    if (updateError) {
      return {
        ok: false,
        error: `${updateError.code ?? "update_error"}: ${updateError.message}`,
      };
    }

    return { ok: true, data: nextBlock };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown knowledge_save error",
    };
  }
}

function buildDatasetRecord(
  dataset: StoredDataset,
  args: Record<string, unknown>
):
  | {
      record: Record<string, DatasetRecordValue>;
      error?: never;
    }
  | {
      record?: never;
      error: string;
    } {
  const argEntries = new Map(
    Object.entries(args).map(([key, value]) => [normalizeDatasetKey(key), value] as const)
  );

  const fallbackSingleValue =
    dataset.columns.length === 1 && Object.keys(args).length === 1
      ? Object.values(args)[0]
      : undefined;

  const record = dataset.columns.reduce<Record<string, DatasetRecordValue>>((acc, column) => {
    const directValue = argEntries.get(normalizeDatasetKey(column.name));
    const value = directValue === undefined ? fallbackSingleValue : directValue;
    acc[column.name] = coerceDatasetValue(value, column.type);
    return acc;
  }, {});

  if (!hasMeaningfulDatasetValue(record)) {
    const receivedKeys = Object.keys(args);
    const columnNames = dataset.columns.map((column) => column.name);
    return {
      error:
        `tool arguments did not contain any values matching the selected dataset columns. ` +
        `Received argument keys: ${receivedKeys.length > 0 ? receivedKeys.join(", ") : "(none)"}. ` +
        `Dataset "${dataset.name}" columns: ${columnNames.join(", ")}. ` +
        `Name tool parameters after dataset columns, or pass exactly one argument when the dataset has a single column.`,
    };
  }

  return { record };
}

async function reportDatasetSave(args: {
  context: ToolDispatchContext;
  datasetName: string;
  record: Record<string, DatasetRecordValue>;
  scope: "primary" | "player" | "shared";
  environmentPlayerId?: string;
}): Promise<void> {
  try {
    await args.context.onDatasetSave?.({
      datasetName: args.datasetName,
      record: args.record,
      setupTable: args.context.setupTable,
      setupId: args.context.setupId,
      scope: args.scope,
      ...(args.environmentPlayerId
        ? { environmentPlayerId: args.environmentPlayerId }
        : {}),
    });
  } catch (callbackError) {
    console.error("[knowledge-save] onDatasetSave callback failed", callbackError);
  }
}

async function persistDatasetRecordToStoredDraft(args: {
  context: ToolDispatchContext;
  datasetName: string;
  record: Record<string, DatasetRecordValue>;
  scope: "primary" | "player" | "shared";
  environmentPlayerId?: string;
}): Promise<string | null> {
  if (!args.context.setupTable || !args.context.setupId) {
    return null;
  }

  if (!SUPPORTED_SETUP_TABLES.has(args.context.setupTable)) {
    return `dataset save is not enabled for setup table "${args.context.setupTable}".`;
  }

  const supabase = createDatasetToolSupabaseClient();
  const supportsSharedTier = setupTableSupportsSharedDatasets(args.context.setupTable);
  if (args.scope === "shared" && !supportsSharedTier) {
    return `setup table "${args.context.setupTable}" does not support shared datasets.`;
  }

  const selectColumns = [
    "datasets",
    ...(supportsSharedTier ? ["shared_datasets"] : []),
    ...(args.scope === "player"
      ? ["environment_players", "agent_bindings"]
      : []),
  ].join(", ");
  const { data: row, error: loadError } = await supabase
    .from(args.context.setupTable)
    .select(selectColumns)
    .eq("id", args.context.setupId)
    .single();

  if (loadError || !row) {
    return `${loadError?.code ?? "load_error"}: ${loadError?.message ?? "Setup not found"}`;
  }

  const findDatasetIndex = (datasets: StoredDataset[]) =>
    datasets.findIndex(
      (dataset) =>
        normalizeDatasetKey(dataset.name) === normalizeDatasetKey(args.datasetName)
    );
  const appendRecord = (datasets: StoredDataset[]) => {
    const datasetIndex = findDatasetIndex(datasets);
    if (datasetIndex < 0) {
      return null;
    }

    const nextDatasets = [...datasets];
    nextDatasets[datasetIndex] = {
      ...nextDatasets[datasetIndex],
      records: [...nextDatasets[datasetIndex].records, args.record],
    };
    return nextDatasets;
  };

  let updatePayload: Record<string, unknown> | null = null;
  if (args.scope === "player") {
    const playerEntry = findEnvironmentPlayerEntry(
      row.environment_players,
      args.environmentPlayerId ?? ""
    );
    const bindingEntry = playerEntry
      ? null
      : findAgentBindingEntry(row.agent_bindings, args.environmentPlayerId ?? "");
    const ownDatasets = playerEntry
      ? normalizeStoredDatasets(playerEntry.datasets)
      : await resolveAgentBindingDatasets({
          supabase,
          binding: bindingEntry,
        });
    const nextDatasets = appendRecord(ownDatasets);
    if (!nextDatasets) {
      return `dataset "${args.datasetName}" was not found on the saved target agent.`;
    }
    updatePayload = playerEntry
      ? {
          environment_players: readStoredArray(row.environment_players).map((entry) =>
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            (entry as Record<string, unknown>).id === args.environmentPlayerId
              ? { ...(entry as Record<string, unknown>), datasets: nextDatasets }
              : entry
          ),
        }
      : {
          agent_bindings: writeAgentBindingDatasetOverrides({
            rawBindings: row.agent_bindings,
            agentId: args.environmentPlayerId ?? "",
            datasets: nextDatasets,
          }),
        };
  } else if (args.scope === "shared") {
    const nextDatasets = appendRecord(normalizeStoredDatasets(row.shared_datasets));
    if (!nextDatasets) {
      return `dataset "${args.datasetName}" was not found in saved shared datasets.`;
    }
    updatePayload = { shared_datasets: nextDatasets };
  } else {
    const nextDatasets = appendRecord(normalizeStoredDatasets(row.datasets));
    if (!nextDatasets) {
      return `dataset "${args.datasetName}" was not found in saved primary datasets.`;
    }
    updatePayload = { datasets: nextDatasets };
  }

  const { error: updateError } = await supabase
    .from(args.context.setupTable)
    .update(updatePayload)
    .eq("id", args.context.setupId);

  return updateError
    ? `${updateError.code ?? "update_error"}: ${updateError.message}`
    : null;
}

async function saveToRuntimeDataset(
  target: DatasetRuntimeTarget,
  args: Record<string, unknown>,
  context: ToolDispatchContext
): Promise<ToolDispatchResult> {
  const built = buildDatasetRecord(target.dataset, args);
  if ("error" in built) {
    return { ok: false, error: built.error };
  }

  appendDatasetRuntimeRecord(target, built.record);

  await reportDatasetSave({
    context,
    datasetName: target.dataset.name,
    record: built.record,
    scope: target.scope,
    environmentPlayerId: target.environmentPlayerId,
  });

  try {
    const persistError = await persistDatasetRecordToStoredDraft({
      context,
      datasetName: target.dataset.name,
      record: built.record,
      scope: target.scope,
      environmentPlayerId: target.environmentPlayerId,
    });
    if (persistError) {
      console.warn(
        `[knowledge-save] dataset write kept in request snapshot but was not persisted: ${persistError}`
      );
    }
  } catch (persistError) {
    console.warn(
      "[knowledge-save] dataset write kept in request snapshot but persistence failed",
      persistError
    );
  }

  return {
    ok: true,
    data: {
      dataset: target.dataset.name,
      record: built.record,
    },
  };
}

async function saveToDataset(
  config: ToolDispatchConfig,
  args: Record<string, unknown>,
  context: ToolDispatchContext
): Promise<ToolDispatchResult> {
  const datasetName = normalizeDatasetName(config.datasetName);
  if (!datasetName) {
    return {
      ok: false,
      error: "dataset save requires a dataset name in the tool configuration.",
    };
  }

  if (context.datasetRuntime) {
    const target = findDatasetRuntimeTarget(
      context.datasetRuntime,
      datasetName,
      context.environmentPlayerId
    );
    if (!target) {
      return {
        ok: false,
        error: `dataset "${datasetName}" was not found in the current setup.`,
      };
    }

    return saveToRuntimeDataset(target, args, context);
  }

  if (!context.setupTable || !context.setupId) {
    return {
      ok: false,
      error: "dataset save requires a demo setup context.",
    };
  }

  if (!SUPPORTED_SETUP_TABLES.has(context.setupTable)) {
    return {
      ok: false,
      error: `dataset save is not enabled for setup table "${context.setupTable}".`,
    };
  }

  try {
    const supabase = createDatasetToolSupabaseClient();
    const supportsSharedTier = setupTableSupportsSharedDatasets(context.setupTable);
    const selectColumns = [
      "datasets",
      ...(supportsSharedTier ? ["shared_datasets"] : []),
      ...(context.environmentPlayerId
        ? ["environment_players", "agent_bindings"]
        : []),
    ].join(", ");
    const { data: row, error: loadError } = await supabase
      .from(context.setupTable)
      .select(selectColumns)
      .eq("id", context.setupId)
      .single();

    if (loadError || !row) {
      return {
        ok: false,
        error: `${loadError?.code ?? "load_error"}: ${loadError?.message ?? "Setup not found"}`,
      };
    }

    // Resolve the dataset in the writing agent's own tier first (the
    // environment player's datasets, or the row's top-level datasets for the
    // primary agent), then fall back to the draft's shared datasets.
    const playerEntry = context.environmentPlayerId
      ? findEnvironmentPlayerEntry(row.environment_players, context.environmentPlayerId)
      : null;
    const bindingEntry =
      context.environmentPlayerId && !playerEntry
        ? findAgentBindingEntry(row.agent_bindings, context.environmentPlayerId)
        : null;
    const ownDatasets = context.environmentPlayerId
      ? playerEntry
        ? normalizeStoredDatasets(playerEntry.datasets)
        : await resolveAgentBindingDatasets({
            supabase,
            binding: bindingEntry,
          })
      : normalizeStoredDatasets(row.datasets);
    const sharedDatasets = supportsSharedTier
      ? normalizeStoredDatasets(row.shared_datasets)
      : [];
    const findDatasetIndex = (list: typeof ownDatasets) =>
      list.findIndex(
        (dataset) =>
          normalizeDatasetKey(dataset.name) === normalizeDatasetKey(datasetName)
      );

    const ownIndex = findDatasetIndex(ownDatasets);
    const sharedIndex = ownIndex >= 0 ? -1 : findDatasetIndex(sharedDatasets);
    if (ownIndex < 0 && sharedIndex < 0) {
      return {
        ok: false,
        error: `dataset "${datasetName}" was not found in the current setup.`,
      };
    }

    const writeScope: "player" | "primary" | "shared" =
      ownIndex >= 0
        ? context.environmentPlayerId
          ? "player"
          : "primary"
        : "shared";
    const datasets = ownIndex >= 0 ? ownDatasets : sharedDatasets;
    const datasetIndex = ownIndex >= 0 ? ownIndex : sharedIndex;

    const dataset = datasets[datasetIndex];
    const argEntries = new Map(
      Object.entries(args).map(([key, value]) => [normalizeDatasetKey(key), value] as const)
    );

    const fallbackSingleValue =
      dataset.columns.length === 1 && Object.keys(args).length === 1
        ? Object.values(args)[0]
        : undefined;

    const record = dataset.columns.reduce<Record<string, DatasetRecordValue>>((acc, column) => {
      const directValue = argEntries.get(normalizeDatasetKey(column.name));
      const value = directValue === undefined ? fallbackSingleValue : directValue;
      acc[column.name] = coerceDatasetValue(value, column.type);
      return acc;
    }, {});

    if (!hasMeaningfulDatasetValue(record)) {
      const receivedKeys = Object.keys(args);
      const columnNames = dataset.columns.map((column) => column.name);
      return {
        ok: false,
        error:
          `tool arguments did not contain any values matching the selected dataset columns. ` +
          `Received argument keys: ${receivedKeys.length > 0 ? receivedKeys.join(", ") : "(none)"}. ` +
          `Dataset "${dataset.name}" columns: ${columnNames.join(", ")}. ` +
          `Name tool parameters after dataset columns, or pass exactly one argument when the dataset has a single column.`,
      };
    }

    const nextDatasets = [...datasets];
    nextDatasets[datasetIndex] = {
      ...dataset,
      records: [...dataset.records, record],
    };

    const updatePayload =
      writeScope === "player"
        ? playerEntry
          ? {
              environment_players: readStoredArray(row.environment_players).map(
                (entry) =>
                  entry &&
                  typeof entry === "object" &&
                  !Array.isArray(entry) &&
                  (entry as Record<string, unknown>).id ===
                    context.environmentPlayerId
                    ? {
                        ...(entry as Record<string, unknown>),
                        datasets: nextDatasets,
                      }
                    : entry
              ),
            }
          : {
              agent_bindings: writeAgentBindingDatasetOverrides({
                rawBindings: row.agent_bindings,
                agentId: context.environmentPlayerId ?? "",
                datasets: nextDatasets,
              }),
            }
        : writeScope === "shared"
          ? { shared_datasets: nextDatasets }
          : { datasets: nextDatasets };

    const { error: updateError } = await supabase
      .from(context.setupTable)
      .update(updatePayload)
      .eq("id", context.setupId);

    if (updateError) {
      return {
        ok: false,
        error: `${updateError.code ?? "update_error"}: ${updateError.message}`,
      };
    }

    // The write is already committed — a reporting-callback failure must not
    // turn it into a tool error.
    try {
      await context.onDatasetSave?.({
        datasetName: dataset.name,
        record,
        setupTable: context.setupTable,
        setupId: context.setupId,
        scope: writeScope,
        ...(writeScope === "player"
          ? { environmentPlayerId: context.environmentPlayerId }
          : {}),
      });
    } catch (callbackError) {
      console.error("[knowledge-save] onDatasetSave callback failed", callbackError);
    }

    return {
      ok: true,
      data: {
        dataset: dataset.name,
        record,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown dataset save error",
    };
  }
}

export async function savePostedToolData(
  config: ToolDispatchConfig,
  args: Record<string, unknown>,
  context: ToolDispatchContext
): Promise<ToolDispatchResult> {
  return normalizeSaveTarget(config.saveTarget) === "dataset"
    ? saveToDataset(config, args, context)
    : saveToDomainKnowledge(args, context);
}
