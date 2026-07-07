import { NextResponse } from "next/server";
import { resolveCurrentUser } from "../../../lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await resolveCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
  return NextResponse.json(
    {
      role: user.role,
      expertDemos: user.expertDemos,
      isAdmin: user.isAdmin,
      email: user.email,
    },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}
