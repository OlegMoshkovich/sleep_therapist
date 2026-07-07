export type AdminAuthRole = "user" | "expert" | "admin";

export interface AdminAuthPersona<DemoKey extends string = string> {
  clerkId: string;
  userUUID: string;
  email: string;
  role: AdminAuthRole;
  expertDemos: DemoKey[];
}

export interface AdminAuthResolvedUser<DemoKey extends string = string> {
  clerkId: string;
  userUUID: string;
  email: string | null;
  role: AdminAuthRole;
  expertDemos: DemoKey[];
  isAdmin: boolean;
}

export interface AdminAuthSupabaseClient {
  from: (table: string) => any;
}

type MaybePromise<T> = T | Promise<T>;

export interface AdminAuthRuntimeOptions<DemoKey extends string = string> {
  knownDemos: readonly DemoKey[];
  isTestMode: () => boolean;
  resolveTestPersona: () => MaybePromise<AdminAuthPersona<DemoKey> | null>;
  resolveAuthUserId: () => MaybePromise<string | null>;
  resolveCurrentEmail: () => MaybePromise<string | null>;
  clerkIdToUUID: (clerkId: string) => MaybePromise<string>;
  createSupabaseAdminClient: () => AdminAuthSupabaseClient;
  logger?: Pick<Console, "error">;
}

export interface AdminAuthRuntime<DemoKey extends string = string> {
  resolveCurrentUser: () => Promise<AdminAuthResolvedUser<DemoKey> | null>;
  requireAdmin: () => Promise<AdminAuthResolvedUser<DemoKey> | null>;
  getRequestUserUUID: () => Promise<string | null>;
}

function resolveLogger(
  logger: Pick<Console, "error"> | undefined
): Pick<Console, "error"> {
  return logger ?? console;
}

export function createAdminAuthRuntime<DemoKey extends string = string>(
  options: AdminAuthRuntimeOptions<DemoKey>
): AdminAuthRuntime<DemoKey> {
  const knownDemos = new Set<string>(options.knownDemos);
  const logger = resolveLogger(options.logger);

  async function resolveCurrentUser(): Promise<
    AdminAuthResolvedUser<DemoKey> | null
  > {
    if (options.isTestMode()) {
      const persona = await options.resolveTestPersona();
      if (!persona) return null;
      return {
        clerkId: persona.clerkId,
        userUUID: persona.userUUID,
        email: persona.email,
        role: persona.role,
        expertDemos: persona.expertDemos,
        isAdmin: persona.role === "admin",
      };
    }

    const userId = await options.resolveAuthUserId();
    if (!userId) return null;

    const rawEmail = await options.resolveCurrentEmail();
    const email = rawEmail?.toLowerCase() ?? null;
    const userUUID = await options.clerkIdToUUID(userId);
    const supabase = options.createSupabaseAdminClient();

    const { data: existing, error: lookupError } = await supabase
      .from("user_roles")
      .select("user_id, email, role, expert_demos")
      .eq("user_id", userUUID)
      .maybeSingle();

    if (lookupError) {
      logger.error(
        "[admin-auth] user_roles lookup failed:",
        JSON.stringify(lookupError)
      );
    }

    let role: AdminAuthRole;
    let expertDemos: DemoKey[];
    const existingRow = existing as Record<string, unknown> | null;

    if (!existingRow) {
      role = "user";
      expertDemos = [];
      const { error: insertError } = await supabase.from("user_roles").insert({
        user_id: userUUID,
        email,
        role,
        expert_demos: expertDemos,
      });
      if (insertError) {
        logger.error(
          "[admin-auth] user_roles insert failed:",
          JSON.stringify(insertError)
        );
      }
    } else {
      role = (existingRow.role as AdminAuthRole | undefined) ?? "user";
      expertDemos = (
        (existingRow.expert_demos as string[] | undefined) ?? []
      ).filter((demo): demo is DemoKey => knownDemos.has(demo));

      if (existingRow.email !== email) {
        const { error: updateError } = await supabase
          .from("user_roles")
          .update({ email })
          .eq("user_id", userUUID);
        if (updateError) {
          logger.error(
            "[admin-auth] user_roles email update failed:",
            JSON.stringify(updateError)
          );
        }
      }
    }

    return {
      clerkId: userId,
      userUUID,
      email,
      role,
      expertDemos,
      isAdmin: role === "admin",
    };
  }

  async function requireAdmin(): Promise<
    AdminAuthResolvedUser<DemoKey> | null
  > {
    const user = await resolveCurrentUser();
    if (!user || !user.isAdmin) return null;
    return user;
  }

  async function getRequestUserUUID(): Promise<string | null> {
    if (options.isTestMode()) {
      const persona = await options.resolveTestPersona();
      return persona?.userUUID ?? null;
    }
    const userId = await options.resolveAuthUserId();
    if (!userId) return null;
    return await options.clerkIdToUUID(userId);
  }

  return {
    resolveCurrentUser,
    requireAdmin,
    getRequestUserUUID,
  };
}
