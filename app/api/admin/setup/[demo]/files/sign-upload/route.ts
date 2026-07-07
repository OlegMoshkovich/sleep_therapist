import { NextRequest, NextResponse } from "next/server";
import { resolveCurrentUser } from "../../../../../../lib/admin-auth";
import { createSupabaseAdminClient } from "../../../../../../lib/supabase-admin";
import { DEMO_SETUP, isDemoKey } from "../../../../../../lib/demo-config";

interface RouteContext {
  params: Promise<{ demo: string }>;
}

function formatProvisioningError(demo: string, message: string) {
  if (
    demo === "research-assistant" &&
    (message.includes("research_assistant_inputs") || message.includes("research-assistant-input-files"))
  ) {
    return "Research Assistant Supabase resources are not provisioned yet. Run `supabase/migrations/20260527203000_research_assistant_setup.sql` in the Supabase SQL editor, then refresh.";
  }
  if (
    demo === "general-orchestration-daemon" &&
    (message.includes("general_orchestration_daemon_inputs") ||
      message.includes("general-orchestration-daemon-input-files"))
  ) {
    return "General Orchestration Daemon Supabase resources are not provisioned yet. Run `supabase/migrations/20260524_general_orchestration_daemon_setup.sql` in the Supabase SQL editor, then refresh.";
  }
  return message;
}

function sanitize(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const { demo: demoParam } = await ctx.params;
  if (!isDemoKey(demoParam)) {
    return NextResponse.json({ error: "Unknown demo" }, { status: 404 });
  }
  const demo = demoParam;
  const me = await resolveCurrentUser();
  if (!me) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!me.isAdmin && !me.expertDemos.includes(demo)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cfg = DEMO_SETUP[demo];
  const body = (await request.json().catch(() => ({}))) as {
    fileName?: string;
    fileSize?: number;
    fileType?: string;
  };
  if (!body.fileName) {
    return NextResponse.json({ error: "Missing fileName" }, { status: 400 });
  }

  const sanitized = sanitize(body.fileName);
  const path = `experts/${me.userUUID}/${demo}-input/${Date.now()}-${sanitized}`;
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.storage
    .from(cfg.filesBucket)
    .createSignedUploadUrl(path);
  if (error) {
    return NextResponse.json({ error: formatProvisioningError(demo, error.message) }, { status: 500 });
  }

  return NextResponse.json({
    path: data.path,
    token: data.token,
    bucket: cfg.filesBucket,
    file: {
      name: body.fileName,
      size: body.fileSize ?? 0,
      type: body.fileType ?? "",
      bucket: cfg.filesBucket,
      path: data.path,
      uploaded_by_email: me.email,
      uploaded_by_uuid: me.userUUID,
      uploaded_at: new Date().toISOString(),
    },
  });
}
