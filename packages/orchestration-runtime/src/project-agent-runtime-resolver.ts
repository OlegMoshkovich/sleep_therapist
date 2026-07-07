import {
  loadAgentTemplateVersion,
  type AgentTemplateCatalogSupabaseClient,
  type AgentTemplateVersion,
} from "@airlab/orchestration-core/agent-template-catalog";
import { compileCanvas } from "@airlab/canvas-compiler/compiler";
import { compileStateExtractionPrompt } from "@airlab/canvas-compiler/stateCompiler";
import {
  createEmptyOrchestrationEnvironmentPlayer,
  makeOrchestrationId,
  normalizeLatestInteractionStateFields,
  type OrchestrationAgentConnection,
  type OrchestrationEnvironmentPlayer,
  type OrchestrationField,
  type OrchestrationGuidelineBlock,
  type OrchestrationProject,
  type OrchestrationProjectAgentBinding,
  type OrchestrationSkill,
  type OrchestrationUploadedFile,
} from "@airlab/orchestration-core/general-orchestration";
import type { CanvasDoc } from "@airlab/canvas-compiler/types";
import type { SimulationPlayerDataset } from "@airlab/canvas-core/components/setup/dataset-schema";

type SupabaseClient = AgentTemplateCatalogSupabaseClient;

export type ProjectAgentRuntimeSupabaseFactory = () => SupabaseClient;

let projectAgentRuntimeSupabaseFactory:
  | ProjectAgentRuntimeSupabaseFactory
  | null = null;

export function registerProjectAgentRuntimeSupabaseFactory(
  factory: ProjectAgentRuntimeSupabaseFactory | null
): void {
  projectAgentRuntimeSupabaseFactory = factory;
}

function createProjectAgentRuntimeSupabaseClient(): SupabaseClient {
  if (!projectAgentRuntimeSupabaseFactory) {
    throw new Error("Project agent runtime Supabase factory is not registered.");
  }
  return projectAgentRuntimeSupabaseFactory();
}

export interface ProjectAgentRuntime {
  id: string;
  title: string;
  roleContext: string;
  fields: OrchestrationField[];
  stateUpdatePrompt: string;
  policyPrompt: string;
  policyCanvases: CanvasDoc | null;
  statePolicyCanvases: CanvasDoc | null;
  skills: OrchestrationSkill[];
  guidelines: OrchestrationGuidelineBlock[];
  datasets: SimulationPlayerDataset[];
  uploadedFiles: OrchestrationUploadedFile[];
  binding: OrchestrationProjectAgentBinding | null;
  templateVersion: AgentTemplateVersion | null;
}

export interface ProjectGraphRuntimeTarget {
  connection: OrchestrationAgentConnection;
  agent: ProjectAgentRuntime;
}

export interface ProjectGraphRuntime {
  sourceAgentId: string;
  sourceAgent: ProjectAgentRuntime;
  agentsById: Map<string, ProjectAgentRuntime>;
  connectedTargets: ProjectGraphRuntimeTarget[];
}

function appendRoleContext(prompt: string, roleContext: string): string {
  const trimmedRoleContext = roleContext.trim();
  if (!trimmedRoleContext) {
    return prompt;
  }
  const roleBlock = `Project role/context:\n${trimmedRoleContext}`;
  const trimmedPrompt = prompt.trim();
  return trimmedPrompt ? `${trimmedPrompt}\n\n${roleBlock}` : roleBlock;
}

function findBinding(
  project: OrchestrationProject,
  agentId: string
): OrchestrationProjectAgentBinding | null {
  const normalized = agentId.trim();
  return project.agents.find((agent) => agent.id.trim() === normalized) ?? null;
}

function findEnvironmentPlayer(
  project: OrchestrationProject,
  agentId: string
): OrchestrationEnvironmentPlayer | null {
  const normalized = agentId.trim();
  return (
    project.environmentPlayers.find((player) => player.id.trim() === normalized) ??
    null
  );
}

function getConnectedTargetConnections(
  project: OrchestrationProject
): OrchestrationAgentConnection[] {
  const sourceAgentId = (project.agentId || project.id).trim();
  const seen = new Set<string>();
  return project.agentConnections.filter((connection) => {
    const targetAgentId = connection.targetAgentId.trim();
    if (!targetAgentId || targetAgentId === sourceAgentId || seen.has(targetAgentId)) {
      return false;
    }
    seen.add(targetAgentId);
    return true;
  });
}

