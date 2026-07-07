import type { OrchestrationProject } from "./general-orchestration";
import { materializeLegacyProjectAgentTemplate } from "./project-agent-template-materialization";
import {
  normalizeDaemonDraftState,
  normalizeDaemonDraftMessages,
  GENERAL_ORCHESTRATION_DAEMON_DRAFT_ENDPOINT,
  GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE,
  buildDaemonDraftSummary,
  hydrateDaemonDraft,
  serializeDaemonDraft,
  type DaemonDraftState,
  type DaemonDraftMessage,
  type DaemonDraftInteractionMode,
  type DaemonDraftSummary,
  type GeneralOrchestrationDaemonDraftRow,
} from "./general-orchestration-daemon-drafts";
import type { StoredOrchestrationCanvasRow } from "./orchestration-project-storage";

export interface DaemonDraftStoreSupabaseClient {
  from: (table: string) => any;
}

type SupabaseClient = DaemonDraftStoreSupabaseClient;
type CanvasTable = "policy_canvases" | "state_policy_canvases";

const DAEMON_DRAFT_SELECT_BASE =
  "id, expert_id, endpoint, config_name, route_slug, setup_summary, policy_intent, workspace_status, state_schema, state_update_prompt, policy_prompt, guideline_blocks, datasets, shared_datasets, interaction_protocol, environment_players, uploaded_files, daemon_state, conversation_messages, created_at, updated_at";
const DAEMON_DRAFT_SELECT_BASE_WITH_INTERACTION_MODE =
  "id, expert_id, endpoint, config_name, route_slug, setup_summary, policy_intent, workspace_status, interaction_mode, state_schema, state_update_prompt, policy_prompt, guideline_blocks, datasets, shared_datasets, interaction_protocol, environment_players, uploaded_files, daemon_state, conversation_messages, created_at, updated_at";
const DAEMON_DRAFT_SELECT_WITH_SKILLS =
  "id, expert_id, endpoint, agent_id, config_name, route_slug, setup_summary, policy_intent, workspace_status, state_schema, state_update_prompt, policy_prompt, guideline_blocks, datasets, shared_datasets, interaction_protocol, skills, agent_bindings, agent_connections, environment_players, uploaded_files, daemon_state, conversation_messages, created_at, updated_at";
const DAEMON_DRAFT_SELECT_WITH_SKILLS_AND_INTERACTION_MODE =
  "id, expert_id, endpoint, agent_id, config_name, route_slug, setup_summary, policy_intent, workspace_status, interaction_mode, state_schema, state_update_prompt, policy_prompt, guideline_blocks, datasets, shared_datasets, interaction_protocol, skills, agent_bindings, agent_connections, environment_players, uploaded_files, daemon_state, conversation_messages, created_at, updated_at";

function isMissingSkillsColumnError(error: { message?: string } | null | undefined) {
  const message = (error?.message ?? "").toLowerCase();
  return (
    message.includes(`${GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE}.skills`) ||
    (message.includes("skills") &&
      message.includes(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)) ||
    (message.includes("skills") && message.includes("schema cache"))
  );
}

function isMissingAgentEcosystemColumnError(
  error: { message?: string } | null | undefined
) {
  const message = (error?.message ?? "").toLowerCase();
  return (
    message.includes(`${GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE}.agent_id`) ||
    message.includes(
      `${GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE}.agent_connections`
    ) ||
    message.includes(
      `${GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE}.agent_bindings`
    ) ||
    (message.includes("agent_id") &&
      message.includes(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)) ||
    (message.includes("agent_bindings") &&
      message.includes(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)) ||
    (message.includes("agent_connections") &&
      message.includes(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)) ||
    (message.includes("agent_id") && message.includes("schema cache")) ||
    (message.includes("agent_bindings") && message.includes("schema cache")) ||
    (message.includes("agent_connections") && message.includes("schema cache"))
  );
}

