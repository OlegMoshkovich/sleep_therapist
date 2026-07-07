import { normalizeCanvasDoc, type CanvasDoc } from "@airlab/canvas-compiler/types";
import {
  normalizeDatasets,
  serializeDatasets,
  type SimulationPlayerDataset,
} from "@airlab/canvas-core/components/setup/dataset-schema";
import {
  makeOrchestrationId,
  normalizeLatestInteractionStateFields,
  slugify,
  type OrchestrationField,
  type OrchestrationFieldType,
  type OrchestrationGuidelineBlock,
  type OrchestrationSkill,
  type OrchestrationUploadedFile,
} from "./general-orchestration";

export const AGENT_TEMPLATE_TABLE = "agent_templates";
export const AGENT_TEMPLATE_VERSION_TABLE = "agent_template_versions";
export const STARTER_AGENT_TEMPLATE_ID =
  "00000000-0000-4000-8000-000000000101";
export const STARTER_AGENT_TEMPLATE_VERSION_ID =
  "00000000-0000-4000-8000-000000000102";

export interface AgentTemplateCatalogSupabaseClient {
  from: (table: string) => any;
}

export type AgentTemplateCatalogSupabaseFactory =
  () => AgentTemplateCatalogSupabaseClient;

type SupabaseClient = AgentTemplateCatalogSupabaseClient;

let supabaseFactory: AgentTemplateCatalogSupabaseFactory | null = null;

export function registerAgentTemplateCatalogSupabaseFactory(
  factory: AgentTemplateCatalogSupabaseFactory | null
): void {
  supabaseFactory = factory;
}

function createAgentTemplateCatalogSupabaseClient(): SupabaseClient {
  if (!supabaseFactory) {
    throw new Error(
      "Agent template catalog Supabase factory is not registered."
    );
  }
  return supabaseFactory();
}

export type AgentTemplateVisibility = "private" | "shared" | "published";
export type AgentTemplateVersionStatus = "draft" | "published" | "archived";

