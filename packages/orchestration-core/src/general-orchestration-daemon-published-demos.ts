import { GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE } from "./general-orchestration-daemon-drafts";

export const GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE =
  GENERAL_ORCHESTRATION_DAEMON_DRAFT_TABLE;

export const GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMO_TOPIC_PREFIX =
  "published:";

export interface PublishedDaemonDemoRow {
  id?: string | null;
  expert_id?: string | null;
  endpoint?: string | null;
  config_name?: string | null;
  route_slug?: string | null;
  setup_summary?: string | null;
  workspace_status?: string | null;
  updated_at?: string | null;
  published_at?: string | null;
}

export interface PublishedDaemonDemoSummary {
  id: string;
  title: string;
  routeSlug: string;
  endpoint: string;
  summary: string;
  status: string;
  updatedAt: string;
  canDelete?: boolean;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildPublishedDaemonDemoSummary(
  row: PublishedDaemonDemoRow
): PublishedDaemonDemoSummary {
  const routeSlug = asString(row.route_slug) || "agent-0";
  return {
    id: asString(row.id),
    title: asString(row.config_name) || "Agent-0",
    routeSlug,
    endpoint: asString(row.endpoint) || `/demo/${routeSlug}`,
    summary: asString(row.setup_summary),
    status: asString(row.workspace_status) || "Published",
    updatedAt:
      asString(row.published_at) ||
      asString(row.updated_at) ||
      new Date(0).toISOString(),
  };
}
