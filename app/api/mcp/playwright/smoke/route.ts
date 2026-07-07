import { NextResponse } from "next/server";
import { callMcpTool } from "../../../../lib/tools/mcp";
import { resolveServer } from "../../../../lib/tools/servers";

// One-click smoke test for the Playwright browser MCP. Hit
// GET /api/mcp/playwright/smoke to run a real navigate -> snapshot round-trip
// against the @playwright/mcp server (the hosted URL if PLAYWRIGHT_MCP_SERVER_URL
// is set, otherwise the local stdio command). It reports each step.
//
// Confirms the server is reachable, Chromium is installed, and the binding
// resolves before you test the Playwright canvas in the sandbox. Won't work on
// Vercel serverless (no Chromium runtime, no persistent process) — that's
// expected and the endpoint reports "Playwright MCP server is not resolvable"
// cleanly in that case.
//
// First call is slow (~10-30s) while Playwright installs Chromium into
// ~/.cache/ms-playwright. Later calls are fast.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The first invocation may install Chromium, so cap generously.
export const maxDuration = 60;

const SMOKE_URL = "https://example.com";

interface Step {
  step: string;
  ok: boolean;
  detail?: unknown;
}

export async function GET() {
  const { url, command, args: serverArgs, auth } = resolveServer("playwright");
  if (!url && !command) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Playwright MCP server is not resolvable. Locally it defaults to the " +
          "stdio command `npx -y @playwright/mcp@latest --headless` (needs Node " +
          "+ Chromium). On Vercel, set PLAYWRIGHT_MCP_SERVER_URL to a self-hosted " +
          "endpoint — it cannot run on serverless.",
      },
      { status: 503 }
    );
  }

  const target = (remoteTool: string) => ({
    serverUrl: url,
    auth,
    command,
    args: serverArgs,
    remoteTool,
  });

  const steps: Step[] = [];
  const record = (step: string, ok: boolean, detail?: unknown) => {
    steps.push({ step, ok, detail });
    return ok;
  };

  try {
    // 1. Navigate to a known stable URL.
    const navigated = await callMcpTool(target("browser_navigate"), { url: SMOKE_URL });
    record("browser_navigate", navigated.ok, navigated.ok ? navigated.data : navigated.error);

    // 2. Snapshot — the accessibility tree should mention "Example Domain".
    const snapshot = await callMcpTool(target("browser_snapshot"), {});
    const snapshotText =
      typeof snapshot.data === "string" ? snapshot.data : JSON.stringify(snapshot.data ?? "");
    const sawExpected = snapshot.ok && /example domain/i.test(snapshotText);
    record(
      "browser_snapshot",
      sawExpected,
      snapshot.ok ? snapshotText.slice(0, 600) : snapshot.error
    );

    // 3. Best-effort cleanup — close the page so the server's session is fresh
    //    for the next caller. Don't fail the smoke if this isn't supported.
    const closed = await callMcpTool(target("browser_close"), {});
    record("browser_close (cleanup)", true, closed.ok ? "ok" : closed.error);

    const ok = steps.every((s) => s.ok);
    return NextResponse.json(
      {
        ok,
        url: SMOKE_URL,
        transport: url ? "http" : "stdio",
        steps,
      },
      { status: ok ? 200 : 500 }
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        steps,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
