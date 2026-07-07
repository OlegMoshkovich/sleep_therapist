import OpenAI from "openai";

// The corpus embedding model is PINNED: ingestion and retrieval must use the
// same model so a query lands in the same vector space as the stored chunks.
// It is owned by the server side only — never the portable harness, whose
// chat-LLM is unrelated to this embedding model (see docs/rag-corpus-design.md).
export const CORPUS_EMBEDDING_MODEL = "text-embedding-3-small";
export const CORPUS_EMBEDDING_DIM = 1536;

function client(): OpenAI {
  return new OpenAI({ apiKey: process.env.AIRLAB_OPENAI_API_KEY });
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await client().embeddings.create({
    model: CORPUS_EMBEDDING_MODEL,
    input: texts,
  });
  return res.data.map((d) => d.embedding);
}

export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  return embedding;
}