function isMissingInteractionModeColumnError(
  error: { message?: string } | null | undefined
) {
  const message = (error?.message ?? "").toLowerCase();
  return (
    message.includes(
      `${GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE}.interaction_mode`
    ) ||
    (message.includes("interaction_mode") &&
      message.includes(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)) ||
    (message.includes("interaction_mode") && message.includes("schema cache"))
  );
}

function isMissingOptionalDraftColumnError(
  error: { message?: string } | null | undefined
) {
  return (
    isMissingSkillsColumnError(error) ||
    isMissingAgentEcosystemColumnError(error) ||
    isMissingInteractionModeColumnError(error)
  );
}

function readLegacyInteractionModeFromDaemonState(
  daemonState: unknown
): DaemonDraftInteractionMode {
  let parsed = daemonState;
  if (typeof parsed === "string" && parsed.trim()) {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      parsed = null;
    }
  }
  const mode =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).daemon_interaction_mode
      : null;
  return mode === "automated" || mode === "lazy" ? mode : "chat";
}

function withMissingOptionalDraftDefaults(
  row: GeneralOrchestrationDaemonDraftRow
): GeneralOrchestrationDaemonDraftRow {
  return {
    ...row,
    skills: row.skills ?? [],
    agent_id: row.agent_id ?? row.id ?? null,
    agent_bindings: row.agent_bindings ?? [],
    agent_connections: row.agent_connections ?? [],
    interaction_mode:
      row.interaction_mode ??
      readLegacyInteractionModeFromDaemonState(row.daemon_state),
  };
}

function buildDraftInsertPayload(args: {
  config: ReturnType<typeof serializeDaemonDraft>["config"];
  userUUID: string;
  now: string;
  includeSkills: boolean;
  includeAgentEcosystem: boolean;
  includeInteractionMode: boolean;
}) {
  const config = { ...args.config };
  if (!args.includeInteractionMode) {
    delete (config as Partial<typeof config>).interaction_mode;
  }
  if (!args.includeSkills) {
    delete (config as Partial<typeof config>).skills;
  }
  if (!args.includeAgentEcosystem) {
    delete (config as Partial<typeof config>).agent_id;
    delete (config as Partial<typeof config>).agent_bindings;
    delete (config as Partial<typeof config>).agent_connections;
  }

  return {
    ...config,
    expert_id: args.userUUID,
    endpoint: GENERAL_ORCHESTRATION_DAEMON_DRAFT_ENDPOINT,
    updated_at: args.now,
  };
}

function buildDraftUpdatePayload(args: {
  config: ReturnType<typeof serializeDaemonDraft>["config"];
  daemonStateWasProvided: boolean;
  now: string;
  includeSkills: boolean;
  includeAgentEcosystem: boolean;
  includeInteractionMode: boolean;
}) {
  return {
    ...(args.includeAgentEcosystem
      ? {
          agent_id: args.config.agent_id,
          agent_bindings: args.config.agent_bindings,
          agent_connections: args.config.agent_connections,
        }
      : {}),
    config_name: args.config.config_name,
    route_slug: args.config.route_slug,
    setup_summary: args.config.setup_summary,
    policy_intent: args.config.policy_intent,
    workspace_status: args.config.workspace_status,
    ...(args.includeInteractionMode
      ? { interaction_mode: args.config.interaction_mode }
      : {}),
    uploaded_files: args.config.uploaded_files,
    state_schema: args.config.state_schema,
    state_update_prompt: args.config.state_update_prompt,
    policy_prompt: args.config.policy_prompt,
    guideline_blocks: args.config.guideline_blocks,
    datasets: args.config.datasets,
    shared_datasets: args.config.shared_datasets,
    interaction_protocol: args.config.interaction_protocol,
    ...(args.includeSkills ? { skills: args.config.skills } : {}),
    environment_players: args.config.environment_players,
    updated_at: args.now,
    ...(args.daemonStateWasProvided
      ? { daemon_state: args.config.daemon_state }
      : {}),
    conversation_messages: args.config.conversation_messages,
  };
}

