import { NextRequest, NextResponse } from "next/server";

import { resolveCurrentUser } from "../../../../lib/admin-auth";
import {
  GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE,
} from "../../../../lib/general-orchestration-daemon-published-demos";
import { createSupabaseAdminClient } from "../../../../lib/supabase-admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

type SupabaseClient = ReturnType<typeof createSupabaseAdminClient>;

function normalizeSlug(value: string) {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

async function deleteSetupRows(args: {
  supabase: SupabaseClient;
  table: string;
  setupId: string;
}) {
  const filters = {
    setup_table: args.table,
    setup_id: args.setupId,
  };

  const [policyCanvases, statePolicyCanvases, executionPlans] =
    await Promise.all([
      args.supabase
        .from("policy_canvases")
        .delete()
        .match(filters),
      args.supabase
        .from("state_policy_canvases")
        .delete()
        .match(filters),
      args.supabase
        .from("canvas_execution_plans")
        .delete()
        .match(filters),
    ]);

  const error =
    policyCanvases.error ?? statePolicyCanvases.error ?? executionPlans.error;
  if (error) {
    throw new Error(error.message);
  }
}

export async function DELETE(_request: NextRequest, ctx: RouteContext) {
  try {
    const { slug: rawSlug } = await ctx.params;
    const slug = normalizeSlug(rawSlug);
    if (!slug || slug.includes("/") || slug === "general-orchestration-daemon") {
      return NextResponse.json({ error: "Unknown demo" }, { status: 404 });
    }

    const me = await resolveCurrentUser();
    if (!me) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createSupabaseAdminClient();
    const { data: row, error: lookupError } = await supabase
      .from(GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE)
      .select("id, expert_id, endpoint")
      .eq("endpoint", `/demo/${slug}`)
      .maybeSingle();

    if (lookupError) {
      throw new Error(lookupError.message);
    }

    if (!row) {
      return NextResponse.json({ error: "Unknown demo" }, { status: 404 });
    }

    const rowId = String((row as { id?: unknown }).id ?? "");
    const ownerId = String((row as { expert_id?: unknown }).expert_id ?? "");
    if (!rowId || (!me.isAdmin && ownerId !== me.userUUID)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await deleteSetupRows({
      supabase,
      table: GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE,
      setupId: rowId,
    });

    const { error: deleteError } = await supabase
      .from(GENERAL_ORCHESTRATION_DAEMON_PUBLISHED_DEMOS_TABLE)
      .delete()
      .eq("id", rowId)
      .eq("endpoint", `/demo/${slug}`);

    if (deleteError) {
      throw new Error(deleteError.message);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to delete published demo.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
