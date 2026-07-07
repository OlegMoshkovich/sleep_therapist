import {
  createAgentTemplateDraft,
  findReusableAgentTemplateMatch,
  findAgentTemplateByOwnerSlug,
  type AgentTemplateDraft,
  type AgentTemplateCatalogSupabaseClient,
} from "./agent-template-catalog";
import {
  PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
  PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
  PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
  createEmptyOrchestrationEnvironmentPlayer,
  makeOrchestrationId,
  normalizeLatestInteractionStateFields,
  slugify,
  syncAgentConnectionDerivedPrompts,
  type OrchestrationAgentConnection,
  type OrchestrationEnvironmentPlayer,
  type OrchestrationProject,
  type OrchestrationProjectAgentBinding,
} from "./general-orchestration";
import {
  CONVERSATION_SUMMARY_FIELD_NAME,
  LEGACY_NEW_CONVERSATIONS_FIELD_NAME,
  NEW_EVENTS_FIELD_NAME,
} from "@airlab/canvas-core/lib/conversation-memory";

type SupabaseClient = AgentTemplateCatalogSupabaseClient;
type LegacyTemplateDefaults = Pick<
  AgentTemplateDraft,
  | "defaultFields"
  | "defaultStateUpdatePrompt"
  | "defaultPolicyPrompt"
  | "defaultGuidelines"
  | "defaultDatasets"
  | "defaultUploadedFiles"
  | "defaultSkills"
  | "defaultPolicyCanvases"
  | "defaultStatePolicyCanvases"
  | "defaultRewardPrompt"
  | "defaultRewardCanvases"
>;

const LEGACY_MEMORY_FIELD_NAMES = new Set(
  [
    CONVERSATION_SUMMARY_FIELD_NAME,
    LEGACY_NEW_CONVERSATIONS_FIELD_NAME,
    NEW_EVENTS_FIELD_NAME,
    PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
    PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
    PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
  ].map((field) => normalizeFieldName(field))
);

function normalizeFieldName(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s-]+/g, " ");
}

function hasCanvasContent(doc: OrchestrationProject["policyCanvases"]): boolean {
  return Boolean(doc?.canvases?.length);
}

function cloneCanvasDoc(
  doc: OrchestrationProject["policyCanvases"]
): OrchestrationProject["policyCanvases"] {
  return doc ? JSON.parse(JSON.stringify(doc)) : null;
}

function hasPromptOrCanvas(
  prompt: string,
  doc: OrchestrationProject["policyCanvases"]
): boolean {
  return prompt.trim().length > 0 || hasCanvasContent(doc);
}

function hasNonLegacyField(project: OrchestrationProject): boolean {
  return project.fields.some(
    (field) => !LEGACY_MEMORY_FIELD_NAMES.has(normalizeFieldName(field.name))
  );
}

function hasAuthoredLegacyAgentContent(project: OrchestrationProject): boolean {
  const hasNamedProject =
    project.meta.title.trim().length > 0 &&
    project.meta.title.trim() !== "Untitled Setup";

  return (
    hasNamedProject ||
    project.meta.summary.trim().length > 0 ||
    project.meta.policyIntent.trim().length > 0 ||
    hasNonLegacyField(project) ||
    project.stateUpdatePrompt.trim().length > 0 ||
    project.policyPrompt.trim().length > 0 ||
    hasCanvasContent(project.policyCanvases) ||
    hasCanvasContent(project.statePolicyCanvases) ||
    project.skills.length > 0 ||
    project.guidelines.length > 0 ||
    project.datasets.length > 0 ||
    project.uploadedFiles.length > 0
  );
}

function isMissingAgentTemplateCatalogError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("agent_templates") ||
    message.includes("agent_template_versions") ||
    message.includes("agent template")
  ) && (
    message.includes("does not exist") ||
    message.includes("schema cache") ||
    message.includes("not found") ||
    message.includes("failed to create agent template")
  );
}

