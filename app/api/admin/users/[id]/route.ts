import { NextRequest, NextResponse } from "next/server";
import {
  KNOWN_DEMOS,
  requireAdmin,
  type DemoKey,
  type Role,
} from "../../../../lib/admin-auth";
import { createSupabaseAdminClient } from "../../../../lib/supabase-admin";

const VALID_ROLES: Role[] = ["user", "expert", "admin"];

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    role?: string;
    expertDemos?: string[];
  };

  const update: Record<string, unknown> = {};

  if (body.role !== undefined) {
    if (!VALID_ROLES.includes(body.role as Role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    update.role = body.role;
  }

  if (body.expertDemos !== undefined) {
    if (!Array.isArray(body.expertDemos)) {
      return NextResponse.json({ error: "expertDemos must be an array" }, { status: 400 });
    }
    const known = new Set<string>(KNOWN_DEMOS);
    const cleaned = Array.from(
      new Set(body.expertDemos.filter((d): d is DemoKey => known.has(d)))
    );
    update.expert_demos = cleaned;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_roles")
    .update(update)
    .eq("user_id", id)
    .select("user_id, email, role, expert_demos")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ user: data });
}
