import { NextRequest, NextResponse } from "next/server";
import {
  buildBridgeUpstreamAuthHeader,
  getRequiredBridgeToken,
  readBearerToken,
  resolveBridgeTasksUpstream,
} from "../../../lib/openclaw-bridge";
import { delegatedTaskSchema } from "../../../lib/openclaw-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
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

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        status: "failed",
        error: "Invalid JSON body.",
        summary: "The OpenClaw bridge expects a JSON task envelope.",
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

  const upstream = resolveBridgeTasksUpstream(request);
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
    "Content-Type": "application/json",
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
      method: "POST",
      headers,
      body: JSON.stringify(parsed.data),
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
