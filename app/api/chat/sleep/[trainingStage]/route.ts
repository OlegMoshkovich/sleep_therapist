import { NextRequest, NextResponse } from "next/server";
import { POST as handleBaseChatRequest } from "../../route";
import { handleFineTunedChatRequest } from "../../route_ft_1";

const SLEEP_FT_1_MODEL =
  process.env.AIRLAB_FT_SLEEP_STAGE_1 ??
  "ft:gpt-4.1-2025-04-14:personal:triage-stateful2:DSEr4D6R";

const SLEEP_CHAT_ROUTE_REGISTRY = {
  base: {
    kind: "base",
  },
  "ft-1": {
    kind: "fine-tuned",
    model: SLEEP_FT_1_MODEL,
  },
} as const;

type SleepChatRouteConfig = { kind: "base" } | { kind: "fine-tuned"; model: string };

function resolveSleepChatRouteConfig(trainingStage: string): SleepChatRouteConfig | null {
  return SLEEP_CHAT_ROUTE_REGISTRY[trainingStage as keyof typeof SLEEP_CHAT_ROUTE_REGISTRY] ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ trainingStage: string }> }
) {
  const { trainingStage } = await params;
  const routeConfig = resolveSleepChatRouteConfig(trainingStage);

  console.log("[api/chat/sleep] incoming", {
    trainingStage,
    resolved: routeConfig?.kind ?? "none",
    referer: request.headers.get("referer") ?? "(none)",
  });

  if (!routeConfig) {
    return NextResponse.json(
      { error: `Unknown sleep chat training stage: ${trainingStage}` },
      { status: 404 }
    );
  }

  if (routeConfig.kind === "base") {
    console.log("[api/chat/sleep] -> base handler (/api/chat route.ts)");
    return handleBaseChatRequest(request);
  }

  console.log("[api/chat/sleep] -> fine-tuned handler (route_ft_1.ts)", {
    model: routeConfig.model,
  });
  return handleFineTunedChatRequest(request, routeConfig.model);
}
