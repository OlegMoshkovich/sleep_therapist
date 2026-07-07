import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase-server";
import { createSupabaseAdminClient } from "../../../lib/supabase-admin";

export async function GET(req: NextRequest) {
  const userClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const conversationId = req.nextUrl.searchParams.get("conversationId");
  if (!conversationId) {
    return NextResponse.json({ error: "Missing conversationId" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("message_comments")
    .select("id, message_id, expert_id, expert_email, comment, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ comments: data ?? [] });
}

export async function POST(req: NextRequest) {
  const userClient = await createSupabaseServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { message_id, conversation_id, comment } = body;

  if (!message_id || !conversation_id || !comment?.trim()) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();

  // Resolve expert email from user_roles table
  const { data: roleRow } = await admin
    .from("user_roles")
    .select("email")
    .eq("user_id", user.id)
    .single();

  const { data, error } = await admin
    .from("message_comments")
    .insert({
      message_id,
      conversation_id,
      expert_id: user.id,
      expert_email: roleRow?.email ?? user.email ?? null,
      comment: comment.trim(),
    })
    .select("id, message_id, expert_id, expert_email, comment, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ comment: data }, { status: 201 });
}
