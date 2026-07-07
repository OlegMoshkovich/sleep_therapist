import { createClient } from "@supabase/supabase-js";
import { registerCorpusSupabaseClientFactory } from "@airlab/orchestration-runtime/corpus-supabase";

import { createSupabaseAdminClient } from "../supabase-admin";

// Dedicated Supabase connection for the corpus. RAG retrieval is "hosted and
// separable" (see docs/rag-corpus-design.md), so the corpus can live in a
// different Supabase project from the rest of the app. Resolution order:
//
//   1. CORPUS_SUPABASE_URL + CORPUS_SUPABASE_SERVICE_ROLE_KEY
//        → full read/write (ingestion + retrieval) against that project.
//   2. CORPUS_SUPABASE_URL + CORPUS_SUPABASE_KEY (publishable/anon)
//        → retrieval works via the SECURITY DEFINER match_corpus_documents RPC
//          (the table itself stays RLS-locked); direct writes are blocked, so
//          ingestion for such a project is done out-of-band (e.g. via the
//          Supabase MCP / SQL) rather than the app's ingest endpoint.
//   3. neither set
//        → fall back to the app-wide admin client (corpus shares the app's DB).
//
// Keeping the key out of NEXT_PUBLIC_* means it is only ever used server-side
// (the corpus MCP server and ingest route), never shipped to the browser.
function createAppCorpusSupabaseClient() {
  const url = process.env.CORPUS_SUPABASE_URL?.trim();
  const key =
    process.env.CORPUS_SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.CORPUS_SUPABASE_KEY?.trim();

  if (url && key) {
    return createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // No dedicated corpus project configured — use the app's admin client, which
  // also transparently handles test mode.
  return createSupabaseAdminClient();
}

registerCorpusSupabaseClientFactory(createAppCorpusSupabaseClient);

export * from "@airlab/orchestration-runtime/corpus-supabase";
