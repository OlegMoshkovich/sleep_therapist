import {
  createEmptyOrchestrationAgentConnection,
  createEmptyOrchestrationProject,
  getRuntimePolicyCanvasDoc,
  getWorkflowOverviewCanvasDoc,
  isGuidelineItemsDatasetName,
  makeOrchestrationId,
  materializeProjectGuidelineItems,
  type OrchestrationProject,
} from "./general-orchestration";
import {
  ensureExternalEpisodesDataset,
  isExternalEpisodesDataset,
} from "./external-episodes";
import type { SimulationPlayerDataset } from "@airlab/canvas-core/components/setup/dataset-schema";
import {
  getSeededCanvasRuleDefinitions,
  readCanvasRuleRegistryFromDatasets,
  replaceCanvasRuleRegistryDataset,
} from "@airlab/canvas-core/lib/canvas-rule-registry";
import {
  hydrateStoredOrchestrationProject,
  serializeOrchestrationProject,
  type StoredOrchestrationCanvasRow,
  type StoredOrchestrationStateField,
} from "./orchestration-project-storage";
import { resolveInteractionProtocol } from "./interaction-protocol";

export const GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE =
  "general_orchestration_daemon_drafts";
export const GENERAL_ORCHESTRATION_DAEMON_DRAFT_ENDPOINT =
  "/demo/general-orchestration-daemon";
export const GENERAL_ORCHESTRATION_DAEMON_LEGACY_INITIAL_MESSAGE =
  "Describe the expert workflow you want to reproduce. Once the overall process is confirmed, I’ll draft the editable workflow canvas before seeding implementation canvases.";
export const GENERAL_ORCHESTRATION_DAEMON_INITIAL_STATUS =
  "New daemon draft";

export interface DaemonDraftMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export type DaemonDraftState = Record<string, unknown>;
export type DaemonDraftInteractionMode = "chat" | "lazy" | "automated";

export interface GeneralOrchestrationDaemonDraftRow {
  id?: string;
  expert_id?: string | null;
  endpoint?: string | null;
  agent_id?: string | null;
  config_name?: string | null;
  route_slug?: string | null;
  setup_summary?: string | null;
  policy_intent?: string | null;
  workspace_status?: string | null;
  interaction_mode?: string | null;
  state_schema?: StoredOrchestrationStateField[] | null;
  state_update_prompt?: string | null;
  policy_prompt?: string | null;
  guideline_blocks?: unknown;
  datasets?: unknown;
  shared_datasets?: unknown;
  interaction_protocol?: unknown;
  skills?: unknown;
  agent_bindings?: unknown;
  agent_connections?: unknown;
  environment_players?: unknown;
  uploaded_files?: unknown;
  daemon_state?: unknown;
  conversation_messages?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface DaemonDraftSummary {
  id: string;
  title: string;
  routeSlug: string;
  summary: string;
  status: string;
  updatedAt: string;
  interactionMode: DaemonDraftInteractionMode;
}

const PROCESS_OPEN_QUESTIONS_KEY = "process_open_questions";
const LEGACY_POLICY_OPEN_QUESTIONS_KEY = "policy_open_questions";
const DAEMON_INTERACTION_MODE_STATE_KEY = "daemon_interaction_mode";

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDaemonDraftInteractionMode(
  value: unknown
): DaemonDraftInteractionMode {
  return value === "automated" || value === "lazy" ? value : "chat";
}

function readStringArrayLike(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean);
      }
    } catch {
      return trimmed
        .split("||")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  return [];
}

export function normalizeDaemonOpenQuestionsState(
  state: DaemonDraftState
): DaemonDraftState {
  const processOpenQuestions = readStringArrayLike(state[PROCESS_OPEN_QUESTIONS_KEY]);
  const legacyPolicyOpenQuestions = readStringArrayLike(
    state[LEGACY_POLICY_OPEN_QUESTIONS_KEY]
  );
  const rest = { ...state };
  delete rest.workspace_mode;
  delete rest.workspaceMode;
  delete rest.requested_edits;
  delete rest.requestedEdits;
  delete rest.needs_tool_scaffolding;
  delete rest.needsToolScaffolding;
  delete rest[DAEMON_INTERACTION_MODE_STATE_KEY];

  if (legacyPolicyOpenQuestions.length === 0) {
    return rest;
  }

  const combined = Array.from(
    new Set([...processOpenQuestions, ...legacyPolicyOpenQuestions])
  );
  delete rest[LEGACY_POLICY_OPEN_QUESTIONS_KEY];

  return {
    ...rest,
    [PROCESS_OPEN_QUESTIONS_KEY]: combined,
  };
}

export function normalizeDaemonDraftState(
  raw: unknown
): DaemonDraftState | null {
  let value = raw;

  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return normalizeDaemonOpenQuestionsState(value as DaemonDraftState);
}

