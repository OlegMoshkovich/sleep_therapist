export interface MemorySupabaseClient {
  from: (table: string) => any;
}

export type MemorySupabaseClientFactory = () => MemorySupabaseClient;

let memorySupabaseClientFactory: MemorySupabaseClientFactory | null = null;

export function registerMemorySupabaseClientFactory(
  factory: MemorySupabaseClientFactory | null
): void {
  memorySupabaseClientFactory = factory;
}

export function createMemorySupabaseClient(): MemorySupabaseClient {
  if (!memorySupabaseClientFactory) {
    throw new Error("Memory Supabase client factory is not registered.");
  }
  return memorySupabaseClientFactory();
}
