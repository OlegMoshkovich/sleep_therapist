import {
  createDefaultTestSupabaseStore,
  createMemorySupabaseClient,
  type TestSupabaseStore,
} from "@airlab/orchestration-runtime/test-supabase";

/**
 * Test-mode stubs. Only active when TEST_MODE=1 (server) or
 * NEXT_PUBLIC_TEST_MODE=1 (client). Lets Playwright drive the app without
 * Clerk / Supabase / OpenAI by switching a "persona" via the `x-test-user`
 * cookie.
 */

// Inline types to avoid circular imports with admin-auth.ts.
type Role = "user" | "expert" | "admin";
type DemoKey = "nutrition" | "sleep" | "dnd" | "research-assistant";

export const TEST_COOKIE = "x-test-user";

export function isTestMode(): boolean {
  return process.env.TEST_MODE === "1";
}

export function isClientTestMode(): boolean {
  if (typeof process === "undefined") return false;
  return process.env.NEXT_PUBLIC_TEST_MODE === "1";
}

export type PersonaKey =
  | "admin"
  | "expert-nutrition"
  | "expert-all"
  | "user"
  | "anon";

export interface Persona {
  clerkId: string;
  userUUID: string;
  email: string;
  role: Role;
  expertDemos: DemoKey[];
}

export const PERSONAS: Record<Exclude<PersonaKey, "anon">, Persona> = {
  admin: {
    clerkId: "test_admin",
    userUUID: "00000000-0000-4000-8000-000000000001",
    email: "admin@test.local",
    role: "admin",
    expertDemos: [],
  },
  "expert-nutrition": {
    clerkId: "test_expert_nutrition",
    userUUID: "00000000-0000-4000-8000-000000000002",
    email: "expert-nutrition@test.local",
    role: "expert",
    expertDemos: ["nutrition"],
  },
  "expert-all": {
    clerkId: "test_expert_all",
    userUUID: "00000000-0000-4000-8000-000000000003",
    email: "expert-all@test.local",
    role: "expert",
    expertDemos: ["nutrition", "sleep", "dnd", "research-assistant"],
  },
  user: {
    clerkId: "test_user",
    userUUID: "00000000-0000-4000-8000-000000000004",
    email: "user@test.local",
    role: "user",
    expertDemos: [],
  },
};

export function personaForCookieValue(value: string | undefined): Persona | null {
  if (!value) return null;
  if (value === "anon") return null;
  return PERSONAS[value as Exclude<PersonaKey, "anon">] ?? null;
}

function fresh(): TestSupabaseStore {
  return createDefaultTestSupabaseStore({ personas: PERSONAS });
}

let store: TestSupabaseStore = fresh();
export function resetTestStore() {
  store = fresh();
}

export function createTestSupabaseClient() {
  return createMemorySupabaseClient(() => store);
}
