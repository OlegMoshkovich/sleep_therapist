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
  // The Sleep Intake subtree ran this turn → still gathering history.
  if (refs.some((r) => r.canvasId === "intake")) return "intake";
  const state = (turn.state ?? {}) as Record<string, unknown>;
  const isEmpty = (v: unknown) =>
    v === null || v === undefined || (Array.isArray(v) ? v.length === 0 : String(v).trim() === "" || String(v) === "null");
  // Emergency short-circuits into guidance (urgent advice).
  if (!isEmpty(state.emergency) && String(state.emergency).toLowerCase() !== "false") return "guide";
  // Once the core intake fields are captured, the assistant moves to guidance.
  const intakeCoreFilled =
    !isEmpty(state.sleep_concern) &&
    !isEmpty(state.bedtime_weeknight) &&
    !isEmpty(state.wake_time);
  if (intakeCoreFilled) return "guide";
  return "intake";
}

const studioChatConfig: StudioChatConfig = {
  productName: "Therapist",
  studioPath: "/demo/sleep/studio",
  assistantMark: "avatar",
  avatarMono: "SA",
  emptyStateHref: "/demo/sleep/studio",
  emptyStateBody: (
    <>
      Therapist can review your sleep logs, summarise guidance, and help you
      build a routine that sticks.
    </>
  ),
  emptyStatePrimaryAgent: "Primary agent: Therapist",
  subjectNoun: "patient",
  apiTopic: "sleep",
  suggestions: SUGGESTIONS,
  actionChips: ACTION_CHIPS,
  deriveWorkflowStage,
  SetupBar,
  turnExtractedStateKeys,
  SimulationPanel,
};

export default createStudioPage(studioChatConfig);