function buildLegacyTemplateTitle(project: OrchestrationProject): string {
  const title = project.meta.title.trim();
  return title && title !== "Untitled Setup" ? title : "Legacy Project Agent";
}

function buildLegacyTemplateSlug(title: string, stableId: string): string {
  const baseSlug = slugify(title) || "legacy-project-agent";
  const suffix = stableId.trim().slice(0, 8) || makeOrchestrationId().slice(0, 8);
  return `${baseSlug}-${suffix}`;
}

function buildReusableTemplateSlug(title: string, stableId: string): string {
  const baseSlug = slugify(title) || "agent-template";
  const suffix = stableId.trim().slice(0, 8);
  return suffix ? `${baseSlug}-${suffix}` : baseSlug;
}

function hasBindingForAgent(
  bindings: OrchestrationProjectAgentBinding[],
  agentId: string
): boolean {
  const normalized = agentId.trim();
  return bindings.some((binding) => binding.id.trim() === normalized);
}

function findConnectionForTarget(
  project: OrchestrationProject,
  targetAgentId: string
): OrchestrationAgentConnection | null {
  const normalized = targetAgentId.trim();
  return (
    project.agentConnections.find(
      (connection) => connection.targetAgentId.trim() === normalized
    ) ?? null
  );
}

function buildPrimaryTemplateDefaults(
  project: OrchestrationProject
): LegacyTemplateDefaults {
  return {
    defaultFields: normalizeLatestInteractionStateFields(project.fields),
    defaultStateUpdatePrompt: project.stateUpdatePrompt,
    defaultPolicyPrompt: project.policyPrompt,
    defaultRewardPrompt: "",
    defaultGuidelines: project.guidelines,
    defaultDatasets: project.datasets,
    defaultUploadedFiles: project.uploadedFiles,
    defaultSkills: project.skills,
    defaultPolicyCanvases: cloneCanvasDoc(project.policyCanvases),
    defaultStatePolicyCanvases: cloneCanvasDoc(project.statePolicyCanvases),
    defaultRewardCanvases: null,
  };
}

export function moveLegacyPrimaryCanvasDefaultsToSourceConnections(
  project: OrchestrationProject
): OrchestrationProject {
  const hasLegacyPolicy = hasPromptOrCanvas(
    project.policyPrompt,
    project.policyCanvases
  );
  const hasLegacyState = hasPromptOrCanvas(
    project.stateUpdatePrompt,
    project.statePolicyCanvases
  );
  if (
    (!hasLegacyPolicy && !hasLegacyState) ||
    project.agentConnections.length === 0
  ) {
    return project;
  }

  let changed = false;
  const agentConnections = project.agentConnections.map((connection) => {
    const patch: Partial<OrchestrationAgentConnection> = {};
    if (
      hasLegacyPolicy &&
      !hasPromptOrCanvas(
        connection.sourcePolicyPrompt,
        connection.sourcePolicyCanvases
      )
    ) {
      patch.sourcePolicyPrompt = project.policyPrompt;
      patch.sourcePolicyCanvases = cloneCanvasDoc(project.policyCanvases);
    }
    if (
      hasLegacyState &&
      !hasPromptOrCanvas(
        connection.sourceStateUpdatePrompt,
        connection.sourceStatePolicyCanvases
      )
    ) {
      patch.sourceStateUpdatePrompt = project.stateUpdatePrompt;
      patch.sourceStatePolicyCanvases = cloneCanvasDoc(
        project.statePolicyCanvases
      );
    }
    if (Object.keys(patch).length === 0) {
      return connection;
    }
    changed = true;
    return syncAgentConnectionDerivedPrompts({
      ...connection,
      ...patch,
    });
  });

  return changed
    ? {
        ...project,
        agentConnections,
      }
    : project;
}

function stripMaterializedPrimaryLegacyCanvasDefaults(
  project: OrchestrationProject,
  agents: OrchestrationProjectAgentBinding[]
): OrchestrationProject {
  const sourceAgentId =
    project.agentId.trim() || project.id || makeOrchestrationId();
  if (!hasBindingForAgent(agents, sourceAgentId)) {
    return project;
  }

  return moveLegacyPrimaryCanvasDefaultsToSourceConnections(project);
}

