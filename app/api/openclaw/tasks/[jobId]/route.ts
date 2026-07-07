import { NextRequest, NextResponse } from "next/server";
import {
  buildBridgeUpstreamAuthHeader,
  getRequiredBridgeToken,
  readBearerToken,
  resolveBridgeJobUpstream,
} from "../../../../lib/openclaw-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const requiredBridgeToken = getRequiredBridgeToken();
  if (requiredBridgeToken) {
    const incomingToken = readBearerToken(request.headers.get("authorization"));
    if (incomingToken !== requiredBridgeToken) {
      return NextResponse.json(
        {
          status: "failed",
          error: "Unauthorized OpenClaw bridge request.",
          summary: "The OpenClaw bridge bearer token is missing or invalid.",
        },
        { status: 401 }
      );
    }
  }

  const { jobId } = await ctx.params;
  if (!jobId.trim()) {
    return NextResponse.json(
      {
        status: "failed",
        error: "Missing jobId.",
        summary: "The OpenClaw bridge needs a concrete job id to look up.",
      },
      { status: 400 }
    );
  }

  const upstream = resolveBridgeJobUpstream(request, jobId.trim());
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
  };
  const authorization = buildBridgeUpstreamAuthHeader(
    upstream,
    request.headers.get("authorization")
  );
  if (authorization) {
    headers.Authorization = authorization;
  }

  try {
    const upstreamResponse = await fetch(upstream.url, {
      method: "GET",
      headers,
    });
    const text = await upstreamResponse.text();
    const responseHeaders = new Headers();
    const contentType = upstreamResponse.headers.get("content-type");
    responseHeaders.set(
      "content-type",
      contentType && contentType.trim().length > 0 ? contentType : "application/json"
    );
    responseHeaders.set("x-airlab-openclaw-bridge", "proxy");

    return new NextResponse(text, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "failed",
        error:
          error instanceof Error
            ? error.message
            : "Unknown OpenClaw bridge proxy error.",
        summary: `Failed to reach OpenClaw upstream ${upstream.url}.`,
      },
      { status: 502 }
    );
  }
}