export interface AgentTemplateVersion {
  id: string;
  templateId: string;
  versionNumber: number;
  versionLabel: string;
  status: AgentTemplateVersionStatus;
  defaultFields: OrchestrationField[];
  defaultStateUpdatePrompt: string;
  defaultPolicyPrompt: string;
  defaultGuidelines: OrchestrationGuidelineBlock[];
  defaultDatasets: SimulationPlayerDataset[];
  defaultUploadedFiles: OrchestrationUploadedFile[];
  defaultSkills: OrchestrationSkill[];
  defaultPolicyCanvases: CanvasDoc | null;
  defaultStatePolicyCanvases: CanvasDoc | null;
  defaultRewardPrompt: string;
  defaultRewardCanvases: CanvasDoc | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentTemplate {
  id: string;
  ownerId: string | null;
  slug: string;
  title: string;
  description: string;
  visibility: AgentTemplateVisibility;
  latestVersionId: string | null;
  versions: AgentTemplateVersion[];
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentTemplateRow {
  id?: string | null;
  owner_id?: string | null;
  slug?: string | null;
  title?: string | null;
  description?: string | null;
  visibility?: string | null;
  latest_version_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface AgentTemplateVersionRow {
  id?: string | null;
  template_id?: string | null;
  version_number?: number | null;
  version_label?: string | null;
  status?: string | null;
  default_state_schema?: unknown;
  default_state_update_prompt?: string | null;
  default_policy_prompt?: string | null;
  default_guideline_blocks?: unknown;
  default_datasets?: unknown;
  default_uploaded_files?: unknown;
  default_skills?: unknown;
  default_policy_canvases?: unknown;
  default_state_policy_canvases?: unknown;
  default_reward_prompt?: string | null;
  default_reward_canvases?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface AgentTemplateDraft {
  ownerId?: string | null;
  slug?: string;
  title: string;
  description?: string;
  visibility?: AgentTemplateVisibility;
  versionLabel?: string;
  versionStatus?: AgentTemplateVersionStatus;
  defaultFields?: OrchestrationField[];
  defaultStateUpdatePrompt?: string;
  defaultPolicyPrompt?: string;
  defaultGuidelines?: OrchestrationGuidelineBlock[];
  defaultDatasets?: SimulationPlayerDataset[];
  defaultUploadedFiles?: OrchestrationUploadedFile[];
  defaultSkills?: OrchestrationSkill[];
  defaultPolicyCanvases?: CanvasDoc | null;
  defaultStatePolicyCanvases?: CanvasDoc | null;
  defaultRewardPrompt?: string;
  defaultRewardCanvases?: CanvasDoc | null;
}

export interface AgentTemplateMatch {
  template: AgentTemplate;
  score: number;
  reason: string;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeVisibility(value: unknown): AgentTemplateVisibility {
  return value === "shared" || value === "published" ? value : "private";
}

function normalizeVersionStatus(value: unknown): AgentTemplateVersionStatus {
  return value === "published" || value === "archived" ? value : "draft";
}

function normalizeFieldType(value: unknown): OrchestrationFieldType {
  return value === "integer" ||
    value === "boolean" ||
    value === "string[]" ||
    value === "number" ||
    value === "json"
    ? value
    : "string";
}

function replaceAgentRolePhrase(match: string, pluralSuffix: string): string {
  const replacement = `agent${pluralSuffix}`;
  if (match === match.toUpperCase()) {
    return replacement.toUpperCase();
  }
  return /^[A-Z]/.test(match)
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
    : replacement;
}

function normalizeTemplateCatalogText(value: string): string {
  return value
    .replace(/\bLegacy Environment Agent\b/g, "Legacy Agent")
    .replace(/\bLegacy Target Agent\b/g, "Legacy Agent")
    .replace(
      /\bTemplate materialized from a legacy embedded environment agent\./g,
      "Template materialized from a legacy embedded agent."
    )
    .replace(
      /\bPreviously stored as an embedded environment agent in this project\./g,
      "Previously stored as an embedded agent in this project."
    )
    .replace(
      /\bSaved from primary-side per-connection canvases\./g,
      "Saved from reusable agent canvases."
    )
    .replace(
      /\bSaved from target-side per-connection canvases\./g,
      "Saved from reusable agent canvases."
    )
    .replace(/\bPrimary per-connection canvas snapshot\b/g, "Agent canvas snapshot")
    .replace(/\bTarget per-connection canvas snapshot\b/g, "Agent canvas snapshot")
    .replace(/\bprimary agent(s?)\b/gi, replaceAgentRolePhrase)
    .replace(/\benvironment agent(s?)\b/gi, replaceAgentRolePhrase)
    .trim();
}

function normalizeTemplateCatalogCanvasDoc(doc: CanvasDoc): CanvasDoc {
  return {
    ...doc,
    canvases: doc.canvases.map((canvas) => ({
      ...canvas,
      name: normalizeTemplateCatalogText(canvas.name),
      freeText: normalizeTemplateCatalogText(canvas.freeText ?? ""),
      graph: {
        ...canvas.graph,
        nodes: canvas.graph.nodes.map((node) => ({
          ...node,
          data: {
            ...node.data,
            label:
              typeof node.data?.label === "string"
                ? normalizeTemplateCatalogText(node.data.label)
                : node.data?.label,
          },
        })),
        edges: canvas.graph.edges.map((edge) => ({
          ...edge,
          label:
            typeof edge.label === "string"
              ? normalizeTemplateCatalogText(edge.label)
              : edge.label,
        })),
      },
    })),
  };
}

function normalizeCanvasDocValue(value: unknown): CanvasDoc | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return normalizeCanvasDoc(value as CanvasDoc);
}

function normalizeTemplateFields(raw: unknown): OrchestrationField[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const fields = raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const record = item as Record<string, unknown>;
    const name = asString(record.field_name ?? record.name);
    if (!name) {
      return [];
    }

    return [
      {
        id: asString(record.id) || makeOrchestrationId(),
        name,
        type: normalizeFieldType(record.type),
        initialValue:
          record.initial_value === null
            ? "null"
            : String(record.initial_value ?? record.initialValue ?? ""),
      },
    ];
  });

  return normalizeLatestInteractionStateFields(fields);
}

function serializeTemplateFields(fields: OrchestrationField[]) {
  return normalizeLatestInteractionStateFields(fields).map((field) => ({
    field_name: field.name,
    type: field.type,
    initial_value: field.initialValue,
  }));
}

function normalizeGuidelineBlocks(raw: unknown): OrchestrationGuidelineBlock[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const record = item as Record<string, unknown>;
    const topic = asString(record.topic);
    const content = asString(record.content);
    const problem = asString(record.problem);
    const recommendation = asString(record.recommendation);
    if (!topic && !content && !problem && !recommendation) {
      return [];
    }

    return [
      {
        id: asString(record.id) || makeOrchestrationId(),
        topic,
        content,
        problem,
        recommendation,
      },
    ];
  });
}

