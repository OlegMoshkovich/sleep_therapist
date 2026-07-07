import { NextRequest, NextResponse } from "next/server";
import {
  getDelegatedTaskJob,
  getRuntimeBearerToken,
} from "../../../../../lib/openclaw-runtime";
import { readBearerToken } from "../../../../../lib/openclaw-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
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

  const { jobId } = await ctx.params;
  try {
    const job = await getDelegatedTaskJob(jobId.trim());
    if (!job) {
      return NextResponse.json(
        {
          status: "failed",
          error: `OpenClaw job "${jobId}" was not found.`,
          summary: "No delegated job is stored under that id in the first-party runtime.",
        },
        { status: 404 }
      );
    }

    return NextResponse.json(job);
  } catch (error) {
    return NextResponse.json(
      {
        status: "failed",
        error:
          error instanceof Error
            ? error.message
            : "Failed to load delegated OpenClaw job.",
        summary: "The first-party OpenClaw runtime could not read or resume the job.",
      },
      { status: 500 }
    );
  }
}
