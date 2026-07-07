import { NextRequest, NextResponse } from "next/server";
import {
  delegatedTaskSchema,
  executeDelegatedTaskSync,
  getRuntimeBearerToken,
  queueDelegatedTask,
} from "../../../../lib/openclaw-runtime";
import { readBearerToken } from "../../../../lib/openclaw-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requiredRuntimeToken = getRuntimeBearerToken();
  if (requiredRuntimeToken) {
    const incomingToken = readBearerToken(request.headers.get("authorization"));
    if (incomingToken !== requiredRuntimeToken) {
      return NextResponse.json(
        {
          status: "failed",
          error: "Unauthorized OpenClaw runtime request.",
          summary: "The OpenClaw runtime bearer token is missing or invalid.",
        },
        { status: 401 }
      );
    }
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        status: "failed",
        error: "Invalid JSON body.",
        summary: "The OpenClaw runtime expects a JSON task envelope.",
      },
      { status: 400 }
    );
  }

  const parsed = delegatedTaskSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        status: "failed",
        error: "Invalid OpenClaw task payload.",
        summary: parsed.error.issues[0]?.message ?? "Payload validation failed.",
      },
      { status: 400 }
    );
  }

  try {
    if (parsed.data.mode === "async") {
      return NextResponse.json(await queueDelegatedTask(parsed.data), { status: 202 });
    }

    const result = await executeDelegatedTaskSync(parsed.data);
    if (result.status === "failed") {
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        status: "failed",
        error:
          error instanceof Error
            ? error.message
            : "Failed to persist delegated OpenClaw task.",
        summary: "The first-party OpenClaw runtime could not store or execute the task.",
      },
      { status: 500 }
    );
  }
}
