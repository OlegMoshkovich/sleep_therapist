import {
  GENERAL_ORCHESTRATION_DAEMON_DRAFT_ENDPOINT,
  GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE,
} from "./general-orchestration-daemon-drafts";
import { GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE } from "./general-orchestration-daemon-config";

export interface AgentTemplateProjectReferencesSupabaseClient {
  from: (table: string) => any;
}

type SupabaseClient = AgentTemplateProjectReferencesSupabaseClient;

export type AgentTemplateProjectReferenceKind =
  | "draft"
  | "published"
  | "setup";

export interface AgentTemplateProjectReference {
  id: string;
  kind: AgentTemplateProjectReferenceKind;
  projectId: string;
  projectTitle: string;
  routeSlug: string;
  endpoint: string;
  status: string;
  updatedAt: string;
  bindingId: string;
  bindingTitle: string;
  templateVersionId: string;
}

interface ReferenceRow {
  id?: unknown;
  endpoint?: unknown;
  config_name?: unknown;
  route_slug?: unknown;
  workspace_status?: unknown;
  updated_at?: unknown;
  agent_bindings?: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readAgentBindings(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item)
    );
  }
  if (typeof value === "string") {
    try {
      return readAgentBindings(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  return [];
}

function readBindingTemplateId(binding: Record<string, unknown>): string {
  return asString(binding.template_id ?? binding.templateId);
}

function isMissingReferenceColumnsError(
  error: { message?: string } | null | undefined
): boolean {
  const message = (error?.message ?? "").toLowerCase();
  return (
    message.includes("agent_bindings") ||
    message.includes("schema cache")
  );
}

function classifyReferenceKind(args: {
  table: string;
  endpoint: string;
}): AgentTemplateProjectReferenceKind {
  if (args.table === GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE) {
    return "setup";
  }
  if (
    args.endpoint === GENERAL_ORCHESTRATION_DAEMON_DRAFT_ENDPOINT ||
    args.endpoint === "/demo/general-orchestration-daemon"
  ) {
    return "draft";
  }
  return "published";
}

function buildProjectTitle(
  row: ReferenceRow,
  kind: AgentTemplateProjectReferenceKind
): string {
  const title = asString(row.config_name);
  if (title) {
    return title;
  }
  if (kind === "published") {
    return "Published demo";
  }
  if (kind === "setup") {
    return "Daemon setup";
  }
  return "Untitled draft";
}

async function loadReferencesFromTable(args: {
  supabase: SupabaseClient;
  table: string;
  select: string;
  templateIds: Set<string>;
}): Promise<Map<string, AgentTemplateProjectReference[]>> {
  const references = new Map(
    [...args.templateIds].map((id) => [id, [] as AgentTemplateProjectReference[]])
  );
  const { data, error } = await args.supabase.from(args.table).select(args.select);

  if (error) {
    if (isMissingReferenceColumnsError(error)) {
      return references;
    }
    throw new Error(error.message);
  }

  for (const row of (data ?? []) as ReferenceRow[]) {
    const projectId = asString(row.id);
    const endpoint = asString(row.endpoint);
    const routeSlug = asString(row.route_slug);
    const kind = classifyReferenceKind({ table: args.table, endpoint });
    const projectTitle = buildProjectTitle(row, kind);
    const status =
      asString(row.workspace_status) ||
      (kind === "published" ? "Published" : kind === "setup" ? "Setup" : "Draft");
    const updatedAt = asString(row.updated_at);

    readAgentBindings(row.agent_bindings).forEach((binding, index) => {
      const templateId = readBindingTemplateId(binding);
      if (!args.templateIds.has(templateId)) {
        return;
      }

      const bindingId = asString(binding.id) || `binding-${index + 1}`;
      references.get(templateId)?.push({
        id: `${kind}:${projectId || "unknown"}:${bindingId}:${index}`,
        kind,
        projectId,
        projectTitle,
        routeSlug,
        endpoint,
        status,
        updatedAt,
        bindingId,
        bindingTitle: asString(binding.title),
        templateVersionId: asString(
          binding.template_version_id ?? binding.templateVersionId
        ),
      });
    });
  }

  return references;
}

function mergeReferenceMaps(
  base: Map<string, AgentTemplateProjectReference[]>,
  next: Map<string, AgentTemplateProjectReference[]>
) {
  for (const [templateId, entries] of next.entries()) {
    base.set(templateId, [...(base.get(templateId) ?? []), ...entries]);
  }
}

export async function loadAgentTemplateProjectReferences(
  supabase: SupabaseClient,
  templateIds: string[]
): Promise<Map<string, AgentTemplateProjectReference[]>> {
  const idSet = new Set(templateIds.map((id) => id.trim()).filter(Boolean));
  const references = new Map(
    [...idSet].map((id) => [id, [] as AgentTemplateProjectReference[]])
  );
  if (idSet.size === 0) {
    return references;
  }

  const [draftReferences, setupReferences] = await Promise.all([
    loadReferencesFromTable({
      supabase,
      table: GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE,
      select:
        "id, endpoint, config_name, route_slug, workspace_status, updated_at, agent_bindings",
      templateIds: idSet,
    }),
    loadReferencesFromTable({
      supabase,
      table: GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE,
      select: "id, endpoint, config_name, updated_at, agent_bindings",
      templateIds: idSet,
    }),
  ]);

  mergeReferenceMaps(references, draftReferences);
  mergeReferenceMaps(references, setupReferences);

  for (const [templateId, entries] of references.entries()) {
    references.set(
      templateId,
      [...entries].sort((a, b) => {
        const aTime = new Date(a.updatedAt).getTime();
        const bTime = new Date(b.updatedAt).getTime();
        return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      })
    );
  }

  return references;
}

export async function countAgentTemplateProjectReferences(
  supabase: SupabaseClient,
  templateIds: string[]
): Promise<Map<string, number>> {
  const references = await loadAgentTemplateProjectReferences(
    supabase,
    templateIds
  );
  return new Map(
    [...references.entries()].map(([templateId, entries]) => [
      templateId,
      entries.length,
    ])
  );
}
