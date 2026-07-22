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
  // The Legal Intake subtree ran this turn → still gathering the facts.
  if (refs.some((r) => r.canvasId === "intake")) return "intake";
  const state = (turn.state ?? {}) as Record<string, unknown>;
  const isEmpty = (v: unknown) =>
    v === null || v === undefined || (Array.isArray(v) ? v.length === 0 : String(v).trim() === "" || String(v) === "null");
  // Emergency (imminent deadline) short-circuits into guidance/advice.
  if (!isEmpty(state.emergency) && String(state.emergency).toLowerCase() !== "false") return "guide";
  // Once the core intake fields are captured, the assistant moves to advice.
  const intakeCoreFilled =
    !isEmpty(state.summary) &&
    !isEmpty(state.matter_type) &&
    !isEmpty(state.jurisdiction);
  if (intakeCoreFilled) return "guide";
  return "intake";
}

const studioChatConfig: StudioChatConfig = {
  productName: "Council",
  studioPath: "/demo/law/studio",
  assistantMark: "logo",
  avatarSrc: "/lawyer.png",
  emptyStateHref: "/demo/law/studio",
  emptyStateTitle: "Council",
  emptyStateBody: (
    <>
      Council can take down the facts of your deal, walk through M&A and
      financing options in plain language, and help you prepare for counsel.
      General information, not legal advice.
    </>
  ),
  emptyStatePrimaryAgent: "Primary agent: Council",
  subjectNoun: "client",
  apiTopic: "law",
  suggestions: SUGGESTIONS,
  actionChips: ACTION_CHIPS,
  deriveWorkflowStage,
  SetupBar,
  turnExtractedStateKeys,
  SimulationPanel,
};

export default createStudioPage(studioChatConfig);
