import { NextResponse } from "next/server";
import { requireAdmin } from "../../../lib/admin-auth";
import { createSupabaseAdminClient } from "../../../lib/supabase-admin";

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_roles")
    .select("user_id, email, role, expert_demos")
    .order("email", { ascending: true, nullsFirst: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ users: data ?? [] });
}
