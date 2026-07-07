import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/admin-auth";
import { createSupabaseAdminClient } from "../../../../lib/supabase-admin";

export async function GET() {
  // Clerk-based admin gate (consistent with the rest of the app, which
  // authenticates via Clerk -> clerkIdToUUID rather than a Supabase session).
  const isAdmin = await requireAdmin();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createSupabaseAdminClient();

  const { data: convos, error: convosError } = await admin
    .from("conversations")
    .select("id, title, updated_at, user_id")
    .eq("topic", "sleep")
    .order("updated_at", { ascending: false });

  if (convosError) {
    return NextResponse.json({ error: convosError.message }, { status: 500 });
  }

  const convoIds = (convos ?? []).map((c) => c.id);

  const { data: msgRows } = await admin
    .from("messages")
    .select("conversation_id")
    .in("conversation_id", convoIds.length ? convoIds : ["00000000-0000-0000-0000-000000000000"]);

  const countMap: Record<string, number> = {};
  for (const row of msgRows ?? []) {
    countMap[row.conversation_id] = (countMap[row.conversation_id] ?? 0) + 1;
  }

  const { data: roles } = await admin
    .from("user_roles")
    .select("user_id, email");

  const emailMap: Record<string, string> = {};
  for (const r of roles ?? []) {
    if (r.email) emailMap[r.user_id] = r.email;
  }

  const conversations = (convos ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    updated_at: c.updated_at,
    user_id: c.user_id,
    user_email: emailMap[c.user_id] ?? null,
    message_count: countMap[c.id] ?? 0,
  }));

  return NextResponse.json({ conversations });
}