function serializeGuidelineBlocks(guidelines: OrchestrationGuidelineBlock[]) {
  return guidelines.map((guideline) => ({
    topic: guideline.topic,
    content: guideline.content,
    problem: guideline.problem,
    recommendation: guideline.recommendation,
  }));
}

function normalizeUploadedFiles(raw: unknown): OrchestrationUploadedFile[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const record = item as Record<string, unknown>;
    const name = asString(record.name);
    if (!name) {
      return [];
    }

    return [
      {
        id: asString(record.id) || makeOrchestrationId(),
        name,
        size:
          typeof record.size === "number" && Number.isFinite(record.size)
            ? record.size
            : 0,
        type: asString(record.type),
        bucket: asString(record.bucket) || undefined,
        path: asString(record.path) || undefined,
        url: asString(record.url) || undefined,
        isObjectUrl: record.isObjectUrl === true,
        uploaded_by_email: asString(record.uploaded_by_email) || null,
        uploaded_by_uuid: asString(record.uploaded_by_uuid) || undefined,
        uploaded_at: asString(record.uploaded_at) || undefined,
      },
    ];
  });
}

function serializeUploadedFiles(files: OrchestrationUploadedFile[]) {
  return files.map((file) => ({
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type,
    bucket: file.bucket,
    path: file.path,
    url: file.url,
    isObjectUrl: file.isObjectUrl,
    uploaded_by_email: file.uploaded_by_email ?? null,
    uploaded_by_uuid: file.uploaded_by_uuid,
    uploaded_at: file.uploaded_at,
  }));
}

function normalizeSkills(raw: unknown): OrchestrationSkill[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const record = item as Record<string, unknown>;
    const name = asString(record.name);
    if (!name) {
      return [];
    }

    return [
      {
        id: asString(record.id) || makeOrchestrationId(),
        name,
        startConditionCanvases: normalizeCanvasDocValue(
          record.start_condition_canvases ?? record.startConditionCanvases
        ),
        policyPrompt: asString(record.policy_prompt ?? record.policyPrompt),
        policyCanvases: normalizeCanvasDocValue(
          record.policy_canvases ?? record.policyCanvases
        ),
        terminationConditionCanvases: normalizeCanvasDocValue(
          record.termination_condition_canvases ??
            record.terminationConditionCanvases
        ),
      },
    ];
  });
}

function serializeSkills(skills: OrchestrationSkill[]) {
  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    start_condition_canvases: skill.startConditionCanvases,
    policy_prompt: skill.policyPrompt,
    policy_canvases: skill.policyCanvases,
    termination_condition_canvases: skill.terminationConditionCanvases,
  }));
}

