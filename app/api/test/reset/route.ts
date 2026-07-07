import { NextResponse } from "next/server";
import { isTestMode, resetTestStore } from "../../../lib/test-mode";

export async function POST() {
  if (!isTestMode()) {
    return NextResponse.json({ error: "Not in test mode" }, { status: 404 });
  }
  resetTestStore();
  return NextResponse.json({ ok: true });
}
