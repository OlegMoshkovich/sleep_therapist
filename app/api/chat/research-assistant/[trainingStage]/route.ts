import { NextRequest, NextResponse } from "next/server";
import { POST as handleBaseChatRequest } from "../../route";
import { handleFineTunedChatRequest } from "../../route_ft_1";

const RESEARCH_ASSISTANT_FT_1_MODEL =
  process.env.AIRLAB_FT_RESEARCH_ASSISTANT_STAGE_1 ??
  "ft:gpt-4.1-2025-04-14:personal:triage-stateful2:DSEr4D6R";

const RESEARCH_ASSISTANT_CHAT_ROUTE_REGISTRY = {
  base: {
    kind: "base",
  },
  "ft-1": {
    kind: "fine-tuned",
    model: RESEARCH_ASSISTANT_FT_1_MODEL,
  },
} as const;

type ResearchAssistantChatRouteConfig =
  | { kind: "base" }
  | { kind: "fine-tuned"; model: string };

function resolveRouteConfig(
  trainingStage: string
): ResearchAssistantChatRouteConfig | null {
  return (
    RESEARCH_ASSISTANT_CHAT_ROUTE_REGISTRY[
      trainingStage as keyof typeof RESEARCH_ASSISTANT_CHAT_ROUTE_REGISTRY
    ] ?? null
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ trainingStage: string }> }
) {
  const { trainingStage } = await params;
  const routeConfig = resolveRouteConfig(trainingStage);

  console.log("[api/chat/research-assistant] incoming", {
    trainingStage,
    resolved: routeConfig?.kind ?? "none",
    referer: request.headers.get("referer") ?? "(none)",
  });

  if (!routeConfig) {
    return NextResponse.json(
      { error: `Unknown research-assistant chat training stage: ${trainingStage}` },
      { status: 404 }
    );
  }

  if (routeConfig.kind === "base") {
    console.log("[api/chat/research-assistant] -> base handler (/api/chat route.ts)");
    return handleBaseChatRequest(request);
  }

  console.log("[api/chat/research-assistant] -> fine-tuned handler (route_ft_1.ts)", {
    model: routeConfig.model,
  });
  return handleFineTunedChatRequest(request, routeConfig.model);
}
