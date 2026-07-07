import { NextResponse } from "next/server";
import { ingestDocument } from "../../../lib/corpus/ingest";

// Authoring-time ingestion endpoint: POST a document's text and it is chunked,
// embedded (pinned model), and stored under a corpus_id. Stays home — the
// published agent never calls this. See docs/rag-corpus-design.md.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      corpusId?: unknown;
      text?: unknown;
      title?: unknown;
    };

    const corpusId =
      typeof body.corpusId === "string" && body.corpusId.trim()
        ? body.corpusId.trim()
        : "default";
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      return NextResponse.json({ ok: false, error: "Missing 'text'." }, { status: 400 });
    }
    const title = typeof body.title === "string" ? body.title : undefined;

    const result = await ingestDocument(corpusId, text, title ? { title } : {});
    return NextResponse.json({ ok: true, corpusId, chunks: result.chunks });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