async function loadBindingVersion(args: {
  binding: OrchestrationProjectAgentBinding | null;
  supabase: SupabaseClient;
  cache: Map<string, AgentTemplateVersion | null>;
}): Promise<AgentTemplateVersion | null> {
  const versionId = args.binding?.templateVersionId.trim() ?? "";
  if (!versionId) {
    return null;
  }
  if (args.cache.has(versionId)) {
    return args.cache.get(versionId) ?? null;
  }
  const version = await loadAgentTemplateVersion(versionId, {
    supabase: args.supabase,
  });
  args.cache.set(versionId, version);
  return version;
}

function buildPrimaryFallbackRuntime(project: OrchestrationProject): ProjectAgentRuntime {
  return {
    id: (project.agentId || project.id).trim(),
    title: project.meta.title.trim() || "Primary Agent",
    roleContext: "",
    fields: normalizeLatestInteractionStateFields(project.fields),
    stateUpdatePrompt: project.stateUpdatePrompt,
    policyPrompt: project.policyPrompt,
    policyCanvases: project.policyCanvases,
    statePolicyCanvases: project.statePolicyCanvases,
    skills: project.skills,
    guidelines: project.guidelines,
    datasets: project.datasets,
    uploadedFiles: project.uploadedFiles,
    binding: null,
    templateVersion: null,
  };
}

function buildEnvironmentFallbackRuntime(args: {
  player: OrchestrationEnvironmentPlayer;
  title: string;
}): ProjectAgentRuntime {
  return {
    id: args.player.id.trim(),
    title: args.title,
    roleContext: "",
    fields: normalizeLatestInteractionStateFields(args.player.fields),
    stateUpdatePrompt: args.player.stateUpdatePrompt,
    policyPrompt: args.player.policyPrompt,
    policyCanvases: args.player.policyCanvases,
    statePolicyCanvases: args.player.statePolicyCanvases,
    skills: args.player.skills,
    guidelines: args.player.guidelines,
    datasets: args.player.datasets,
    uploadedFiles: args.player.uploadedFiles,
    binding: null,
    templateVersion: null,
  };
}

function buildConnectionFallbackRuntime(
  connection: OrchestrationAgentConnection
): ProjectAgentRuntime {
  const fallback = createEmptyOrchestrationEnvironmentPlayer();
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
    id: connection.targetAgentId.trim(),
    title: connection.targetAgentTitle.trim() || connection.targetAgentId.trim(),
    roleContext: connection.purpose,
    fields: targetFields.length
      ? targetFields
      : normalizeLatestInteractionStateFields(fallback.fields),
    stateUpdatePrompt:
      connection.targetStateUpdatePrompt || fallback.stateUpdatePrompt,
    policyPrompt:
      connection.targetPolicyPrompt ||
      connection.policyPrompt ||
      fallback.policyPrompt,
    policyCanvases:
      connection.targetPolicyCanvases ?? connection.policyCanvases,
    statePolicyCanvases:
      connection.targetStatePolicyCanvases ?? fallback.statePolicyCanvases,
    skills: targetSkills.length ? targetSkills : fallback.skills,
    guidelines: fallback.guidelines,
    datasets: targetDatasets.length ? targetDatasets : fallback.datasets,
    uploadedFiles: targetUploadedFiles.length
      ? targetUploadedFiles
      : fallback.uploadedFiles,
    binding: null,
    templateVersion: null,
  };
}