export function hydrateAgentTemplateVersion(
  row: AgentTemplateVersionRow
): AgentTemplateVersion {
  return {
    id: asString(row.id) || makeOrchestrationId(),
    templateId: asString(row.template_id),
    versionNumber:
      typeof row.version_number === "number" && Number.isFinite(row.version_number)
        ? Math.max(1, Math.trunc(row.version_number))
        : 1,
    versionLabel: normalizeTemplateCatalogText(asString(row.version_label)),
    status: normalizeVersionStatus(row.status),
    defaultFields: normalizeTemplateFields(row.default_state_schema),
    defaultStateUpdatePrompt: asString(row.default_state_update_prompt),
    defaultPolicyPrompt: asString(row.default_policy_prompt),
    defaultGuidelines: normalizeGuidelineBlocks(row.default_guideline_blocks),
    defaultDatasets: normalizeDatasets(
      row.default_datasets,
      makeOrchestrationId
    ),
    defaultUploadedFiles: normalizeUploadedFiles(row.default_uploaded_files),
    defaultSkills: normalizeSkills(row.default_skills),
    defaultPolicyCanvases: normalizeCanvasDocValue(row.default_policy_canvases),
    defaultStatePolicyCanvases: normalizeCanvasDocValue(
      row.default_state_policy_canvases
    ),
    defaultRewardPrompt: asString(row.default_reward_prompt),
    defaultRewardCanvases: normalizeCanvasDocValue(row.default_reward_canvases),
    createdAt: asString(row.created_at) || undefined,
    updatedAt: asString(row.updated_at) || undefined,
  };
}

export function hydrateAgentTemplate(
  row: AgentTemplateRow,
  versionRows: AgentTemplateVersionRow[] = []
): AgentTemplate {
  return {
    id: asString(row.id) || makeOrchestrationId(),
    ownerId: asString(row.owner_id) || null,
    slug: asString(row.slug),
    title:
      normalizeTemplateCatalogText(asString(row.title)) ||
      "Untitled Agent Template",
    description: normalizeTemplateCatalogText(asString(row.description)),
    visibility: normalizeVisibility(row.visibility),
    latestVersionId: asString(row.latest_version_id) || null,
    versions: versionRows.map(hydrateAgentTemplateVersion),
    createdAt: asString(row.created_at) || undefined,
    updatedAt: asString(row.updated_at) || undefined,
  };
}

function buildTemplateVersionInsertPayload(
  templateId: string,
  draft: AgentTemplateDraft,
  versionNumber = 1
) {
  return {
    template_id: templateId,
    version_number: versionNumber,
    version_label: draft.versionLabel
      ? normalizeTemplateCatalogText(draft.versionLabel)
      : null,
    status: draft.versionStatus ?? "draft",
    default_state_schema: serializeTemplateFields(draft.defaultFields ?? []),
    default_state_update_prompt: draft.defaultStateUpdatePrompt?.trim() ?? "",
    default_policy_prompt: draft.defaultPolicyPrompt?.trim() ?? "",
    default_guideline_blocks: serializeGuidelineBlocks(
      draft.defaultGuidelines ?? []
    ),
    default_datasets: serializeDatasets(draft.defaultDatasets ?? []),
    default_uploaded_files: serializeUploadedFiles(draft.defaultUploadedFiles ?? []),
    default_skills: serializeSkills(draft.defaultSkills ?? []),
    default_policy_canvases: draft.defaultPolicyCanvases
      ? normalizeTemplateCatalogCanvasDoc(draft.defaultPolicyCanvases)
      : null,
    default_state_policy_canvases: draft.defaultStatePolicyCanvases
      ? normalizeTemplateCatalogCanvasDoc(draft.defaultStatePolicyCanvases)
      : null,
    default_reward_prompt: draft.defaultRewardPrompt?.trim() ?? "",
    default_reward_canvases: draft.defaultRewardCanvases
      ? normalizeTemplateCatalogCanvasDoc(draft.defaultRewardCanvases)
      : null,
  };
}

