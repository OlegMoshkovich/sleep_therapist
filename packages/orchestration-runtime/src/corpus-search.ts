import { createCorpusSupabaseClient } from "./corpus-supabase";
import { embedText } from "./corpus-embeddings";

export interface CorpusChunk {
  content: string;
  similarity: number;
}

// Embed the query with the pinned model, then run pgvector similarity search
// scoped to a single corpus. The harness never sees any of this — it only calls
// the MCP tool with raw query text; embedding + search live behind the server.
export async function searchCorpusDocuments(
  corpusId: string,
  query: string,
  matchCount = 5
): Promise<CorpusChunk[]> {
  const queryEmbedding = await embedText(query);
  const supabase = createCorpusSupabaseClient();
  const { data, error } = await supabase.rpc("match_corpus_documents", {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    p_corpus_id: corpusId,
  });
  if (error) throw new Error(`corpus search failed: ${error.message}`);
  return (data ?? []) as CorpusChunk[];
}

export function formatChunksAsText(chunks: CorpusChunk[]): string {
  if (chunks.length === 0) {
    return "No matching passages were found in the corpus for this query.";
  }
  return chunks
    .map((c, i) => `[${i + 1}] (similarity ${c.similarity.toFixed(2)})\n${c.content}`)
    .join("\n\n");
}
