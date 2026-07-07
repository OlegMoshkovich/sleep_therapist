import {
  normalizeCanvasDoc,
  type CanvasDoc,
  type CanvasEntry,
} from "@airlab/canvas-compiler/types";
import {
  normalizeDatasets,
  serializeDatasets,
} from "@airlab/canvas-core/components/setup/dataset-schema";
import {
  createEmptyOrchestrationProject,
  createEmptyOrchestrationEnvironmentPlayer,
  ensureConversationMemoryFields,
  getRuntimePolicyCanvasDoc,
  getWorkflowOverviewCanvasDoc,
  makeOrchestrationId,
  normalizeLatestInteractionStateFields,
  normalizeStateIngressAppendNodes,
  slugify,
  syncDerivedPrompts,
  syncAgentConnectionDerivedPrompts,
  upsertWorkflowOverviewCanvasDoc,
  type OrchestrationAgentConnection,
  type OrchestrationAgentConnectionInvocationMode,
  type OrchestrationEnvironmentPlayer,
  type OrchestrationField,
  type OrchestrationGuidelineBlock,
  type OrchestrationProject,
  type OrchestrationProjectAgentBinding,
  type OrchestrationSkill,
  type OrchestrationUploadedFile,
} from "./general-orchestration";
import { autoTagCanvasActionSubtypes } from "@airlab/canvas-rules/canvas-code-action-autotag";
import {
  resolveInteractionProtocol,
  serializeInteractionProtocol,
} from "./interaction-protocol";

export interface StoredOrchestrationStateField {
  field_name?: string;
  type?: OrchestrationField["type"];
  initial_value?: string | null;
}

export interface StoredOrchestrationCanvasRow {
  canvas_id?: string;
  name?: string;
  sort_order?: number | null;
  canvas?: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeFieldType(value: unknown): OrchestrationField["type"] {
  return value === "integer" ||
    value === "boolean" ||
    value === "string[]" ||
    value === "number" ||
    value === "json"
    ? value
    : "string";
}

export function normalizeStateSchema(
  raw: StoredOrchestrationStateField[] | null | undefined,
  fallback: OrchestrationField[]
): OrchestrationField[] {
  const fields = Array.isArray(raw)
    ? raw
        .map((field) => {
          const name = asString(field?.field_name);
          if (!name) {
            return null;
          }

          return {
            id: makeOrchestrationId(),
            name,
            type: normalizeFieldType(field?.type),
            initialValue:
              field?.initial_value === null ? "null" : String(field?.initial_value ?? ""),
          };
        })
        .filter((field): field is OrchestrationField => field !== null)
    : [];

  return ensureConversationMemoryFields(fields.length > 0 ? fields : fallback);
}

export function normalizeGuidelineBlocks(
  raw: unknown,
  fallback: OrchestrationGuidelineBlock[]
): OrchestrationGuidelineBlock[] {
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

  const guidelines = items
    .map((item) => {
      const obj = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const topic = asString(obj.topic);
      const content = asString(obj.content);
      const problem = asString(obj.problem);
      const recommendation = asString(obj.recommendation);

      if (!topic && !content && !problem && !recommendation) {
        return null;
      }

      return {
        id: makeOrchestrationId(),
        topic,
        content,
        problem,
        recommendation,
      };
    })
    .filter(
      (guideline): guideline is OrchestrationGuidelineBlock => guideline !== null
    );

  return guidelines.length > 0 ? guidelines : fallback;
}

export function normalizeUploadedFiles(raw: unknown): OrchestrationUploadedFile[] {
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

  return items.reduce<OrchestrationUploadedFile[]>((acc, item) => {
    if (!item || typeof item !== "object") {
      return acc;
    }

    const file = item as Record<string, unknown>;
    const name = asString(file.name);
    if (!name) {
      return acc;
    }

    acc.push({
      id: asString(file.id) || makeOrchestrationId(),
      name,
      size:
        typeof file.size === "number" && Number.isFinite(file.size)
          ? file.size
          : 0,
      type: asString(file.type),
      bucket: asString(file.bucket) || undefined,
      path: asString(file.path) || undefined,
      url: asString(file.url) || undefined,
      isObjectUrl: file.isObjectUrl === true,
      uploaded_by_email: asString(file.uploaded_by_email) || null,
      uploaded_by_uuid: asString(file.uploaded_by_uuid) || undefined,
      uploaded_at: asString(file.uploaded_at) || undefined,
    });

    return acc;
  }, []);
}

export function buildCanvasDoc(
  rows: StoredOrchestrationCanvasRow[]
): CanvasDoc | null {
  if (rows.length === 0) {
    return null;
  }

  const canvases = [...rows]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .flatMap((row) => {
      if (!row.canvas || typeof row.canvas !== "object") {
        return [];
      }

      const canvas = row.canvas as CanvasEntry;
      return [
        {
          ...canvas,
          id: row.canvas_id || canvas.id,
          name: row.name || canvas.name,
        },
      ];
    });

  if (canvases.length === 0) {
    return null;
  }

  return normalizeCanvasDoc({
    version: 2,
    activeId: canvases[0].id,
    canvases,
  });
}

function normalizeEmbeddedCanvasDoc(raw: unknown): CanvasDoc | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  return normalizeCanvasDoc(raw as CanvasDoc);
}