function buildEnvironmentTemplateDefaults(
  player: OrchestrationEnvironmentPlayer
): LegacyTemplateDefaults {
  return {
    defaultFields: normalizeLatestInteractionStateFields(player.fields),
    defaultStateUpdatePrompt: player.stateUpdatePrompt,
    defaultPolicyPrompt: player.policyPrompt,
    defaultRewardPrompt: "",
    defaultGuidelines: player.guidelines,
    defaultDatasets: player.datasets,
    defaultUploadedFiles: player.uploadedFiles,
    defaultSkills: player.skills,
    defaultPolicyCanvases: cloneCanvasDoc(player.policyCanvases),
    defaultStatePolicyCanvases: cloneCanvasDoc(player.statePolicyCanvases),
    defaultRewardCanvases: null,
  };
}

function buildConnectionTargetTemplateDefaults(
  connection: OrchestrationAgentConnection
): LegacyTemplateDefaults {
  const targetDefaults = createEmptyOrchestrationEnvironmentPlayer();
  const targetFields = Array.isArray(connection.targetFields)
    ? normalizeLatestInteractionStateFields(connection.targetFields)
    : [];
  const targetSkills = Array.isArray(connection.targetSkills)
    ? connection.targetSkills
    : [];
  const targetDatasets = Array.isArray(connection.targetDatasets)
    ? connection.targetDatasets
    : [];
  const targetUploadedFiles = Array.isArray(connection.targetUploadedFiles)
    ? connection.targetUploadedFiles
    : [];
  return {
    defaultFields: targetFields.length
      ? targetFields
      : normalizeLatestInteractionStateFields(targetDefaults.fields),
    defaultStateUpdatePrompt:
      connection.targetStateUpdatePrompt || targetDefaults.stateUpdatePrompt,
    defaultPolicyPrompt:
      connection.targetPolicyPrompt ||
      connection.policyPrompt ||
      targetDefaults.policyPrompt,
    defaultRewardPrompt: connection.targetRewardPrompt,
    defaultGuidelines: [],
    defaultDatasets: targetDatasets.length
      ? targetDatasets
      : targetDefaults.datasets,
    defaultUploadedFiles: targetUploadedFiles.length
      ? targetUploadedFiles
      : targetDefaults.uploadedFiles,
    defaultSkills: targetSkills.length ? targetSkills : targetDefaults.skills,
    defaultPolicyCanvases:
      connection.targetPolicyCanvases ??
      connection.policyCanvases ??
      null,
    defaultStatePolicyCanvases: connection.targetStatePolicyCanvases ?? null,
    defaultRewardCanvases: connection.targetRewardCanvases ?? null,
  };
}

function buildEnvironmentTemplateTitle(args: {
  project: OrchestrationProject;
  player: OrchestrationEnvironmentPlayer;
  index: number;
}): string {
  return (
    findConnectionForTarget(args.project, args.player.id)?.targetAgentTitle.trim() ||
    `Legacy Agent ${args.index + 1}`
  );
}

async function materializeTemplateBinding(args: {
  ownerId: string | null;
  supabase?: SupabaseClient;
  bindingId: string;
  title: string;
  description: string;
  roleContext?: string;
  defaults: LegacyTemplateDefaults;
}): Promise<OrchestrationProjectAgentBinding | null> {
  const legacySlug = buildLegacyTemplateSlug(args.title, args.bindingId);
  const template =
    (await findAgentTemplateByOwnerSlug({
      ownerId: args.ownerId,
      slug: legacySlug,
      supabase: args.supabase,
    })) ??
    (
      await findReusableAgentTemplateMatch({
        ownerId: args.ownerId,
        title: args.title,
        description: args.description,
        roleContext: args.roleContext,
        supabase: args.supabase,
      })
    )?.template ??
    (await createAgentTemplateDraft(
      {
        ownerId: args.ownerId,
        title: args.title,
        slug: buildReusableTemplateSlug(args.title, args.bindingId),
        description: args.description,
        visibility: "shared",
        versionLabel: "Initial reusable agent template",
        versionStatus: "draft",
        ...args.defaults,
      },
      { supabase: args.supabase }
    ));
  const versionId = template.latestVersionId || template.versions[0]?.id || "";
  if (!versionId) {
    return null;
  }

  return {
    id: args.bindingId,
    templateId: template.id,
    templateVersionId: versionId,
    title: args.title,
    roleContext: args.roleContext ?? "",
    fieldOverrides: [],
    datasetOverrides: [],
    uploadedFileOverrides: [],
    skillOverrides: [],
    policyCanvasesOverride: null,
    statePolicyCanvasesOverride: null,
  };
}