export function createInitialDaemonDraftMessages(
  initialMessage = ""
): DaemonDraftMessage[] {
  const content = initialMessage.trim();
  if (!content) {
    return [];
  }

  return [
    {
      id: makeOrchestrationId(),
      role: "assistant",
      content,
    },
  ];
}

export function normalizeDaemonDraftMessages(raw: unknown): DaemonDraftMessage[] {
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

  const messages = items
    .map((item) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
      const role = row?.role;
      const content = asString(row?.content);
      if ((role !== "user" && role !== "assistant") || !content) {
        return null;
      }

      return {
        id: asString(row?.id) || makeOrchestrationId(),
        role,
        content,
      } satisfies DaemonDraftMessage;
    })
    .filter((message): message is DaemonDraftMessage => message !== null);

  if (
    messages.length === 1 &&
    messages[0]?.role === "assistant" &&
    messages[0]?.content.trim() === GENERAL_ORCHESTRATION_DAEMON_LEGACY_INITIAL_MESSAGE
  ) {
    return [];
  }

  return messages;
}

export function buildDaemonDraftSummary(
  row: Pick<
    GeneralOrchestrationDaemonDraftRow,
    | "id"
    | "config_name"
    | "route_slug"
    | "setup_summary"
    | "workspace_status"
    | "interaction_mode"
    | "updated_at"
  >
): DaemonDraftSummary {
  return {
    id: asString(row.id),
    title: asString(row.config_name) || "Untitled Setup",
    routeSlug: asString(row.route_slug) || "untitled-setup",
    summary: asString(row.setup_summary),
    status: asString(row.workspace_status) || GENERAL_ORCHESTRATION_DAEMON_INITIAL_STATUS,
    updatedAt: asString(row.updated_at) || new Date(0).toISOString(),
    interactionMode: normalizeDaemonDraftInteractionMode(row.interaction_mode),
  };
}

function isSystemDataset(dataset: SimulationPlayerDataset): boolean {
  return (
    isExternalEpisodesDataset(dataset) || isGuidelineItemsDatasetName(dataset.name)
  );
}

function ensureDaemonRuleRegistryDataset(
  datasets: SimulationPlayerDataset[]
): SimulationPlayerDataset[] {
  const rulesById = new Map(
    getSeededCanvasRuleDefinitions().map((rule) => [rule.id, rule])
  );
  for (const rule of readCanvasRuleRegistryFromDatasets(datasets)) {
    rulesById.set(rule.id, rule);
  }
  return replaceCanvasRuleRegistryDataset(
    datasets,
    [...rulesById.values()],
    makeOrchestrationId
  );
}

export function ensureDaemonConversationProject(
  project: OrchestrationProject
): OrchestrationProject {
  const normalizedProject = materializeProjectGuidelineItems(project);
  const workflowCanvases =
    getWorkflowOverviewCanvasDoc(normalizedProject.workflowCanvases) ??
    getWorkflowOverviewCanvasDoc(normalizedProject.policyCanvases);
  const policyCanvases = getRuntimePolicyCanvasDoc(
    normalizedProject.policyCanvases
  );
  const primaryDatasets = Array.isArray(normalizedProject.datasets)
    ? normalizedProject.datasets
    : [];
  const sharedDatasets = Array.isArray(normalizedProject.sharedDatasets)
    ? normalizedProject.sharedDatasets
    : [];
  const environmentPlayers = Array.isArray(normalizedProject.environmentPlayers)
    ? normalizedProject.environmentPlayers
    : [];
  const sourceAgentId =
    typeof normalizedProject.agentId === "string" &&
    normalizedProject.agentId.trim()
      ? normalizedProject.agentId.trim()
      : normalizedProject.id || makeOrchestrationId();
  const existingConnections = Array.isArray(normalizedProject.agentConnections)
    ? normalizedProject.agentConnections
    : [];
  const existingTargetIds = new Set(
    existingConnections
      .map((connection) => connection.targetAgentId.trim())
      .filter(Boolean)
  );
  const agentTitleById = new Map(
    (Array.isArray(normalizedProject.agents) ? normalizedProject.agents : [])
      .map((agent) => [agent.id.trim(), agent.title.trim()] as const)
      .filter(([id, title]) => id && title)
  );
  const legacyEnvironmentConnections = environmentPlayers
    .filter((player) => player.id.trim() && !existingTargetIds.has(player.id.trim()))
    .map((player, index) => ({
      ...createEmptyOrchestrationAgentConnection({
        sourceAgentId,
        targetAgentId: player.id,
        targetAgentTitle:
          agentTitleById.get(player.id.trim()) ||
          `Legacy environment agent ${index + 1}`,
        purpose:
          "Converted from the previous embedded environment-agent design. This now represents a pairwise agent interaction by ID.",
        targetPolicyCanvases: player.policyCanvases,
        targetPolicyPrompt: player.policyPrompt,
        policyCanvases: player.policyCanvases,
        policyPrompt: player.policyPrompt,
      }),
      id: player.id,
    }));
  const agentConnections = [
    ...existingConnections.map((connection) => ({
      ...connection,
      sourceAgentId: connection.sourceAgentId.trim() || sourceAgentId,
    })),
    ...legacyEnvironmentConnections,
  ];

  // System datasets (external_episodes, guideline_items) live on the shared
  // tier so every agent can reach them. Older drafts stored them on the
  // primary tier — relocate those on load/save; an existing shared copy wins.
  const sharedNames = new Set(
    sharedDatasets.map((dataset) => dataset.name.trim().toLowerCase())
  );
  const relocated = primaryDatasets.filter(
    (dataset) =>
      isSystemDataset(dataset) &&
      !sharedNames.has(dataset.name.trim().toLowerCase())
  );

  return {
    ...normalizedProject,
    agentId: sourceAgentId,
    workflowCanvases,
    policyCanvases,
    interactionProtocol: resolveInteractionProtocol(
      normalizedProject.interactionProtocol,
      {}
    ),
    datasets: ensureDaemonRuleRegistryDataset(
      primaryDatasets.filter((dataset) => !isSystemDataset(dataset))
    ),
    sharedDatasets: ensureExternalEpisodesDataset(
      [...sharedDatasets, ...relocated],
      makeOrchestrationId
    ),
    agentConnections,
    environmentPlayers: [],
  };
}

