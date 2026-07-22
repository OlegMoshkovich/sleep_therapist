"use client";

import React, { useState } from "react";
import { Ic } from "../ra-icons";
import Canvas, { type CanvasDoc, type CanvasFireSignal } from "../../../components/canvas/Canvas";
import { WORKFLOW_CANVAS_NODE_KINDS } from "../../../components/canvas/node-kinds";
import {
  WORKFLOW_OVERVIEW_CANVAS_MARKER,
  WORKFLOW_OVERVIEW_CANVAS_NAME,
} from "@airlab/orchestration-core/general-orchestration";

/** Which workflow canvas node id corresponds to each stage id. */
export const WORKFLOW_STAGE_NODE: Record<string, string> = {
  intake: "wf-stage-intake",
  assess: "wf-stage-assess",
  guide: "wf-stage-guide",
  followup: "wf-stage-followup",
};

/** Which policy canvas each workflow stage opens (Model Setup → Policy). */
export const WORKFLOW_STAGE_POLICY_CANVAS: Record<string, string> = {
  intake: "intake",
  assess: "assess",
  guide: "guide",
  followup: "followup",
};

/** Build the default Overall Workflow canvas seed for a studio. */
export function createBottomWorkflowSeed(primaryAgent: string): CanvasDoc {
  return {
    version: 2,
    activeId: "overall-workflow",
    canvases: [
      {
        id: "overall-workflow",
        name: WORKFLOW_OVERVIEW_CANVAS_NAME,
        freeText: [
          WORKFLOW_OVERVIEW_CANVAS_MARKER,
          primaryAgent,
          "Editable overview of the main sleep-care stages. Edit stages, add loops, or partition a stage into a child workflow.",
        ].join("\n"),
        graph: {
          nodes: [
            {
              id: "wf-start",
              type: "start",
              position: { x: 80, y: 140 },
              data: {
                label:
                  "Editable overview of the main workflow stages. Describe the high-level turn-taking process shared with the client.",
                workflowOverview: true,
                runtimeRole: "workflow_overview",
                workflowCanvasId: "overall-workflow",
              },
            },
            {
              id: "wf-stage-intake",
              type: "stage",
              position: { x: 420, y: 120 },
              data: {
                label:
                  "Intake\nGather the sleep complaint, schedule, and constraints.\nEntry: conversation opens.\nDone: enough history to assess.",
                workflowOverview: true,
                runtimeRole: "workflow_overview",
                workflowCanvasId: "overall-workflow",
                workflowStageId: "intake",
                workflowStageName: "Intake",
              },
            },
            {
              id: "wf-stage-assess",
              type: "stage",
              position: { x: 850, y: 120 },
              data: {
                label:
                  "Assess\nIdentify patterns (onset, maintenance, schedule, habits).\nEntry: intake complete.\nDone: working hypothesis shared with the client.",
                workflowOverview: true,
                runtimeRole: "workflow_overview",
                workflowCanvasId: "overall-workflow",
                workflowStageId: "assess",
                workflowStageName: "Assess",
              },
            },
            {
              id: "wf-stage-guide",
              type: "stage",
              position: { x: 1280, y: 120 },
              data: {
                label:
                  "Guide\nOffer CBT-I style recommendations and next steps.\nEntry: assessment agreed.\nDone: plan accepted or revised.",
                workflowOverview: true,
                runtimeRole: "workflow_overview",
                workflowCanvasId: "overall-workflow",
                workflowStageId: "guide",
                workflowStageName: "Guide",
              },
            },
            {
              id: "wf-stage-followup",
              type: "stage",
              position: { x: 1710, y: 120 },
              data: {
                label:
                  "Follow up\nCheck progress, adjust the plan, or loop back.\nEntry: plan in place.\nDone: client is stable or returns to Assess.",
                workflowOverview: true,
                runtimeRole: "workflow_overview",
                workflowCanvasId: "overall-workflow",
                workflowStageId: "followup",
                workflowStageName: "Follow up",
              },
            },
          ],
          edges: [
            { id: "e-start-intake", source: "wf-start", target: "wf-stage-intake" },
            {
              id: "e-intake-assess",
              source: "wf-stage-intake",
              target: "wf-stage-assess",
              sourceHandle: "workflow-next-0",
              targetHandle: "workflow-previous-0",
            },
            {
              id: "e-assess-guide",
              source: "wf-stage-assess",
              target: "wf-stage-guide",
              sourceHandle: "workflow-next-0",
              targetHandle: "workflow-previous-0",
            },
            {
              id: "e-guide-followup",
              source: "wf-stage-guide",
              target: "wf-stage-followup",
              sourceHandle: "workflow-next-0",
              targetHandle: "workflow-previous-0",
            },
            {
              id: "e-followup-assess-loop",
              source: "wf-stage-followup",
              target: "wf-stage-assess",
              label: "loop / return",
              sourceHandle: "workflow-loop-0",
              targetHandle: "workflow-loop-target-0",
            },
          ],
        },
      },
    ],
  };
}

