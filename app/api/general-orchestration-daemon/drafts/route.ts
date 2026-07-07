import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getRequestUserUUID } from "../../../lib/admin-auth";
import {
  createEmptyOrchestrationProject,
  makeOrchestrationId,
} from "../../../lib/general-orchestration";
import {
  createInitialDaemonDraftMessages,
  GENERAL_ORCHESTRATION_DAEMON_INITIAL_STATUS,
  normalizeDaemonDraftMessages,
  type DaemonDraftInteractionMode,
  type DaemonDraftMessage,
} from "../../../lib/general-orchestration-daemon-drafts";
import {
  createDaemonDraft,
  listDaemonDrafts,
} from "../../../lib/general-orchestration-daemon-draft-store";
import {
  generateDaemonOpeningMessage,
  loadDaemonRuntimeConfig,
  scopeDaemonRuntimeConfigToWorkflowStage,
} from "../../../lib/general-orchestration-daemon-runtime";
import { resolveOpenAiApiKey } from "../../../lib/openai-config";
import { createSupabaseAdminClient } from "../../../lib/supabase-admin";

interface CreateDraftBody {
  project?: ReturnType<typeof createEmptyOrchestrationProject>;
  messages?: unknown;
  interactionMode?: unknown;
}

function normalizeInteractionMode(value: unknown): DaemonDraftInteractionMode {
  return value === "automated" || value === "lazy" ? value : "chat";
}

export async function GET() {
  const userUUID = await getRequestUserUUID();
  if (!userUUID) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createSupabaseAdminClient();
    const drafts = await listDaemonDrafts(supabase, userUUID);
    return NextResponse.json({ drafts });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load daemon drafts.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const userUUID = await getRequestUserUUID();
  if (!userUUID) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as CreateDraftBody;
    const emptyProject = createEmptyOrchestrationProject();
    const project = body.project ?? {
      ...emptyProject,
      meta: {
        ...emptyProject.meta,
        status: GENERAL_ORCHESTRATION_DAEMON_INITIAL_STATUS,
      },
    };
    const hasSeedMessages = Object.prototype.hasOwnProperty.call(
      body,
      "messages"
    );
    let messages = hasSeedMessages
      ? normalizeDaemonDraftMessages(body.messages)
      : [];
    if (!hasSeedMessages && messages.length === 0) {
      const openai = new OpenAI({ apiKey: resolveOpenAiApiKey() });
      const runtimeConfig = await loadDaemonRuntimeConfig();
      const openingMessage = await generateDaemonOpeningMessage(
        openai,
        scopeDaemonRuntimeConfigToWorkflowStage(runtimeConfig, null)
      );
      messages = createInitialDaemonDraftMessages(openingMessage).map((message) => ({
        ...message,
        id: message.id || makeOrchestrationId(),
      }));
    }
    const supabase = createSupabaseAdminClient();
    const draft = await createDaemonDraft({
      supabase,
      userUUID,
      project,
      messages,
      interactionMode: normalizeInteractionMode(body.interactionMode),
    });

    return NextResponse.json({ draft });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to create daemon draft.",
      },
      { status: 500 }
    );
  }
}