function normalizeSkills(
  raw: unknown,
  fallback: OrchestrationSkill[]
): OrchestrationSkill[] {
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

  const skills = items.reduce<OrchestrationSkill[]>((acc, item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return acc;
    }

    const skill = item as Record<string, unknown>;
    const name = asString(skill.name) || `Skill ${index + 1}`;
    acc.push({
      id: asString(skill.id) || makeOrchestrationId(),
      name,
      startConditionCanvases: normalizeEmbeddedCanvasDoc(
        skill.startConditionCanvases ?? skill.start_condition_canvases
      ),
      policyPrompt:
        asString(skill.policyPrompt ?? skill.policy_prompt) || "",
      policyCanvases: normalizeEmbeddedCanvasDoc(
        skill.policyCanvases ?? skill.policy_canvases
      ),
      terminationConditionCanvases: normalizeEmbeddedCanvasDoc(
        skill.terminationConditionCanvases ??
          skill.termination_condition_canvases
      ),
    });
    return acc;
  }, []);

  return skills.length > 0 ? skills : fallback;
}

function serializeSkills(skills: OrchestrationSkill[]) {
  return (skills ?? []).map((skill) => ({
    id: skill.id,
    name: skill.name,
    start_condition_canvases: skill.startConditionCanvases,
    policy_prompt: skill.policyPrompt,
    policy_canvases: skill.policyCanvases,
    termination_condition_canvases: skill.terminationConditionCanvases,
  }));
}

export function serializeStateSchema(fields: OrchestrationField[]) {
  return normalizeLatestInteractionStateFields(fields)
    .map((field) => ({
      field_name: field.name.trim(),
      type: field.type,
      initial_value: field.initialValue === "null" ? null : field.initialValue,
    }))
    .filter((field) => field.field_name.length > 0);
}

export function serializeUploadedFiles(files: OrchestrationUploadedFile[]) {
  return files.map((file) => ({
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type,
    bucket: file.bucket,
    path: file.path,
    url: file.url,
    uploaded_by_email: file.uploaded_by_email ?? null,
    uploaded_by_uuid: file.uploaded_by_uuid,
    uploaded_at: file.uploaded_at,
  }));
}

export function serializeGuidelines(guidelines: OrchestrationGuidelineBlock[]) {
  return guidelines.map((guideline) => ({
    topic: guideline.topic,
    content: guideline.content,
    problem: guideline.problem,
    recommendation: guideline.recommendation,
  }));
}