/**
 * A full-width drawer docked to the bottom of the window. It behaves like the
 * right side drawer but slides up from the bottom (the horizontal analogue): it
 * spans the whole window width, can be resized by dragging its top grabber, and
 * is dismissed with the × in its bar. Hosts a Canvas editor that fills the
 * drawer's width.
 */
export function BottomCanvasDrawer({
  open,
  onClose,
  height,
  setHeight,
  doc,
  onDocChange,
  onSave,
  saving,
  saved,
  seedDoc,
  fireSignal,
  onStageClick,
}: {
  open: boolean;
  onClose: () => void;
  height: number;
  setHeight: (h: number) => void;
  doc: CanvasDoc | null;
  onDocChange: (doc: CanvasDoc) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  seedDoc: CanvasDoc;
  /** Highlights the active workflow stage as the conversation progresses. */
  fireSignal?: CanvasFireSignal | null;
  /** Clicking a workflow stage node opens its policy canvas + trace. */
  onStageClick?: (stageId: string) => void;
}) {
  const [resizing, setResizing] = useState(false);
  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const startY = e.clientY;
    const startH = height;
    setResizing(true);
    const onMove = (ev: PointerEvent) => {
      const next = startH + (startY - ev.clientY);
      // Cap to the visible viewport (not classic 100vh) and leave a top gap so
      // the drawer can't ride under Chrome's URL / bookmark bar on mobile.
      const minH = 80;
      const visible = window.visualViewport?.height ?? window.innerHeight;
      // +20px past the default top gap so a fully extended drawer reaches higher.
      const maxH = Math.max(minH, Math.round(visible - 20 + 20));
      setHeight(Math.round(Math.max(minH, Math.min(maxH, next))));
    };
    const onUp = () => {
      setResizing(false);
      document.body.classList.remove("ra-resizing-v");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    document.body.classList.add("ra-resizing-v");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  if (!open) return null;
  return (
    <div className="bottom-drawer" style={{ height }} role="dialog" aria-label="Workflow">
      <div
        className={"bottom-drawer-resize" + (resizing ? " active" : "")}
        role="separator"
        aria-orientation="horizontal"
        aria-valuenow={height}
        aria-valuemin={80}
        aria-label="Resize workflow (drag up or down; double-click to reset)"
        title="Drag to resize"
        onPointerDown={onResizeDown}
        onDoubleClick={() => setHeight(Math.round(window.innerHeight / 3))}
      >
        <span className="bottom-drawer-grabber" aria-hidden />
      </div>
      <button
        type="button"
        className="bottom-drawer-close-fallback"
        aria-label="Close workflow"
        title="Close workflow"
        onClick={onClose}
      >
        <Ic.Close size={18} />
      </button>
      <div className="bottom-drawer-body">
        <Canvas
          value={doc}
          seedDoc={seedDoc}
          nodeKinds={WORKFLOW_CANVAS_NODE_KINDS}
          inspectorContext={{ executionPhase: "workflow" }}
          fireSignal={fireSignal}
          onNodeActivate={(node) => {
            const stageId = (node.data as Record<string, unknown>)?.workflowStageId;
            if (typeof stageId === "string") onStageClick?.(stageId);
          }}
          fillHeight
          panelLayout="split"
          onChange={({ doc: nextDoc }) => onDocChange(nextDoc)}
          tabBarTrailing={
            <button
              type="button"
              className="obs-setup-action"
              onClick={onSave}
              disabled={saving}
              title="Save workflow"
            >
              {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
            </button>
          }
          tabBarEnd={
            <button
              type="button"
              className="rf-canvas-tab-btn rf-canvas-tab-btn--icon bottom-drawer-close h-[46px]"
              aria-label="Close workflow"
              title="Close workflow"
              onClick={onClose}
            >
              <Ic.Close size={16} />
            </button>
          }
        />
      </div>
    </div>
  );
}