export async function createAgentTemplateDraft(
  draft: AgentTemplateDraft,
  options?: { supabase?: SupabaseClient }
): Promise<AgentTemplate> {
  const supabase = options?.supabase ?? createAgentTemplateCatalogSupabaseClient();
  const slug = draft.slug?.trim() || slugify(draft.title || "agent-template");
  const { data: templateRow, error: templateError } = await supabase
    .from(AGENT_TEMPLATE_TABLE)
    .insert({
      owner_id: draft.ownerId ?? null,
      slug,
      title:
        normalizeTemplateCatalogText(draft.title) || "Untitled Agent Template",
      description: normalizeTemplateCatalogText(draft.description ?? ""),
      visibility: draft.visibility ?? "private",
    })
    .select("*")
    .single();

  if (templateError || !templateRow) {
    throw new Error(templateError?.message ?? "Failed to create agent template.");
  }

  const templateId = String((templateRow as AgentTemplateRow).id ?? "");
  const { data: versionRow, error: versionError } = await supabase
    .from(AGENT_TEMPLATE_VERSION_TABLE)
    .insert(buildTemplateVersionInsertPayload(templateId, draft))
    .select("*")
    .single();

  if (versionError || !versionRow) {
    throw new Error(
      versionError?.message ?? "Failed to create agent template version."
    );
  }

  const versionId = String((versionRow as AgentTemplateVersionRow).id ?? "");
  const { data: updatedTemplateRow, error: updateError } = await supabase
    .from(AGENT_TEMPLATE_TABLE)
    .update({ latest_version_id: versionId, updated_at: new Date().toISOString() })
    .eq("id", templateId)
    .select("*")
    .single();

  if (updateError || !updatedTemplateRow) {
    throw new Error(
      updateError?.message ?? "Failed to attach latest agent template version."
    );
  }

  return hydrateAgentTemplate(updatedTemplateRow as AgentTemplateRow, [
    versionRow as AgentTemplateVersionRow,
  ]);
}

