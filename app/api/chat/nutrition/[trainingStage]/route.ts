import { NextRequest, NextResponse } from "next/server";
import { POST as handleBaseChatRequest } from "../../route";
import { handleFineTunedChatRequest } from "../../route_ft_1";

const NUTRITION_FT_1_MODEL =
  process.env.AIRLAB_FT_NUTRITION_STAGE_1 ??
  "ft:gpt-4.1-2025-04-14:personal:triage-stateful2:DSEr4D6R";

const NUTRITION_CHAT_ROUTE_REGISTRY = {
  base: {
    kind: "base",
  },
  "ft-1": {
    kind: "fine-tuned",
    model: NUTRITION_FT_1_MODEL,
  },
} as const;

type NutritionChatRouteConfig =
  | { kind: "base" }
  | { kind: "fine-tuned"; model: string };

function resolveNutritionChatRouteConfig(
  trainingStage: string
): NutritionChatRouteConfig | null {
  return (
    NUTRITION_CHAT_ROUTE_REGISTRY[
      trainingStage as keyof typeof NUTRITION_CHAT_ROUTE_REGISTRY
    ] ?? null
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ trainingStage: string }> }
) {
  const { trainingStage } = await params;
  const routeConfig = resolveNutritionChatRouteConfig(trainingStage);

  console.log("[api/chat/nutrition] incoming", {
    trainingStage,
    resolved: routeConfig?.kind ?? "none",
    referer: request.headers.get("referer") ?? "(none)",
  });

  if (!routeConfig) {
    return NextResponse.json(
      { error: `Unknown nutrition chat training stage: ${trainingStage}` },
      { status: 404 }
    );
  }

  if (routeConfig.kind === "base") {
    console.log("[api/chat/nutrition] -> base handler (/api/chat route.ts)");
    return handleBaseChatRequest(request);
  }

  console.log("[api/chat/nutrition] -> fine-tuned handler (route_ft_1.ts)", {
    model: routeConfig.model,
  });
  return handleFineTunedChatRequest(request, routeConfig.model);
}