export function serializeCanvasRows(doc: CanvasDoc | null) {
  return (doc?.canvases ?? []).map((canvas, index) => ({
    canvas_id: canvas.id,
    name: canvas.name,
    sort_order: index,
    canvas,
  }));
}

function normalizeEnvironmentPlayers(
  raw: unknown,
  fallback: OrchestrationEnvironmentPlayer[]
): OrchestrationEnvironmentPlayer[] {
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

  const players = items.reduce<OrchestrationEnvironmentPlayer[]>((acc, item) => {
    if (!item || typeof item !== "object") {
      return acc;
    }

    const player = item as Record<string, unknown>;
    const defaults = createEmptyOrchestrationEnvironmentPlayer();

    const fields = normalizeStateSchema(
      Array.isArray(player.state_schema)
        ? (player.state_schema as StoredOrchestrationStateField[])
        : null,
      defaults.fields
    );
    const policyCanvases =
      normalizeEmbeddedCanvasDoc(player.policy_canvases) ??
      defaults.policyCanvases;
    const statePolicyCanvases =
      normalizeEmbeddedCanvasDoc(player.state_policy_canvases) ??
      defaults.statePolicyCanvases;

    acc.push({
      id: asString(player.id) || defaults.id,
      fields,
      stateUpdatePrompt:
        asString(player.state_update_prompt) || defaults.stateUpdatePrompt,
      policyPrompt: asString(player.policy_prompt) || defaults.policyPrompt,
      policyCanvases,
      statePolicyCanvases,
      skills: normalizeSkills(player.skills, defaults.skills),
      guidelines: normalizeGuidelineBlocks(
        player.guideline_blocks,
        defaults.guidelines
      ),
      datasets: normalizeDatasets(player.datasets, makeOrchestrationId),
      uploadedFiles: normalizeUploadedFiles(player.uploaded_files),
    });

    return acc;
  }, []);

  return players.length > 0 ? players : fallback;
}

function serializeEnvironmentPlayers(players: OrchestrationEnvironmentPlayer[]) {
  return players.map((player) => ({
    id: player.id,
    state_schema: serializeStateSchema(player.fields),
    state_update_prompt: player.stateUpdatePrompt,
    policy_prompt: player.policyPrompt,
    guideline_blocks: serializeGuidelines(player.guidelines),
    datasets: serializeDatasets(player.datasets),
    uploaded_files: serializeUploadedFiles(player.uploadedFiles),
    policy_canvases: player.policyCanvases,
    state_policy_canvases: player.statePolicyCanvases,
    skills: serializeSkills(player.skills),
  }));
}

function normalizeCanvasDocValue(value: unknown): CanvasDoc | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return normalizeCanvasDoc(value as CanvasDoc);
}

function normalizeFieldOverrides(raw: unknown): OrchestrationField[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const fields = raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const field = item as Record<string, unknown>;
    const name = asString(field.field_name ?? field.name);
    if (!name) {
      return [];
    }

    return [
      {
        id: asString(field.id) || makeOrchestrationId(),
        name,
        type: normalizeFieldType(field.type),
        initialValue:
          field.initial_value === null
            ? "null"
            : String(field.initial_value ?? field.initialValue ?? ""),
      },
    ];
  });

  return normalizeLatestInteractionStateFields(fields);
}

