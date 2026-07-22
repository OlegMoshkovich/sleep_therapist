"use client";

import type { Turn } from "../../../components/trace/TraceView";
import { SetupBar } from "./config/page";

/**
 * Model Setup content for the Analyst — the Knowledge / State / Policy
 * editors (the SetupBar). Rendered as its own tab inside the shared RightDrawer,
 * moved here out of the Observability tab (which now shows only the trace).
 *
 * `turns` flows through so the Policy canvas can animate the path the model took
 * on the latest turn (see CanvasFireSignal).
 */
export function ModelSetupContent({ turns }: { turns: Turn[] }) {
  return (
    <div className="drawer-pane">
      <SetupBar turns={turns} />
    </div>
  );
}