export function applyConnectionParticipantPolicy(args: {
  runtime: ProjectAgentRuntime;
  connection: OrchestrationAgentConnection;
  participant: "source" | "target";
}): ProjectAgentRuntime {
  const policyPrompt =
    args.participant === "source"
      ? args.connection.sourcePolicyPrompt
      : args.connection.targetPolicyPrompt || args.connection.policyPrompt;
  const policyCanvases =
    args.participant === "source"
      ? args.connection.sourcePolicyCanvases
      : args.connection.targetPolicyCanvases ?? args.connection.policyCanvases;
  const stateUpdatePrompt =
    args.participant === "source"
      ? args.connection.sourceStateUpdatePrompt
      : args.connection.targetStateUpdatePrompt;
  const statePolicyCanvases =
    args.participant === "source"
      ? args.connection.sourceStatePolicyCanvases
      : args.connection.targetStatePolicyCanvases;

  if (args.participant === "source") {
    return {
      ...args.runtime,
      policyPrompt:
        policyPrompt.trim() ||
        (policyCanvases ? compileCanvas(policyCanvases).output : ""),
      policyCanvases,
      stateUpdatePrompt:
        stateUpdatePrompt.trim() ||
        (statePolicyCanvases
          ? compileStateExtractionPrompt(statePolicyCanvases, args.runtime.fields)
          : ""),
      statePolicyCanvases,
    };
  }

  const targetFields = Array.isArray(args.connection.targetFields)
    ? normalizeLatestInteractionStateFields(args.connection.targetFields)
    : [];
  const targetSkills = Array.isArray(args.connection.targetSkills)
    ? args.connection.targetSkills
    : [];
  const targetDatasets = Array.isArray(args.connection.targetDatasets)
    ? args.connection.targetDatasets
    : [];
  const targetUploadedFiles = Array.isArray(args.connection.targetUploadedFiles)
    ? args.connection.targetUploadedFiles
    : [];

  return {
    ...args.runtime,
    // Match the connected-agent editor: per-connection target config is the
    // runtime source of truth, with bound template data only as fallback.
    fields: targetFields.length
      ? targetFields
      : normalizeLatestInteractionStateFields(args.runtime.fields),
    policyPrompt: policyPrompt.trim() || args.runtime.policyPrompt,
    policyCanvases: policyCanvases ?? args.runtime.policyCanvases,
    stateUpdatePrompt:
      stateUpdatePrompt.trim() || args.runtime.stateUpdatePrompt,
    statePolicyCanvases:
      statePolicyCanvases ?? args.runtime.statePolicyCanvases,
    skills: targetSkills.length ? targetSkills : args.runtime.skills,
    datasets: targetDatasets.length ? targetDatasets : args.runtime.datasets,
    uploadedFiles: targetUploadedFiles.length
      ? targetUploadedFiles
      : args.runtime.uploadedFiles,
  };
}

function mergeRuntimeWithBinding(args: {
  id: string;
  fallback: ProjectAgentRuntime;
  binding: OrchestrationProjectAgentBinding | null;
  version: AgentTemplateVersion | null;
}): ProjectAgentRuntime {
  const binding = args.binding;
  const version = args.version;
  const title =
    binding?.title.trim() ||
    args.fallback.title.trim() ||
    (args.id === args.fallback.id ? args.fallback.title : args.id);
  const roleContext = binding?.roleContext.trim() ?? args.fallback.roleContext;
  const policyPrompt = appendRoleContext(
    version?.defaultPolicyPrompt.trim() ||
      args.fallback.policyPrompt ||
      "",
    roleContext
  );

  return {
    id: args.id,
    title,
    roleContext,
    fields:
      binding?.fieldOverrides.length
        ? binding.fieldOverrides
        : version?.defaultFields.length
          ? version.defaultFields
          : args.fallback.fields,
    stateUpdatePrompt:
      version?.defaultStateUpdatePrompt.trim() ||
      args.fallback.stateUpdatePrompt,
    policyPrompt,
    policyCanvases:
      binding?.policyCanvasesOverride ??
      version?.defaultPolicyCanvases ??
      args.fallback.policyCanvases,
    statePolicyCanvases:
      binding?.statePolicyCanvasesOverride ??
      version?.defaultStatePolicyCanvases ??
      args.fallback.statePolicyCanvases,
    skills:
      binding?.skillOverrides?.length
        ? binding.skillOverrides
        : version?.defaultSkills.length
          ? version.defaultSkills
          : args.fallback.skills,
    guidelines: version?.defaultGuidelines.length
      ? version.defaultGuidelines
      : args.fallback.guidelines,
    datasets:
      binding?.datasetOverrides.length
        ? binding.datasetOverrides
        : version?.defaultDatasets.length
          ? version.defaultDatasets
          : args.fallback.datasets,
    uploadedFiles:
      binding?.uploadedFileOverrides.length
        ? binding.uploadedFileOverrides
        : version?.defaultUploadedFiles.length
          ? version.defaultUploadedFiles
          : args.fallback.uploadedFiles,
    binding,
    templateVersion: version,
  };
}

async function resolveBoundRuntime(args: {
  project: OrchestrationProject;
  agentId: string;
  fallback: ProjectAgentRuntime;
  supabase: SupabaseClient;
  versionCache: Map<string, AgentTemplateVersion | null>;
}): Promise<ProjectAgentRuntime> {
  const binding = findBinding(args.project, args.agentId);
  const version = await loadBindingVersion({
    binding,
    supabase: args.supabase,
    cache: args.versionCache,
  });
  return mergeRuntimeWithBinding({
    id: args.agentId,
    fallback: args.fallback,
    binding,
    version,
  });
}