type DraftOptionalColumnFlags = {
  includeSkills: boolean;
  includeAgentEcosystem: boolean;
  includeInteractionMode: boolean;
};

const DRAFT_OPTIONAL_COLUMN_ATTEMPTS: DraftOptionalColumnFlags[] = [
  {
    includeSkills: true,
    includeAgentEcosystem: true,
    includeInteractionMode: true,
  },
  {
    includeSkills: true,
    includeAgentEcosystem: true,
    includeInteractionMode: false,
  },
  {
    includeSkills: false,
    includeAgentEcosystem: false,
    includeInteractionMode: true,
  },
  {
    includeSkills: false,
    includeAgentEcosystem: false,
    includeInteractionMode: false,
  },
];

function selectDraftColumns(flags: DraftOptionalColumnFlags): string {
  if (flags.includeSkills && flags.includeInteractionMode) {
    return DAEMON_DRAFT_SELECT_WITH_SKILLS_AND_INTERACTION_MODE;
  }
  if (flags.includeSkills) {
    return DAEMON_DRAFT_SELECT_WITH_SKILLS;
  }
  if (flags.includeInteractionMode) {
    return DAEMON_DRAFT_SELECT_BASE_WITH_INTERACTION_MODE;
  }
  return DAEMON_DRAFT_SELECT_BASE;
}