function normalizeAgentBindings(
  raw: unknown,
  fallback: OrchestrationProjectAgentBinding[]
): OrchestrationProjectAgentBinding[] {
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

  const bindings = items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const binding = item as Record<string, unknown>;
    const id = asString(binding.id);
    const templateId = asString(binding.template_id ?? binding.templateId);
    const templateVersionId = asString(
      binding.template_version_id ?? binding.templateVersionId
    );
    if (!id || !templateId || !templateVersionId) {
      return [];
    }

    return [
      {
        id,
        templateId,
        templateVersionId,
        title: asString(binding.title),
        roleContext: asString(binding.role_context ?? binding.roleContext),
        fieldOverrides: normalizeFieldOverrides(
          binding.field_overrides ?? binding.fieldOverrides
        ),
        datasetOverrides: normalizeDatasets(
          binding.dataset_overrides ?? binding.datasetOverrides,
          makeOrchestrationId
        ),
        uploadedFileOverrides: normalizeUploadedFiles(
          binding.uploaded_file_overrides ?? binding.uploadedFileOverrides
        ),
        skillOverrides: normalizeSkills(
          binding.skill_overrides ?? binding.skillOverrides,
          []
        ),
        policyCanvasesOverride: normalizeCanvasDocValue(
          binding.policy_canvases_override ?? binding.policyCanvasesOverride
        ),
        statePolicyCanvasesOverride: normalizeCanvasDocValue(
          binding.state_policy_canvases_override ??
            binding.statePolicyCanvasesOverride
        ),
      },
    ];
  });

  return bindings.length > 0 ? bindings : fallback;
}

function serializeAgentBindings(bindings: OrchestrationProjectAgentBinding[]) {
  return bindings.map((binding) => ({
    id: binding.id,
    template_id: binding.templateId,
    template_version_id: binding.templateVersionId,
    title: binding.title,
    role_context: binding.roleContext,
    field_overrides: serializeStateSchema(binding.fieldOverrides),
    dataset_overrides: serializeDatasets(binding.datasetOverrides),
    uploaded_file_overrides: serializeUploadedFiles(binding.uploadedFileOverrides),
    skill_overrides: serializeSkills(binding.skillOverrides ?? []),
    policy_canvases_override: binding.policyCanvasesOverride,
    state_policy_canvases_override: binding.statePolicyCanvasesOverride,
  }));
}

function normalizeInvocationMode(
  value: unknown
): OrchestrationAgentConnectionInvocationMode {
  return value === "async" ? "async" : "sync";
}

