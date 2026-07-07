import { NextResponse } from "next/server";

import {
  GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE,
  buildPublishedDaemonDemoSummary,
  type PublishedDaemonDemoRow,
} from "../../../lib/general-orchestration-daemon-published-demos";
import { resolveCurrentUser } from "../../../lib/admin-auth";
import { createSupabaseAdminClient } from "../../../lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const me = await resolveCurrentUser();
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from(GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE)
    .select(
      "id, expert_id, endpoint, config_name, route_slug, setup_summary, workspace_status, updated_at"
    )
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const publishedRows = ((data ?? []) as PublishedDaemonDemoRow[]).filter((row) => {
    const endpoint = typeof row.endpoint === "string" ? row.endpoint.trim() : "";
    return (
      endpoint !== "/demo/general-orchestration-daemon" &&
      /^\/demo\/[^/]+\/?$/.test(endpoint)
    );
  });

  return NextResponse.json({
    demos: publishedRows.map((row) => {
      const summary = buildPublishedDaemonDemoSummary(row);
      const ownerId = typeof row.expert_id === "string" ? row.expert_id : "";
      return {
        ...summary,
        canDelete: Boolean(me && (me.isAdmin || ownerId === me.userUUID)),
      };
    }),
  });
}