async function updateDraftRowWithOptionalColumnFallback(args: {
  supabase: SupabaseClient;
  draftId: string;
  config: ReturnType<typeof serializeDaemonDraft>["config"];
  daemonStateWasProvided: boolean;
  now: string;
}): Promise<void> {
  let lastError: { message?: string } | null = null;

  for (const flags of DRAFT_OPTIONAL_COLUMN_ATTEMPTS) {
    const { error } = await args.supabase
      .from(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
      .update(
        buildDraftUpdatePayload({
          config: args.config,
          daemonStateWasProvided: args.daemonStateWasProvided,
          now: args.now,
          ...flags,
        })
      )
      .eq("id", args.draftId);

    if (!error) {
      return;
    }

    if (!isMissingOptionalDraftColumnError(error)) {
      throw new Error(error.message);
    }

    lastError = error;
  }

  throw new Error(lastError?.message ?? "Failed to update daemon draft.");
}

async function fetchCanvasRows(
  supabase: SupabaseClient,
  table: CanvasTable,
  draftId: string
): Promise<StoredOrchestrationCanvasRow[]> {
  const { data, error } = await supabase
    .from(table)
    .select("canvas_id, name, sort_order, canvas")
    .eq("setup_table", GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
    .eq("setup_id", draftId)
    .order("sort_order", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as StoredOrchestrationCanvasRow[];
}

async function replaceCanvasRows(
  supabase: SupabaseClient,
  table: CanvasTable,
  draftId: string,
  rows: StoredOrchestrationCanvasRow[]
) {
  const { error: deleteError } = await supabase
    .from(table)
    .delete()
    .eq("setup_table", GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
    .eq("setup_id", draftId);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  if (rows.length === 0) {
    return;
  }

  const { error: insertError } = await supabase.from(table).upsert(
    rows.map((row, index) => ({
      setup_table: GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE,
      setup_id: draftId,
      canvas_id: row.canvas_id,
      name: row.name,
      sort_order: row.sort_order ?? index,
      canvas: row.canvas,
    })),
    { onConflict: "setup_table,setup_id,canvas_id" }
  );

  if (insertError) {
    throw new Error(insertError.message);
  }
}

function hasLegacyPrimaryCanvasDefaults(project: OrchestrationProject): boolean {
  return Boolean(
    project.stateUpdatePrompt.trim() ||
      project.policyPrompt.trim() ||
      project.policyCanvases?.canvases.length ||
      project.statePolicyCanvases?.canvases.length
  );
}

async function persistLoadedDraftMigration(args: {
  supabase: SupabaseClient;
  draftId: string;
  project: OrchestrationProject;
  messages: DaemonDraftMessage[];
  daemonState: DaemonDraftState | null;
  interactionMode: DaemonDraftInteractionMode;
}) {
  const serialized = serializeDaemonDraft(
    args.project,
    args.messages,
    args.daemonState,
    args.interactionMode
  );
  const now = new Date().toISOString();

  await updateDraftRowWithOptionalColumnFallback({
    supabase: args.supabase,
    draftId: args.draftId,
    config: serialized.config,
    daemonStateWasProvided: true,
    now,
  });

  await Promise.all([
    replaceCanvasRows(
      args.supabase,
      "policy_canvases",
      args.draftId,
      serialized.policyCanvases
    ),
    replaceCanvasRows(
      args.supabase,
      "state_policy_canvases",
      args.draftId,
      serialized.statePolicyCanvases
    ),
  ]);
}

function normalizeMessages(messages: DaemonDraftMessage[] | undefined): DaemonDraftMessage[] {
  return messages ?? [];
}

export async function listDaemonDrafts(
  supabase: SupabaseClient,
  userUUID: string
): Promise<DaemonDraftSummary[]> {
  const initialResult = await supabase
    .from(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
    .select("id, config_name, route_slug, setup_summary, workspace_status, interaction_mode, updated_at")
    .eq("expert_id", userUUID)
    .eq("endpoint", GENERAL_ORCHESTRATION_DAEMON_DRAFT_ENDPOINT)
    .order("updated_at", { ascending: false });
  let data = initialResult.data as GeneralOrchestrationDaemonDraftRow[] | null;
  let error = initialResult.error;

  if (error && isMissingInteractionModeColumnError(error)) {
    const retry = await supabase
      .from(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
      .select("id, config_name, route_slug, setup_summary, workspace_status, daemon_state, updated_at")
      .eq("expert_id", userUUID)
      .eq("endpoint", GENERAL_ORCHESTRATION_DAEMON_DRAFT_ENDPOINT)
      .order("updated_at", { ascending: false });
    data = retry.data as GeneralOrchestrationDaemonDraftRow[] | null;
    error = retry.error;
  }

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? [])
    .map(withMissingOptionalDraftDefaults)
    .map(buildDaemonDraftSummary);
}

export async function loadDaemonDraft(
  supabase: SupabaseClient,
  userUUID: string,
  draftId: string
) {
  let data: GeneralOrchestrationDaemonDraftRow | null = null;
  let error: { message: string } | null = null;

  for (const flags of DRAFT_OPTIONAL_COLUMN_ATTEMPTS) {
    const result = await supabase
      .from(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
      .select(selectDraftColumns(flags))
      .eq("id", draftId)
      .eq("expert_id", userUUID)
      .eq("endpoint", GENERAL_ORCHESTRATION_DAEMON_DRAFT_ENDPOINT)
      .maybeSingle();
    if (!result.error) {
      data = result.data
        ? withMissingOptionalDraftDefaults(
            result.data as GeneralOrchestrationDaemonDraftRow
          )
        : null;
      error = null;
      break;
    }
    if (!isMissingOptionalDraftColumnError(result.error)) {
      error = result.error;
      break;
    }
    error = result.error;
  }

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    return null;
  }

  const [policyCanvases, statePolicyCanvases] = await Promise.all([
    fetchCanvasRows(supabase, "policy_canvases", draftId),
    fetchCanvasRows(supabase, "state_policy_canvases", draftId),
  ]);

  const hydrated = hydrateDaemonDraft({
    config: withMissingOptionalDraftDefaults(
      data as GeneralOrchestrationDaemonDraftRow
    ),
    policyCanvases,
    statePolicyCanvases,
  });
  const project = await materializeLegacyProjectAgentTemplate({
    project: hydrated.project,
    ownerId: userUUID,
    supabase,
  });
  if (
    hasLegacyPrimaryCanvasDefaults(hydrated.project) &&
    !hasLegacyPrimaryCanvasDefaults(project)
  ) {
    await persistLoadedDraftMigration({
      supabase,
      draftId,
      project,
      messages: hydrated.messages,
      daemonState: hydrated.daemonState,
      interactionMode: hydrated.interactionMode,
    });
  }

  return {
    ...hydrated,
    project,
  };
}

export async function loadDaemonDraftState(
  supabase: SupabaseClient,
  userUUID: string,
  draftId: string
): Promise<DaemonDraftState | null> {
  const { data, error } = await supabase
    .from(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
    .select("daemon_state")
    .eq("id", draftId)
    .eq("expert_id", userUUID)
    .eq("endpoint", GENERAL_ORCHESTRATION_DAEMON_DRAFT_ENDPOINT)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return normalizeDaemonDraftState(data?.daemon_state);
}

export async function createDaemonDraft(args: {
  supabase: SupabaseClient;
  userUUID: string;
  project: OrchestrationProject;
  messages?: DaemonDraftMessage[];
  daemonState?: DaemonDraftState | null;
  interactionMode?: DaemonDraftInteractionMode;
}) {
  const messages = normalizeMessages(args.messages);
  const project = await materializeLegacyProjectAgentTemplate({
    project: args.project,
    ownerId: args.userUUID,
    supabase: args.supabase,
  });
  const serialized = serializeDaemonDraft(
    project,
    messages,
    args.daemonState,
    args.interactionMode ?? "chat"
  );
  const now = new Date().toISOString();

  let data: GeneralOrchestrationDaemonDraftRow | null = null;
  let error: { message: string } | null = null;

  for (const flags of DRAFT_OPTIONAL_COLUMN_ATTEMPTS) {
    const result = await args.supabase
      .from(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
      .insert(
        buildDraftInsertPayload({
          config: serialized.config,
          userUUID: args.userUUID,
          now,
          ...flags,
        })
      )
      .select(selectDraftColumns(flags))
      .single();
    if (!result.error) {
      data = result.data
        ? withMissingOptionalDraftDefaults(
            result.data as GeneralOrchestrationDaemonDraftRow
          )
        : null;
      error = null;
      break;
    }
    if (!isMissingOptionalDraftColumnError(result.error)) {
      error = result.error;
      break;
    }
    error = result.error;
  }

  if (error || !data) {
    throw new Error(error?.message ?? "Failed to create daemon draft.");
  }

  const draftId = String(data.id);

  await Promise.all([
    replaceCanvasRows(args.supabase, "policy_canvases", draftId, serialized.policyCanvases),
    replaceCanvasRows(
      args.supabase,
      "state_policy_canvases",
      draftId,
      serialized.statePolicyCanvases
    ),
  ]);

  return {
    id: draftId,
    project: serialized.project,
    daemonState: normalizeDaemonDraftState((data as GeneralOrchestrationDaemonDraftRow).daemon_state),
    messages,
    summary: buildDaemonDraftSummary({
      id: draftId,
      config_name: serialized.config.config_name,
      route_slug: serialized.config.route_slug,
      setup_summary: serialized.config.setup_summary,
      workspace_status: serialized.config.workspace_status,
      interaction_mode: serialized.config.interaction_mode,
      updated_at: now,
    }),
    interactionMode: serialized.config.interaction_mode,
  };
}

export async function saveDaemonDraft(args: {
  supabase: SupabaseClient;
  userUUID: string;
  draftId: string;
  project: OrchestrationProject;
  messages?: DaemonDraftMessage[];
  daemonState?: DaemonDraftState | null;
  interactionMode?: DaemonDraftInteractionMode;
}) {
  const now = new Date().toISOString();

  const initialOwnershipResult = await args.supabase
    .from(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
    .select("id, daemon_state, conversation_messages, interaction_mode")
    .eq("id", args.draftId)
    .eq("expert_id", args.userUUID)
    .eq("endpoint", GENERAL_ORCHESTRATION_DAEMON_DRAFT_ENDPOINT)
    .maybeSingle();
  let owned =
    initialOwnershipResult.data as GeneralOrchestrationDaemonDraftRow | null;
  let ownError = initialOwnershipResult.error;

  if (ownError && isMissingInteractionModeColumnError(ownError)) {
    const retry = await args.supabase
      .from(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
      .select("id, daemon_state, conversation_messages")
      .eq("id", args.draftId)
      .eq("expert_id", args.userUUID)
      .eq("endpoint", GENERAL_ORCHESTRATION_DAEMON_DRAFT_ENDPOINT)
      .maybeSingle();
    owned = retry.data
      ? withMissingOptionalDraftDefaults(
          retry.data as GeneralOrchestrationDaemonDraftRow
        )
      : null;
    ownError = retry.error;
  }

  if (ownError) {
    throw new Error(ownError.message);
  }

  if (!owned) {
    return null;
  }

  const ownedRow = owned as GeneralOrchestrationDaemonDraftRow;
  const messages =
    args.messages !== undefined
      ? normalizeMessages(args.messages)
      : normalizeDaemonDraftMessages(ownedRow.conversation_messages);
  const project = await materializeLegacyProjectAgentTemplate({
    project: args.project,
    ownerId: args.userUUID,
    supabase: args.supabase,
  });
  const serialized = serializeDaemonDraft(
    project,
    messages,
    args.daemonState,
    args.interactionMode ??
      (ownedRow.interaction_mode === "automated" ||
      ownedRow.interaction_mode === "lazy"
        ? ownedRow.interaction_mode
        : "chat")
  );

  await updateDraftRowWithOptionalColumnFallback({
    supabase: args.supabase,
    draftId: args.draftId,
    config: serialized.config,
    daemonStateWasProvided: args.daemonState !== undefined,
    now,
  });

  await Promise.all([
    replaceCanvasRows(args.supabase, "policy_canvases", args.draftId, serialized.policyCanvases),
    replaceCanvasRows(
      args.supabase,
      "state_policy_canvases",
      args.draftId,
      serialized.statePolicyCanvases
    ),
  ]);

  return {
    id: args.draftId,
    project: serialized.project,
    daemonState:
      args.daemonState !== undefined
        ? args.daemonState
        : normalizeDaemonDraftState(ownedRow.daemon_state),
    messages,
    summary: buildDaemonDraftSummary({
      id: args.draftId,
      config_name: serialized.config.config_name,
      route_slug: serialized.config.route_slug,
      setup_summary: serialized.config.setup_summary,
      workspace_status: serialized.config.workspace_status,
      interaction_mode: serialized.config.interaction_mode,
      updated_at: now,
    }),
    interactionMode: serialized.config.interaction_mode,
  };
}

export async function verifyDaemonDraftOwnership(
  supabase: SupabaseClient,
  userUUID: string,
  draftId: string
): Promise<boolean> {
  const { data: owned, error: ownError } = await supabase
    .from(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
    .select("id")
    .eq("id", draftId)
    .eq("expert_id", userUUID)
    .eq("endpoint", GENERAL_ORCHESTRATION_DAEMON_DRAFT_ENDPOINT)
    .maybeSingle();

  if (ownError) {
    throw new Error(ownError.message);
  }

  return Boolean(owned);
}

export async function deleteDaemonDraft(
  supabase: SupabaseClient,
  userUUID: string,
  draftId: string
) {
  const { data: owned, error: ownError } = await supabase
    .from(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
    .select("id")
    .eq("id", draftId)
    .eq("expert_id", userUUID)
    .eq("endpoint", GENERAL_ORCHESTRATION_DAEMON_DRAFT_ENDPOINT)
    .maybeSingle();

  if (ownError) {
    throw new Error(ownError.message);
  }

  if (!owned) {
    return false;
  }

  await Promise.all([
    supabase
      .from("policy_canvases")
      .delete()
      .eq("setup_table", GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
      .eq("setup_id", draftId),
    supabase
      .from("state_policy_canvases")
      .delete()
      .eq("setup_table", GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
      .eq("setup_id", draftId),
  ]);

  const { error: deleteError } = await supabase
    .from(GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE)
    .delete()
    .eq("id", draftId);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  return true;
}