export async function materializeLegacyProjectAgentTemplate(args: {
  project: OrchestrationProject;
  ownerId: string | null;
  supabase?: SupabaseClient;
}): Promise<OrchestrationProject> {
  const sourceAgentId =
    args.project.agentId.trim() || args.project.id || makeOrchestrationId();
  const environmentPlayers = args.project.environmentPlayers.map((player) => ({
    ...player,
    id: player.id.trim() || makeOrchestrationId(),
  }));
  let agents = [...args.project.agents];
  const project: OrchestrationProject = {
    ...args.project,
    agentId: sourceAgentId,
    environmentPlayers,
  };

  try {
    if (
      !hasBindingForAgent(agents, sourceAgentId) &&
      (hasAuthoredLegacyAgentContent(project) ||
        project.environmentPlayers.length > 0 ||
        project.agentConnections.length > 0)
    ) {
      const title = buildLegacyTemplateTitle(project);
      const binding = await materializeTemplateBinding({
        ownerId: args.ownerId,
        supabase: args.supabase,
        bindingId: sourceAgentId,
        title,
        description:
          project.meta.summary.trim() ||
          project.meta.policyIntent.trim() ||
          "Template materialized from a legacy daemon project agent.",
        defaults: buildPrimaryTemplateDefaults(project),
      });
      if (binding) {
        agents = [...agents, binding];
      }
    }

    for (const [index, player] of project.environmentPlayers.entries()) {
      const bindingId = player.id.trim();
      if (!bindingId || hasBindingForAgent(agents, bindingId)) {
        continue;
      }
      const title = buildEnvironmentTemplateTitle({ project, player, index });
      const connection = findConnectionForTarget(project, bindingId);
      const binding = await materializeTemplateBinding({
        ownerId: args.ownerId,
        supabase: args.supabase,
        bindingId,
        title,
        description:
          connection?.purpose.trim() ||
          "Template materialized from a legacy embedded agent.",
        roleContext:
          "Previously stored as an embedded agent in this project.",
        defaults: buildEnvironmentTemplateDefaults(player),
      });
      if (binding) {
        agents = [...agents, binding];
      }
    }

    for (const [index, connection] of project.agentConnections.entries()) {
      const bindingId = connection.targetAgentId.trim();
      if (
        !bindingId ||
        bindingId === sourceAgentId ||
        hasBindingForAgent(agents, bindingId)
      ) {
        continue;
      }
      const title =
        connection.targetAgentTitle.trim() || `Connected Agent ${index + 1}`;
      const binding = await materializeTemplateBinding({
        ownerId: args.ownerId,
        supabase: args.supabase,
        bindingId,
        title,
        description:
          connection.purpose.trim() ||
          "Template materialized from an existing project agent connection.",
        roleContext: connection.purpose.trim(),
        defaults: buildConnectionTargetTemplateDefaults(connection),
      });
      if (binding) {
        agents = [...agents, binding];
      }
    }

    return stripMaterializedPrimaryLegacyCanvasDefaults(
      {
        ...project,
        agents,
      },
      agents
    );
  } catch (error) {
    if (isMissingAgentTemplateCatalogError(error)) {
      return args.project;
    }
    throw error;
  }
}
