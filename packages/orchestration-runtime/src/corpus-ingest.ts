import { createCorpusSupabaseClient } from "./corpus-supabase";
import { embedTexts } from "./corpus-embeddings";
import { chunkText } from "./corpus-chunk";

export interface IngestResult {
  chunks: number;
}

// Authoring-time only: chunk -> embed (pinned model) -> store. This stays home;
// a published agent never runs ingestion, it only reads via the corpus MCP
// server. See docs/rag-corpus-design.md ("What ports, and what stays home").
export async function ingestDocument(
  corpusId: string,
  text: string,
  metadata: Record<string, unknown> = {}
): Promise<IngestResult> {
  const chunks = chunkText(text);
  if (chunks.length === 0) return { chunks: 0 };

  const embeddings = await embedTexts(chunks);
  const supabase = createCorpusSupabaseClient();
  const rows = chunks.map((content, i) => ({
    corpus_id: corpusId,
    content,
    embedding: embeddings[i],
    metadata,
  }));

  const { error } = await supabase.from("corpus_documents").insert(rows);
  if (error) throw new Error(`corpus ingest failed: ${error.message}`);
  return { chunks: rows.length };
}