function normalizeAgentConnections(
  raw: unknown,
  fallback: OrchestrationAgentConnection[],
  sourceAgentId: string
): OrchestrationAgentConnection[] {
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

  const connections = items.reduce<OrchestrationAgentConnection[]>((acc, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return acc;
    }

    const connection = item as Record<string, unknown>;
    const targetDefaults = createEmptyOrchestrationEnvironmentPlayer();
    const targetAgentId = asString(
      connection.target_agent_id ?? connection.targetAgentId
    );
    if (!targetAgentId) {
      return acc;
    }

    const targetFields = normalizeFieldOverrides(
      connection.target_fields ?? connection.targetFields
    );
    const normalized = syncAgentConnectionDerivedPrompts({
      id: asString(connection.id) || makeOrchestrationId(),
      workflowStageId: asString(
        connection.workflow_stage_id ?? connection.workflowStageId
      ),
      workflowStageName: asString(
        connection.workflow_stage_name ?? connection.workflowStageName
      ),
      targetAgentSharedId: asString(
        connection.target_agent_shared_id ?? connection.targetAgentSharedId
      ),
      sourceAgentId:
        asString(connection.source_agent_id ?? connection.sourceAgentId) ||
        sourceAgentId,
      targetAgentId,
      targetAgentTitle: asString(
        connection.target_agent_title ?? connection.targetAgentTitle
      ),
      purpose: asString(connection.purpose),
      invocationMode: normalizeInvocationMode(
        connection.invocation_mode ?? connection.invocationMode
      ),
      sourcePolicyPrompt: asString(
        connection.source_policy_prompt ?? connection.sourcePolicyPrompt
      ),
      sourcePolicyCanvases: normalizeEmbeddedCanvasDoc(
        connection.source_policy_canvases ?? connection.sourcePolicyCanvases
      ),
      sourceStateUpdatePrompt: asString(
        connection.source_state_update_prompt ??
          connection.sourceStateUpdatePrompt
      ),
      sourceStatePolicyCanvases: normalizeEmbeddedCanvasDoc(
        connection.source_state_policy_canvases ??
          connection.sourceStatePolicyCanvases
      ),
      sourceRewardPrompt: asString(
        connection.source_reward_prompt ?? connection.sourceRewardPrompt
      ),
      sourceRewardCanvases: normalizeEmbeddedCanvasDoc(
        connection.source_reward_canvases ?? connection.sourceRewardCanvases
      ),
      targetPolicyPrompt: asString(
        connection.target_policy_prompt ??
          connection.targetPolicyPrompt ??
          connection.policy_prompt ??
          connection.policyPrompt
      ),
      targetPolicyCanvases: normalizeEmbeddedCanvasDoc(
        connection.target_policy_canvases ??
          connection.targetPolicyCanvases ??
          connection.policy_canvases ??
          connection.policyCanvases
      ),
      targetStateUpdatePrompt: asString(
        connection.target_state_update_prompt ??
          connection.targetStateUpdatePrompt
      ),
      targetStatePolicyCanvases: normalizeEmbeddedCanvasDoc(
        connection.target_state_policy_canvases ??
          connection.targetStatePolicyCanvases
      ),
      targetRewardPrompt: asString(
        connection.target_reward_prompt ?? connection.targetRewardPrompt
      ),
      targetRewardCanvases: normalizeEmbeddedCanvasDoc(
        connection.target_reward_canvases ?? connection.targetRewardCanvases
      ),
      targetFields: targetFields.length > 0 ? targetFields : targetDefaults.fields,
      targetSkills: normalizeSkills(
        connection.target_skills ?? connection.targetSkills,
        targetDefaults.skills
      ),
      targetDatasets: normalizeDatasets(
        connection.target_datasets ?? connection.targetDatasets,
        makeOrchestrationId
      ) || targetDefaults.datasets,
      targetUploadedFiles: normalizeUploadedFiles(
        connection.target_uploaded_files ?? connection.targetUploadedFiles
      ),
      policyPrompt: asString(
        connection.policy_prompt ?? connection.policyPrompt
      ),
      policyCanvases: normalizeEmbeddedCanvasDoc(
        connection.policy_canvases ?? connection.policyCanvases
      ),
    });
    acc.push(normalized);
    return acc;
  }, []);

  return connections.length > 0 ? connections : fallback;
}

function serializeAgentConnections(connections: OrchestrationAgentConnection[]) {
  return connections.map((connection) => ({
    id: connection.id,
    workflow_stage_id: connection.workflowStageId,
    workflow_stage_name: connection.workflowStageName,
    target_agent_shared_id: connection.targetAgentSharedId,
    source_agent_id: connection.sourceAgentId,
    target_agent_id: connection.targetAgentId,
    target_agent_title: connection.targetAgentTitle,
    purpose: connection.purpose,
    invocation_mode: connection.invocationMode,
    source_policy_prompt: connection.sourcePolicyPrompt,
    source_policy_canvases: connection.sourcePolicyCanvases,
    source_state_update_prompt: connection.sourceStateUpdatePrompt,
    source_state_policy_canvases: connection.sourceStatePolicyCanvases,
    source_reward_prompt: connection.sourceRewardPrompt,
    source_reward_canvases: connection.sourceRewardCanvases,
    target_policy_prompt: connection.targetPolicyPrompt,
    target_policy_canvases: connection.targetPolicyCanvases,
    target_state_update_prompt: connection.targetStateUpdatePrompt,
    target_state_policy_canvases: connection.targetStatePolicyCanvases,
    target_reward_prompt: connection.targetRewardPrompt,
    target_reward_canvases: connection.targetRewardCanvases,
    target_fields: serializeStateSchema(connection.targetFields),
    target_skills: serializeSkills(connection.targetSkills),
    target_datasets: serializeDatasets(connection.targetDatasets),
    target_uploaded_files: serializeUploadedFiles(connection.targetUploadedFiles),
    policy_prompt: connection.policyPrompt,
    policy_canvases: connection.policyCanvases,
  }));
}

