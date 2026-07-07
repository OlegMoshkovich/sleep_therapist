import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase-server";
import { createSupabaseAdminClient } from "../../../lib/supabase-admin";

export async function GET() {
  // Verify the requester is authenticated
  const userClient = await createSupabaseServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();

  // Fetch all conversations (bypasses RLS)
  const { data: convos, error: convosError } = await admin
    .from("conversations")
    .select("id, title, updated_at, user_id")
    .order("updated_at", { ascending: false });

  if (convosError) {
    return NextResponse.json({ error: convosError.message }, { status: 500 });
  }

  const convoIds = (convos ?? []).map((c) => c.id);

  // Fetch message counts for all conversations in one query
  const { data: msgRows } = await admin
    .from("messages")
    .select("conversation_id")
    .in("conversation_id", convoIds);

  const countMap: Record<string, number> = {};
  for (const row of msgRows ?? []) {
    countMap[row.conversation_id] = (countMap[row.conversation_id] ?? 0) + 1;
  }

  // Fetch user emails from user_roles
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
