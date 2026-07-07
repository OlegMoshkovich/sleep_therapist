import { NextRequest, NextResponse } from "next/server";
import { resolveCurrentUser } from "../../lib/admin-auth";
import { createSupabaseAdminClient } from "../../lib/supabase-admin";

// Per-message feedback gathered from chat surfaces (the Sleep studio for now).
// Every read/write is scoped to the signed-in user; a bubble is identified by
// (conversation_id, message_index). See the message_feedback migration.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FeedbackItem {
  signal?: string | null;
  rating?: number | null;
  comment?: string;
}

interface FeedbackBody {
  conversationId?: string;
  messageIndex?: number;
  messageRole?: string;
  messageExcerpt?: string;
  // Preferred: the full set of signals attached to this message. The server
  // reconciles to it (upsert present signals, delete absent ones).
  entries?: FeedbackItem[];
  // Legacy single-signal shape, still accepted and treated as a one-item set.
  rating?: number | null;
  signal?: string | null;
  comment?: string;
}

const KNOWN_SIGNALS = new Set([
  "score",
  "text_correction",
  "correct_output",
  "comment",
]);

export async function GET(request: NextRequest) {
  const user = await resolveCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const conversationId = request.nextUrl.searchParams.get("conversationId");
  if (!conversationId) return NextResponse.json({ feedback: [] });

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("message_feedback")
    .select("message_index, message_role, rating, signal, comment")
    .eq("user_id", user.userUUID)
    .eq("conversation_id", conversationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ feedback: data ?? [] });
}

export async function POST(request: NextRequest) {
  const user = await resolveCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json()) as FeedbackBody;
  const conversationId = body.conversationId?.trim();
  const messageIndex = body.messageIndex;
  if (!conversationId || typeof messageIndex !== "number") {
    return NextResponse.json(
      { error: "conversationId and messageIndex are required" },
      { status: 400 }
    );
  }

  // Accept either the new `entries` set or the legacy single-signal shape.
  const rawItems: FeedbackItem[] = Array.isArray(body.entries)
    ? body.entries
    : [{ signal: body.signal, rating: body.rating, comment: body.comment }];

  // Normalize to at most one entry per signal (last write wins), dropping
  // entries that carry neither a rating nor a comment.
  const desired = new Map<string, { rating: number | null; comment: string }>();
  for (const item of rawItems) {
    const signal =
      item.signal && KNOWN_SIGNALS.has(item.signal) ? item.signal : "comment";
    const rating = item.rating === 1 || item.rating === -1 ? item.rating : null;
    const comment = (item.comment ?? "").slice(0, 4000);
    if (rating === null && !comment.trim()) continue;
    desired.set(signal, { rating, comment });
  }

  const base = {
    user_id: user.userUUID,
    conversation_id: conversationId,
    message_index: messageIndex,
    message_role: body.messageRole === "user" ? "user" : "ai",
    message_excerpt: (body.messageExcerpt ?? "").slice(0, 280),
    updated_at: new Date().toISOString(),
  };

  const supabase = createSupabaseAdminClient();
  // Reconcile this message's rows to the desired set. Keyed explicitly by
  // (user, conversation, message_index, signal) rather than onConflict so it
  // also works under the in-memory test shim.
  const { data: existingRows, error: selErr } = await supabase
    .from("message_feedback")
    .select("id, signal")
    .eq("user_id", user.userUUID)
    .eq("conversation_id", conversationId)
    .eq("message_index", messageIndex);
  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 });
  const existing = (existingRows ?? []) as Array<{ id: string; signal: string }>;

  // Upsert each desired signal.
  for (const [signal, v] of desired) {
    const match = existing.find((r) => r.signal === signal);
    const row = { ...base, signal, rating: v.rating, comment: v.comment };
    if (match) {
      const { error } = await supabase
        .from("message_feedback")
        .update(row)
        .eq("id", match.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      const { error } = await supabase.from("message_feedback").insert(row);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // Delete signals the expert cleared.
  for (const r of existing) {
    if (!desired.has(r.signal)) {
      const { error } = await supabase
        .from("message_feedback")
        .delete()
        .eq("id", r.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const user = await resolveCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const conversationId = request.nextUrl.searchParams.get("conversationId");
  const messageIndex = Number(request.nextUrl.searchParams.get("messageIndex"));
  if (!conversationId || !Number.isFinite(messageIndex)) {
    return NextResponse.json(
      { error: "conversationId and messageIndex are required" },
      { status: 400 }
    );
  }

  // Optional: delete just one signal; omitted clears all feedback on the message.
  const signal = request.nextUrl.searchParams.get("signal");

  const supabase = createSupabaseAdminClient();
  let q = supabase
    .from("message_feedback")
    .delete()
    .eq("user_id", user.userUUID)
    .eq("conversation_id", conversationId)
    .eq("message_index", messageIndex);
  if (signal && KNOWN_SIGNALS.has(signal)) q = q.eq("signal", signal);
  const { error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
