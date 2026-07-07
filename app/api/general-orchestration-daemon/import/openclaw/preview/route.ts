import { NextRequest, NextResponse } from "next/server";

import { buildOpenClawImportPreview } from "../../../../../lib/openclaw-import";

const MAX_IMPORT_TEXT_LENGTH = 500_000;

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function readSourceFromUrl(sourceUrl: string): Promise<{
  sourceText: string;
  sourceLabel: string;
}> {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new Error("OpenClaw import URL is not valid.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OpenClaw import URL must use http or https.");
  }

  const response = await fetch(url, {
    headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.1" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`OpenClaw import URL returned ${response.status}.`);
  }

  const sourceText = await response.text();
  if (sourceText.length > MAX_IMPORT_TEXT_LENGTH) {
    throw new Error("OpenClaw import payload is too large.");
  }

  return {
    sourceText,
    sourceLabel: url.toString(),
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const sourceUrl = readString(body.sourceUrl);
    let sourceText = readString(body.sourceText);
    let sourceLabel = readString(body.sourceLabel);

    if (sourceUrl) {
      const remote = await readSourceFromUrl(sourceUrl);
      sourceText = remote.sourceText;
      sourceLabel = sourceLabel || remote.sourceLabel;
    }

    if (!sourceText) {
      return NextResponse.json(
        { error: "Paste an OpenClaw manifest/task or provide an import URL." },
        { status: 400 }
      );
    }

    if (sourceText.length > MAX_IMPORT_TEXT_LENGTH) {
      return NextResponse.json(
        { error: "OpenClaw import payload is too large." },
        { status: 413 }
      );
    }

    const preview = buildOpenClawImportPreview({ sourceText, sourceLabel });
    return NextResponse.json({ preview });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to preview OpenClaw import.",
      },
      { status: 400 }
    );
  }
}