export function hydrateStoredOrchestrationProject(args: {
  configId?: string | null;
  agentId?: string | null;
  title?: string | null;
  slug?: string | null;
  summary?: string | null;
  policyIntent?: string | null;
  status?: string | null;
  stateSchema?: StoredOrchestrationStateField[] | null;
  stateUpdatePrompt?: string | null;
  policyPrompt?: string | null;
  guidelineBlocks?: unknown;
  datasets?: unknown;
  sharedDatasets?: unknown;
  interactionProtocol?: unknown;
  skills?: unknown;
  uploadedFiles?: unknown;
  agentBindings?: unknown;
  agentConnections?: unknown;
  environmentPlayers?: unknown;
  workflowCanvases?: StoredOrchestrationCanvasRow[];
  policyCanvases?: StoredOrchestrationCanvasRow[];
  statePolicyCanvases?: StoredOrchestrationCanvasRow[];
  defaults?: OrchestrationProject;
  loadedStatus?: string;
  syncPrompts?: boolean;
  autoTagActionSubtypes?: boolean;
}): OrchestrationProject {
  const defaults = args.defaults ?? createEmptyOrchestrationProject();
  const title = asString(args.title) || defaults.meta.title;
  const slug = asString(args.slug) || slugify(title || defaults.meta.slug);
  const agentId = asString(args.agentId) || asString(args.configId) || defaults.agentId || defaults.id;
  const environmentPlayers = normalizeEnvironmentPlayers(
    args.environmentPlayers,
    defaults.environmentPlayers
  );
  const agentConnections = normalizeAgentConnections(
    args.agentConnections,
    defaults.agentConnections,
    agentId
  );
  const agentBindings = normalizeAgentBindings(
    args.agentBindings,
    defaults.agents
  );
  const storedPolicyCanvases = buildCanvasDoc(args.policyCanvases ?? []);
  const storedWorkflowCanvases = buildCanvasDoc(args.workflowCanvases ?? []);
  const workflowCanvases =
    getWorkflowOverviewCanvasDoc(storedWorkflowCanvases) ??
    getWorkflowOverviewCanvasDoc(storedPolicyCanvases) ??
    getWorkflowOverviewCanvasDoc(defaults.workflowCanvases) ??
    getWorkflowOverviewCanvasDoc(defaults.policyCanvases);
  const policyCanvases =
    getRuntimePolicyCanvasDoc(storedPolicyCanvases) ??
    getRuntimePolicyCanvasDoc(defaults.policyCanvases);

  const hydrated: OrchestrationProject = {
    ...defaults,
    id: asString(args.configId) || defaults.id,
    agentId,
    meta: {
      ...defaults.meta,
      title,
      slug,
      summary: asString(args.summary) || defaults.meta.summary,
      policyIntent: asString(args.policyIntent) || defaults.meta.policyIntent,
      status: (() => {
        const storedStatus = asString(args.status);
        if (storedStatus) {
          return storedStatus;
        }
        if (asString(args.configId) || asString(args.title)) {
          return args.loadedStatus || "Loaded from saved storage.";
        }
        return defaults.meta.status;
      })(),
    },
    fields: normalizeStateSchema(args.stateSchema, defaults.fields),
    stateUpdatePrompt: asString(args.stateUpdatePrompt) || defaults.stateUpdatePrompt,
    policyPrompt: asString(args.policyPrompt) || defaults.policyPrompt,
    workflowCanvases,
    policyCanvases,
    statePolicyCanvases:
      buildCanvasDoc(args.statePolicyCanvases ?? []) ||
      defaults.statePolicyCanvases,
    skills: normalizeSkills(args.skills, defaults.skills),
    guidelines: normalizeGuidelineBlocks(args.guidelineBlocks, defaults.guidelines),
    datasets:
      normalizeDatasets(args.datasets, makeOrchestrationId) || defaults.datasets,
    sharedDatasets: normalizeDatasets(args.sharedDatasets, makeOrchestrationId),
    interactionProtocol: resolveInteractionProtocol(
      args.interactionProtocol ?? defaults.interactionProtocol,
      {
        environmentFields: environmentPlayers[0]?.fields,
      }
    ),
    uploadedFiles: normalizeUploadedFiles(args.uploadedFiles),
    agents: agentBindings,
    agentConnections: agentConnections.map((connection) => ({
      ...connection,
      sourceAgentId: connection.sourceAgentId || agentId,
    })),
    environmentPlayers,
  };

  const runtimeStateSchema = hydrated.fields.map((field) => ({
    fieldName: field.name,
    type: field.type,
    initialValue: field.initialValue,
  }));

  if (args.autoTagActionSubtypes === true) {
    hydrated.policyCanvases = autoTagCanvasActionSubtypes(
      hydrated.policyCanvases,
      runtimeStateSchema
    );
    hydrated.statePolicyCanvases = autoTagCanvasActionSubtypes(
      hydrated.statePolicyCanvases,
      runtimeStateSchema
    );
  }

  hydrated.statePolicyCanvases = normalizeStateIngressAppendNodes(
    hydrated.statePolicyCanvases,
    hydrated.fields
  );

  return args.syncPrompts === false ? hydrated : syncDerivedPrompts(hydrated);
}