export function hydrateDaemonDraft(args: {
  config: GeneralOrchestrationDaemonDraftRow;
  policyCanvases?: StoredOrchestrationCanvasRow[];
  statePolicyCanvases?: StoredOrchestrationCanvasRow[];
}) {
  const project = ensureDaemonConversationProject(
    hydrateStoredOrchestrationProject({
      configId: args.config.id,
      agentId: args.config.agent_id,
      title: args.config.config_name,
      slug: args.config.route_slug,
      summary: args.config.setup_summary,
      policyIntent: args.config.policy_intent,
      status: args.config.workspace_status,
      stateSchema: args.config.state_schema,
      stateUpdatePrompt: args.config.state_update_prompt,
      policyPrompt: args.config.policy_prompt,
      guidelineBlocks: args.config.guideline_blocks,
      datasets: args.config.datasets,
      sharedDatasets: args.config.shared_datasets,
      interactionProtocol: args.config.interaction_protocol,
      skills: args.config.skills,
      agentBindings: args.config.agent_bindings,
      agentConnections: args.config.agent_connections,
      environmentPlayers: args.config.environment_players,
      uploadedFiles: args.config.uploaded_files,
      policyCanvases: args.policyCanvases,
      statePolicyCanvases: args.statePolicyCanvases,
      defaults: createEmptyOrchestrationProject(),
      loadedStatus: "Loaded from the saved draft.",
    })
  );

  return {
    project,
    daemonState: normalizeDaemonDraftState(args.config.daemon_state),
    messages: normalizeDaemonDraftMessages(args.config.conversation_messages),
    interactionMode: normalizeDaemonDraftInteractionMode(
      args.config.interaction_mode
    ),
    summary: buildDaemonDraftSummary(args.config),
  };
}

export function serializeDaemonDraft(
  project: OrchestrationProject,
  messages: DaemonDraftMessage[],
  daemonState?: DaemonDraftState | null,
  interactionMode: DaemonDraftInteractionMode = "chat"
) {
  const serialized = serializeOrchestrationProject(
    ensureDaemonConversationProject(project)
  );

  return {
    project: serialized.project,
    config: {
      config_name: serialized.configName,
      agent_id: serialized.agentId,
      route_slug: serialized.routeSlug,
      setup_summary: serialized.summary,
      policy_intent: serialized.policyIntent,
      workspace_status: serialized.status,
      interaction_mode: interactionMode,
      uploaded_files: serialized.uploadedFiles,
      state_schema: serialized.stateSchema,
      state_update_prompt: serialized.stateUpdatePrompt,
      policy_prompt: serialized.policyPrompt,
      guideline_blocks: serialized.guidelineBlocks,
      datasets: serialized.datasets,
      shared_datasets: serialized.sharedDatasets,
      interaction_protocol: serialized.interactionProtocol,
      skills: serialized.skills,
      agent_bindings: serialized.agentBindings,
      agent_connections: serialized.agentConnections,
      environment_players: serialized.environmentPlayers,
      daemon_state: daemonState ?? {},
      conversation_messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
      })),
      endpoint: GENERAL_ORCHESTRATION_DAEMON_DRAFT_ENDPOINT,
    },
    policyCanvases: serialized.policyCanvases,
    workflowCanvases: serialized.workflowCanvases,
    statePolicyCanvases: serialized.statePolicyCanvases,
  };
}
