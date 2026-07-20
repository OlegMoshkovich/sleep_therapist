import { NextRequest, NextResponse } from "next/server";
import { POST as handleBaseChatRequest } from "../../route";

// The analyst demo runs entirely on the base stateful pipeline (no fine-tuned stage).
// The base handler resolves the analyst_inputs setup from the request referer
// (/demo/analyst/...), so this route just forwards the "base" training stage.
const ANALYST_CHAT_ROUTE_REGISTRY = {
  base: { kind: "base" },
} as const;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ trainingStage: string }> }
) {
  const { trainingStage } = await params;
  const routeConfig =
    ANALYST_CHAT_ROUTE_REGISTRY[trainingStage as keyof typeof ANALYST_CHAT_ROUTE_REGISTRY] ?? null;

  console.log("[api/chat/analyst] incoming", {
    trainingStage,
    resolved: routeConfig?.kind ?? "none",
    referer: request.headers.get("referer") ?? "(none)",
  });

  if (!routeConfig) {
    return NextResponse.json(
      { error: `Unknown analyst chat training stage: ${trainingStage}` },
      { status: 404 }
    );
  }

  return handleBaseChatRequest(request);
}