export async function updateAgentTemplateWithNewVersion(args: {
  templateId: string;
  title: string;
  description: string;
  visibility: AgentTemplateVisibility;
  versionLabel?: string;
  versionStatus?: AgentTemplateVersionStatus;
  defaultFields?: AgentTemplateDraft["defaultFields"];
  defaultStateUpdatePrompt?: string;
  defaultPolicyPrompt?: string;
  defaultGuidelines?: AgentTemplateDraft["defaultGuidelines"];
  defaultDatasets?: AgentTemplateDraft["defaultDatasets"];
  defaultUploadedFiles?: AgentTemplateDraft["defaultUploadedFiles"];
  defaultSkills?: AgentTemplateDraft["defaultSkills"];
  defaultPolicyCanvases?: CanvasDoc | null;
  defaultStatePolicyCanvases?: CanvasDoc | null;
  defaultRewardPrompt?: string;
  defaultRewardCanvases?: CanvasDoc | null;
  supabase?: SupabaseClient;
}): Promise<AgentTemplate> {
  const supabase = args.supabase ?? createAgentTemplateCatalogSupabaseClient();
  const existing = await loadAgentTemplateWithVersions(args.templateId, {
    supabase,
  });
  if (!existing) {
    throw new Error("Agent template not found.");
  }

  const latestVersion = existing.versions[0] ?? null;
  const nextVersionNumber =
    Math.max(0, ...existing.versions.map((version) => version.versionNumber)) + 1;
  const hasPolicyCanvas = Object.prototype.hasOwnProperty.call(
    args,
    "defaultPolicyCanvases"
  );
  const hasStateCanvas = Object.prototype.hasOwnProperty.call(
    args,
    "defaultStatePolicyCanvases"
  );
  const hasRewardCanvas = Object.prototype.hasOwnProperty.call(
    args,
    "defaultRewardCanvases"
  );
  const versionDraft: AgentTemplateDraft = {
    ownerId: existing.ownerId,
    title: args.title,
    slug: existing.slug,
    description: args.description,
    visibility: args.visibility,
    versionLabel:
      args.versionLabel?.trim() || `Version ${nextVersionNumber}`,
    versionStatus: args.versionStatus ?? latestVersion?.status ?? "draft",
    defaultFields: args.defaultFields ?? latestVersion?.defaultFields ?? [],
    defaultStateUpdatePrompt:
      args.defaultStateUpdatePrompt ??
      latestVersion?.defaultStateUpdatePrompt ??
      "",
    defaultPolicyPrompt:
      args.defaultPolicyPrompt ?? latestVersion?.defaultPolicyPrompt ?? "",
    defaultRewardPrompt:
      args.defaultRewardPrompt ?? latestVersion?.defaultRewardPrompt ?? "",
    defaultGuidelines:
      args.defaultGuidelines ?? latestVersion?.defaultGuidelines ?? [],
    defaultDatasets: args.defaultDatasets ?? latestVersion?.defaultDatasets ?? [],
    defaultUploadedFiles:
      args.defaultUploadedFiles ?? latestVersion?.defaultUploadedFiles ?? [],
    defaultSkills: args.defaultSkills ?? latestVersion?.defaultSkills ?? [],
    defaultPolicyCanvases: hasPolicyCanvas
      ? args.defaultPolicyCanvases ?? null
      : latestVersion?.defaultPolicyCanvases ?? null,
    defaultStatePolicyCanvases: hasStateCanvas
      ? args.defaultStatePolicyCanvases ?? null
      : latestVersion?.defaultStatePolicyCanvases ?? null,
    defaultRewardCanvases: hasRewardCanvas
      ? args.defaultRewardCanvases ?? null
      : latestVersion?.defaultRewardCanvases ?? null,
  };

  const { data: versionRow, error: versionError } = await supabase
    .from(AGENT_TEMPLATE_VERSION_TABLE)
    .insert(
      buildTemplateVersionInsertPayload(
        args.templateId,
        versionDraft,
        nextVersionNumber
      )
    )
    .select("*")
    .single();

  if (versionError || !versionRow) {
    throw new Error(
      versionError?.message ?? "Failed to create agent template version."
    );
  }

  const versionId = String((versionRow as AgentTemplateVersionRow).id ?? "");
  const { data: templateRow, error: templateError } = await supabase
    .from(AGENT_TEMPLATE_TABLE)
    .update({
      title:
        normalizeTemplateCatalogText(args.title) ||
        normalizeTemplateCatalogText(existing.title),
      description: normalizeTemplateCatalogText(args.description),
      visibility: args.visibility,
      latest_version_id: versionId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.templateId)
    .select("*")
    .single();

  if (templateError || !templateRow) {
    throw new Error(
      templateError?.message ?? "Failed to update agent template."
    );
  }

  const updated = await loadAgentTemplateWithVersions(args.templateId, {
    supabase,
  });
  return (
    updated ??
    hydrateAgentTemplate(templateRow as AgentTemplateRow, [
      versionRow as AgentTemplateVersionRow,
    ])
  );
}

export async function deleteAgentTemplate(args: {
  templateId: string;
  supabase?: SupabaseClient;
}): Promise<void> {
  const supabase = args.supabase ?? createAgentTemplateCatalogSupabaseClient();
  const { error: detachError } = await supabase
    .from(AGENT_TEMPLATE_TABLE)
    .update({ latest_version_id: null, updated_at: new Date().toISOString() })
    .eq("id", args.templateId);

  if (detachError) {
    throw new Error(detachError.message);
  }

  const { error } = await supabase
    .from(AGENT_TEMPLATE_TABLE)
    .delete()
    .eq("id", args.templateId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function findAgentTemplateByOwnerSlug(args: {
  ownerId?: string | null;
  slug: string;
  supabase?: SupabaseClient;
}): Promise<AgentTemplate | null> {
  const supabase = args.supabase ?? createAgentTemplateCatalogSupabaseClient();
  let query = supabase
    .from(AGENT_TEMPLATE_TABLE)
    .select("*")
    .eq("slug", args.slug)
    .order("updated_at", { ascending: false })
    .limit(1);

  query =
    args.ownerId === undefined || args.ownerId === null
      ? query.is("owner_id", null)
      : query.eq("owner_id", args.ownerId);

  const { data: templateRows, error: templateError } = await query;
  if (templateError) {
    throw new Error(templateError.message);
  }

  const templateRow = ((templateRows ?? []) as AgentTemplateRow[])[0];
  if (!templateRow?.id) {
    return null;
  }

  const { data: versionRows, error: versionError } = await supabase
    .from(AGENT_TEMPLATE_VERSION_TABLE)
    .select("*")
    .eq("template_id", templateRow.id)
    .order("version_number", { ascending: false });

  if (versionError) {
    throw new Error(versionError.message);
  }

  return hydrateAgentTemplate(
    templateRow,
    (versionRows ?? []) as AgentTemplateVersionRow[]
  );
}

export async function listAgentTemplates(args?: {
  ownerId?: string | null;
  visibility?: AgentTemplateVisibility;
  supabase?: SupabaseClient;
}): Promise<AgentTemplate[]> {
  const supabase = args?.supabase ?? createAgentTemplateCatalogSupabaseClient();
  let query = supabase
    .from(AGENT_TEMPLATE_TABLE)
    .select("*")
    .order("updated_at", { ascending: false });

  if (args?.ownerId !== undefined) {
    query = args.ownerId ? query.eq("owner_id", args.ownerId) : query.is("owner_id", null);
  }
  if (args?.visibility) {
    query = query.eq("visibility", args.visibility);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as AgentTemplateRow[]).map((row) =>
    hydrateAgentTemplate(row)
  );
}

export async function loadAgentTemplateWithVersions(
  templateId: string,
  options?: { supabase?: SupabaseClient }
): Promise<AgentTemplate | null> {
  const supabase = options?.supabase ?? createAgentTemplateCatalogSupabaseClient();
  const { data: templateRow, error: templateError } = await supabase
    .from(AGENT_TEMPLATE_TABLE)
    .select("*")
    .eq("id", templateId)
    .maybeSingle();

  if (templateError) {
    throw new Error(templateError.message);
  }
  if (!templateRow) {
    return null;
  }

  const { data: versionRows, error: versionError } = await supabase
    .from(AGENT_TEMPLATE_VERSION_TABLE)
    .select("*")
    .eq("template_id", templateId)
    .order("version_number", { ascending: false });

  if (versionError) {
    throw new Error(versionError.message);
  }

  return hydrateAgentTemplate(
    templateRow as AgentTemplateRow,
    (versionRows ?? []) as AgentTemplateVersionRow[]
  );
}

const TEMPLATE_MATCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "role",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

function normalizeMatchText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeMatchText(value: string): string[] {
  return normalizeMatchText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !TEMPLATE_MATCH_STOP_WORDS.has(token));
}

function tokenOverlapScore(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0 || candidateTokens.length === 0) {
    return 0;
  }
  const candidateSet = new Set(candidateTokens);
  const overlap = queryTokens.filter((token) => candidateSet.has(token)).length;
  return overlap / Math.max(queryTokens.length, candidateTokens.length);
}

function scoreTemplateForRole(args: {
  template: AgentTemplate;
  title: string;
  description: string;
  roleContext: string;
}): AgentTemplateMatch {
  const roleTitle = normalizeMatchText(args.title);
  const templateTitle = normalizeMatchText(args.template.title);
  const roleTokens = tokenizeMatchText(
    [args.title, args.description, args.roleContext].filter(Boolean).join(" ")
  );
  const roleTitleTokens = tokenizeMatchText(args.title);
  const templateTitleTokens = tokenizeMatchText(args.template.title);
  const templateAllTokens = tokenizeMatchText(
    [args.template.title, args.template.description].filter(Boolean).join(" ")
  );

  if (roleTitle && templateTitle && roleTitle === templateTitle) {
    return { template: args.template, score: 1, reason: "exact title match" };
  }

  const titleContains =
    roleTitle.length > 3 &&
    templateTitle.length > 3 &&
    (roleTitle.includes(templateTitle) || templateTitle.includes(roleTitle));
  const titleOverlap = tokenOverlapScore(roleTitleTokens, templateTitleTokens);
  const allOverlap = tokenOverlapScore(roleTokens, templateAllTokens);
  const score = Math.max(
    titleContains ? 0.9 : 0,
    titleOverlap * 0.85 + allOverlap * 0.15,
    allOverlap * 0.75
  );

  return {
    template: args.template,
    score,
    reason: titleContains ? "title containment match" : "keyword match",
  };
}

function dedupeTemplates(templates: AgentTemplate[]): AgentTemplate[] {
  const seen = new Set<string>();
  return templates.filter((template) => {
    const id = template.id.trim();
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

export async function listReusableAgentTemplates(args?: {
  ownerId?: string | null;
  supabase?: SupabaseClient;
}): Promise<AgentTemplate[]> {
  const supabase = args?.supabase ?? createAgentTemplateCatalogSupabaseClient();
  const queries = [];
  if (args?.ownerId) {
    queries.push(
      supabase.from(AGENT_TEMPLATE_TABLE).select("*").eq("owner_id", args.ownerId)
    );
  }
  queries.push(
    supabase.from(AGENT_TEMPLATE_TABLE).select("*").is("owner_id", null)
  );
  queries.push(
    supabase
      .from(AGENT_TEMPLATE_TABLE)
      .select("*")
      .in("visibility", ["shared", "published"])
  );
  const results = await Promise.all(queries.map((query) => query.order("updated_at", { ascending: false })));
  const firstError = results.find((result) => result.error)?.error;
  if (firstError) {
    throw new Error(firstError.message);
  }

  return dedupeTemplates(
    results.flatMap((result) =>
      ((result.data ?? []) as AgentTemplateRow[]).map((row) =>
        hydrateAgentTemplate(row)
      )
    )
  );
}

export async function findReusableAgentTemplateMatch(args: {
  ownerId?: string | null;
  title: string;
  description?: string;
  roleContext?: string;
  minScore?: number;
  supabase?: SupabaseClient;
}): Promise<AgentTemplateMatch | null> {
  const title = args.title.trim();
  if (!title) {
    return null;
  }

  const templates = await listReusableAgentTemplates({
    ownerId: args.ownerId,
    supabase: args.supabase,
  });
  const matches = templates
    .map((template) =>
      scoreTemplateForRole({
        template,
        title,
        description: args.description ?? "",
        roleContext: args.roleContext ?? "",
      })
    )
    .sort((a, b) => b.score - a.score);
  const best = matches[0];
  const minScore = args.minScore ?? 0.62;
  if (!best || best.score < minScore) {
    return null;
  }

  const templateWithVersions =
    (await loadAgentTemplateWithVersions(best.template.id, {
      supabase: args.supabase,
    })) ?? best.template;
  return {
    ...best,
    template: templateWithVersions,
  };
}

export async function loadAgentTemplateVersion(
  versionId: string,
  options?: { supabase?: SupabaseClient }
): Promise<AgentTemplateVersion | null> {
  const supabase = options?.supabase ?? createAgentTemplateCatalogSupabaseClient();
  const { data, error } = await supabase
    .from(AGENT_TEMPLATE_VERSION_TABLE)
    .select("*")
    .eq("id", versionId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? hydrateAgentTemplateVersion(data as AgentTemplateVersionRow) : null;
}
