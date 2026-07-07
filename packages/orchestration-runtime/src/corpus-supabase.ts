export interface CorpusSupabaseClient {
  from: (table: string) => {
    insert: (rows: unknown[]) => PromiseLike<{ error?: { message?: string } | null }>;
  };
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{
    data?: unknown;
    error?: { message?: string } | null;
  }>;
}

export type CorpusSupabaseClientFactory = () => CorpusSupabaseClient;

let corpusSupabaseClientFactory: CorpusSupabaseClientFactory | null = null;

export function registerCorpusSupabaseClientFactory(
  factory: CorpusSupabaseClientFactory | null
): void {
  corpusSupabaseClientFactory = factory;
}

export function createCorpusSupabaseClient(): CorpusSupabaseClient {
  if (!corpusSupabaseClientFactory) {
    throw new Error("Corpus Supabase client factory is not registered.");
  }
  return corpusSupabaseClientFactory();
}