export function serializeOrchestrationProject(
  project: OrchestrationProject,
  options: { titleFallback?: string } = {}
) {
  const syncedProject = syncDerivedPrompts(project);
  const runtimePolicyCanvases = getRuntimePolicyCanvasDoc(
    syncedProject.policyCanvases
  );
  const workflowCanvases = getWorkflowOverviewCanvasDoc(
    syncedProject.workflowCanvases
  );
  const projectForReturn: OrchestrationProject = {
    ...syncedProject,
    workflowCanvases,
    policyCanvases: runtimePolicyCanvases,
  };
  const legacyPolicyCanvasStorageDoc = upsertWorkflowOverviewCanvasDoc(
    runtimePolicyCanvases,
    workflowCanvases
  );
  const title = syncedProject.meta.title.trim() || options.titleFallback || "Untitled Setup";

  return {
    project: projectForReturn,
    configName: title,
    routeSlug: syncedProject.meta.slug.trim() || slugify(title),
    summary: syncedProject.meta.summary,
    policyIntent: syncedProject.meta.policyIntent,
    status: syncedProject.meta.status,
    uploadedFiles: serializeUploadedFiles(syncedProject.uploadedFiles),
    stateSchema: serializeStateSchema(syncedProject.fields),
    stateUpdatePrompt: syncedProject.stateUpdatePrompt,
    policyPrompt: syncedProject.policyPrompt,
    guidelineBlocks: serializeGuidelines(syncedProject.guidelines),
    datasets: serializeDatasets(syncedProject.datasets),
    sharedDatasets: serializeDatasets(
      Array.isArray(syncedProject.sharedDatasets)
        ? syncedProject.sharedDatasets
        : []
    ),
    interactionProtocol: serializeInteractionProtocol(
      syncedProject.interactionProtocol,
      {
        environmentFields: syncedProject.environmentPlayers[0]?.fields,
      }
    ),
    skills: serializeSkills(syncedProject.skills),
    agentId: syncedProject.agentId || syncedProject.id,
    agentBindings: serializeAgentBindings(syncedProject.agents),
    agentConnections: serializeAgentConnections(syncedProject.agentConnections),
    environmentPlayers: serializeEnvironmentPlayers(syncedProject.environmentPlayers),
    workflowCanvases: serializeCanvasRows(workflowCanvases),
    policyCanvases: serializeCanvasRows(legacyPolicyCanvasStorageDoc),
    statePolicyCanvases: serializeCanvasRows(syncedProject.statePolicyCanvases),
  };
}
