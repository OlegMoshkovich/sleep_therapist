"use client";

import "./ra-theme.css";
import { SetupBar, turnExtractedStateKeys } from "./config/page";
import { SimulationPanel } from "./SimulationPanel";
import { ACTION_CHIPS, SUGGESTIONS } from "./sleep-data";
import { createStudioPage } from "../../studio-components/chat/StudioApp";
import type { StudioChatConfig } from "../../studio-components/chat/types";
import type { Turn } from "../../../components/trace/TraceView";

/** Derive the active workflow stage for a completed turn from its trace + state. */
function deriveWorkflowStage(turn: Turn | null | undefined): string | null {
  if (!turn) return null;
  const refs = turn.nodeRefs ?? [];
  // A turn that called the market-data tool is in the Analyze stage.
  if (refs.some((r) => r.nodeId === "tool-market" || r.nodeId === "analyze")) return "assess";
  const state = (turn.state ?? {}) as Record<string, unknown>;
  const isEmpty = (v: unknown) =>
    v === null || v === undefined || (Array.isArray(v) ? v.length === 0 : String(v).trim() === "" || String(v) === "null");
  // Urgent market event → jump to the report/read.
  if (!isEmpty(state.emergency) && String(state.emergency).toLowerCase() !== "false") return "guide";
  // Until the request is clear (query empty) we're still in Intake; once the
  // query is set the analyst pulls data and analyzes → the "Analyze" stage.
  if (isEmpty(state.query)) return "intake";
  return "assess";
}

const studioChatConfig: StudioChatConfig = {
  productName: "Analyst",
  studioPath: "/demo/analyst/studio",
  assistantMark: "logo",
  avatarSrc: "/analyst.png",
  emptyStateHref: "/demo/analyst/studio",
  emptyStateTitle: "Analyst",
  emptyStateBody: (
    <>
      Analyst pulls a live market snapshot and gives a clear, balanced
      read of stocks, indices, rates, and more. General market information, not
      investment advice.
    </>
  ),
  emptyStatePrimaryAgent: "Primary agent: Analyst",
  subjectNoun: "user",
  apiTopic: "analyst",
  suggestions: SUGGESTIONS,
  actionChips: ACTION_CHIPS,
  deriveWorkflowStage,
  SetupBar,
  turnExtractedStateKeys,
  SimulationPanel,
};

export default createStudioPage(studioChatConfig);