export function projectAgentRuntimeToPrimaryProject(
  project: OrchestrationProject,
  runtime: ProjectAgentRuntime
): OrchestrationProject {
  return {
    ...project,
    agentId: runtime.id,
    meta: {
      ...project.meta,
      title: project.meta.title.trim() || runtime.title,
    },
    fields: normalizeLatestInteractionStateFields(runtime.fields),
    stateUpdatePrompt: runtime.stateUpdatePrompt,
    policyPrompt: runtime.policyPrompt,
    policyCanvases: runtime.policyCanvases,
    statePolicyCanvases: runtime.statePolicyCanvases,
    skills: runtime.skills,
    guidelines: runtime.guidelines,
    datasets: runtime.datasets,
    uploadedFiles: runtime.uploadedFiles,
  };
}

export async function resolveProjectAgentRuntimes(args: {
  project: OrchestrationProject;
  supabase?: SupabaseClient;
}): Promise<ProjectGraphRuntime> {
  const supabase = args.supabase ?? createProjectAgentRuntimeSupabaseClient();
  const versionCache = new Map<string, AgentTemplateVersion | null>();
  const sourceAgentId =
    (args.project.agentId || args.project.id).trim() ||
    makeOrchestrationId();
  const agentsById = new Map<string, ProjectAgentRuntime>();
  const sourceAgent = await resolveBoundRuntime({
    project: args.project,
    agentId: sourceAgentId,
    fallback: buildPrimaryFallbackRuntime({
      ...args.project,
      agentId: sourceAgentId,
    }),
    supabase,
    versionCache,
  });
  agentsById.set(sourceAgentId, sourceAgent);

  const connectedTargets: ProjectGraphRuntimeTarget[] = [];
  for (const connection of getConnectedTargetConnections(args.project)) {
    const targetAgentId = connection.targetAgentId.trim();
    const environmentPlayer = findEnvironmentPlayer(args.project, targetAgentId);
    const fallback = environmentPlayer
      ? buildEnvironmentFallbackRuntime({
          player: environmentPlayer,
          title:
            connection.targetAgentTitle.trim() ||
            `Agent ${connectedTargets.length + 1}`,
        })
      : buildConnectionFallbackRuntime(connection);
    const agent = applyConnectionParticipantPolicy({
      runtime: await resolveBoundRuntime({
        project: args.project,
        agentId: targetAgentId,
        fallback,
        supabase,
        versionCache,
      }),
      connection,
      participant: "target",
    });
    agentsById.set(targetAgentId, agent);
    connectedTargets.push({ connection, agent });
  }

  for (const binding of args.project.agents) {
    const agentId = binding.id.trim();
    if (!agentId || agentsById.has(agentId)) {
      continue;
    }
    const environmentPlayer = findEnvironmentPlayer(args.project, agentId);
    const fallback = environmentPlayer
      ? buildEnvironmentFallbackRuntime({
          player: environmentPlayer,
          title: binding.title.trim() || agentId,
        })
        : buildConnectionFallbackRuntime({
            id: agentId,
            sourceAgentId,
            targetAgentId: agentId,
            targetAgentTitle: binding.title,
            purpose: binding.roleContext,
            invocationMode: "sync",
            sourcePolicyPrompt: "",
            sourcePolicyCanvases: null,
            sourceStateUpdatePrompt: "",
            sourceStatePolicyCanvases: null,
            sourceRewardPrompt: "",
            sourceRewardCanvases: null,
            targetPolicyPrompt: "",
            targetPolicyCanvases: null,
            targetStateUpdatePrompt: "",
            targetStatePolicyCanvases: null,
            targetRewardPrompt: "",
            targetRewardCanvases: null,
            targetFields: createEmptyOrchestrationEnvironmentPlayer().fields,
            targetSkills: [],
            targetDatasets: [],
            targetUploadedFiles: [],
            policyPrompt: "",
            policyCanvases: null,
          });
    agentsById.set(
      agentId,
      await resolveBoundRuntime({
        project: args.project,
        agentId,
        fallback,
        supabase,
        versionCache,
      })
    );
  }

  return {
    sourceAgentId,
    sourceAgent,
    agentsById,
    connectedTargets,
  };
}
