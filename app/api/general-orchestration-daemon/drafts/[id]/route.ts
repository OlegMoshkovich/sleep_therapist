import { NextRequest, NextResponse } from "next/server";
import { getRequestUserUUID } from "../../../../lib/admin-auth";
import type { OrchestrationProject } from "../../../../lib/general-orchestration";
import {
  normalizeDaemonDraftMessages,
  type DaemonDraftInteractionMode,
  type DaemonDraftState,
  type DaemonDraftMessage,
} from "../../../../lib/general-orchestration-daemon-drafts";
import {
  deleteDaemonDraft,
  loadDaemonDraft,
  saveDaemonDraft,
} from "../../../../lib/general-orchestration-daemon-draft-store";
import { createSupabaseAdminClient } from "../../../../lib/supabase-admin";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface UpdateDraftBody {
  project?: OrchestrationProject;
  messages?: DaemonDraftMessage[];
  daemonState?: DaemonDraftState | null;
  interactionMode?: unknown;
}

function normalizeInteractionMode(
  value: unknown
): DaemonDraftInteractionMode | undefined {
  return value === "chat" || value === "lazy" || value === "automated"
    ? value
    : undefined;
}

export async function GET(_request: NextRequest, ctx: RouteContext) {
  const userUUID = await getRequestUserUUID();
  if (!userUUID) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  try {
    const supabase = createSupabaseAdminClient();
    const draft = await loadDaemonDraft(supabase, userUUID, id);
    if (!draft) {
      return NextResponse.json({ error: "Draft not found." }, { status: 404 });
    }
    return NextResponse.json({ draft });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load daemon draft.",
      },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest, ctx: RouteContext) {
  const userUUID = await getRequestUserUUID();
  if (!userUUID) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as UpdateDraftBody;

  if (!body.project) {
    return NextResponse.json({ error: "Missing project." }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdminClient();
    const draft = await saveDaemonDraft({
      supabase,
      userUUID,
      draftId: id,
      project: body.project,
      daemonState: body.daemonState,
      interactionMode: normalizeInteractionMode(body.interactionMode),
      messages:
        body.messages !== undefined
          ? normalizeDaemonDraftMessages(body.messages)
          : undefined,
    });

    if (!draft) {
      return NextResponse.json({ error: "Draft not found." }, { status: 404 });
    }

    return NextResponse.json({ draft });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to save daemon draft.",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(_request: NextRequest, ctx: RouteContext) {
  const userUUID = await getRequestUserUUID();
  if (!userUUID) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  try {
    const supabase = createSupabaseAdminClient();
    const deleted = await deleteDaemonDraft(supabase, userUUID, id);
    if (!deleted) {
      return NextResponse.json({ error: "Draft not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete daemon draft.",
      },
      { status: 500 }
    );
  }
}
