import { auth, currentUser } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import {
  createAdminAuthRuntime,
  type AdminAuthResolvedUser,
  type AdminAuthRole,
} from "@airlab/orchestration-runtime/admin-auth";

import { clerkIdToUUID } from "./clerk-uuid";
import { createSupabaseAdminClient } from "./supabase-admin";
import { isTestMode, personaForCookieValue, TEST_COOKIE } from "./test-mode";

export type Role = AdminAuthRole;

export const KNOWN_DEMOS = [
  "nutrition",
  "sleep",
  "law",
  "analyst",
  "dnd",
  "research-assistant",
  "general-orchestration-daemon",
] as const;
export type DemoKey = (typeof KNOWN_DEMOS)[number];

export type ResolvedUser = AdminAuthResolvedUser<DemoKey>;

const authRuntime = createAdminAuthRuntime<DemoKey>({
  knownDemos: KNOWN_DEMOS,
  isTestMode,
  async resolveTestPersona() {
    const cookieStore = await cookies();
    return personaForCookieValue(cookieStore.get(TEST_COOKIE)?.value);
  },
  async resolveAuthUserId() {
    const { userId } = await auth();
    return userId ?? null;
  },
  async resolveCurrentEmail() {
    const clerkUser = await currentUser();
    return clerkUser?.primaryEmailAddress?.emailAddress ?? null;
  },
  clerkIdToUUID,
  createSupabaseAdminClient,
});

export const resolveCurrentUser = authRuntime.resolveCurrentUser;
export const requireAdmin = authRuntime.requireAdmin;
export const getRequestUserUUID = authRuntime.getRequestUserUUID;
