"use client";

import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import "../ra-theme.css";
import { Ic, type IconName } from "../ra-icons";
import { FlowThumb, KnowledgeThumb, Logo, anchor, edgePath } from "../ra-shared";
import {
  GUIDELINES,
  POLICY_EDGES,
  POLICY_NODES,
  POLICY_TOOLS,
  STATE_EDGES,
  STATE_FIELDS,
  STATE_GROUP,
  STATE_NODES,
  STATE_PROMPT,
  STATE_TOOLS,
  STATE_TYPES,
  type FlowEdge,
  type FlowGroup,
  type FlowNode,
  type NodeType,
  type SchemaField,
  type ToolPill,
} from "../sleep-data";
import Canvas, { type CanvasDoc, type CanvasFireSignal } from "../../../../components/canvas/Canvas";
import type { Turn, TimedTraceEvent } from "../../../../components/trace/TraceView";
import {
  compileStateExtractionPrompt,
  createStateExtractionCompiler,
  type StateFieldType,
} from "../../../../components/canvas/stateCompiler";
import { compileCanvas } from "../../../../components/canvas/compiler";
import { DEFAULT_POLICY_NODE_KINDS } from "../../../../components/canvas/node-kinds";
import { normalizeGuidelineBlocks } from "../../../../components/setup/guideline-schema";
import { buildGuidelineItemText } from "../../../../lib/general-orchestration";
import { AuthProvider, useAuth } from "../../../../context/AuthContext";
import { CompilationInfoModal } from "../ObservabilityPanel";

const SLEEP_SETUP_ENDPOINT = "/api/admin/setup/sleep";
const SLEEP_DEMO_KEY = "sleep";

/**
 * Whether the current user may change the model setup. Admins always can; the
 * demo's assigned expert can too (mirrors the server-side write gate in
 * /api/admin/setup/[demo]). Everyone else sees the setup read-only. While the
 * role is still resolving (role === null) we keep controls enabled to avoid a
 * read-only flash for admins — the server still enforces write access.
 */
function useCanEditSetup(): boolean {
  const { role, isAdmin, expertDemos } = useAuth();
  if (role === null) return true;
  return isAdmin || expertDemos.includes(SLEEP_DEMO_KEY);
}

/**
 * Wraps a setup pane so regular users can read every field but cannot change
 * anything. A disabled <fieldset> natively disables all nested inputs, buttons
 * and textareas; `.sc-readonly` (display:contents) keeps layout untouched and
 * blocks pointer interaction on the decision-flow canvas.
 */
function ReadOnlyPane({ children }: { children: React.ReactNode }) {
  return (
    <fieldset className="sc-readonly" disabled>
      <div className="sc-readonly-note">
        Read-only — only admins can change the model setup.
      </div>
      {children}
    </fieldset>
  );
}

// Guidelines are stored as a single-column dataset: one row per legacy
// guideline block, concatenating content, problem description, and
// recommendation. Legacy guideline_blocks are converted on load and the
// column is cleared on the next save.
const GUIDELINE_ITEMS_DATASET_NAME = "guideline_items";
const GUIDELINE_ITEMS_COLUMN_NAME = "text";

function isGuidelineItemsDatasetEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const name = (entry as Record<string, unknown>).name;
  return (
    typeof name === "string" &&
    name.trim().toLowerCase().replace(/[\s-]+/g, "_") === GUIDELINE_ITEMS_DATASET_NAME
  );
}

function readGuidelineItemRows(rawDatasets: unknown): string[] {
  const items = Array.isArray(rawDatasets) ? rawDatasets : [];
  const dataset = items.find(isGuidelineItemsDatasetEntry) as
    | Record<string, unknown>
    | undefined;
  const records = Array.isArray(dataset?.records) ? dataset.records : [];

  return records
    .map((record) => {
      if (typeof record === "string") return record;
      if (record && typeof record === "object" && !Array.isArray(record)) {
        const value = (record as Record<string, unknown>)[GUIDELINE_ITEMS_COLUMN_NAME];
        return typeof value === "string" ? value : "";
      }
      return "";
    })
    .filter((text) => text.trim().length > 0);
}

function upsertGuidelineItemsDataset(rawDatasets: unknown, rows: string[]): unknown[] {
  const others = (Array.isArray(rawDatasets) ? rawDatasets : []).filter(
    (entry) => !isGuidelineItemsDatasetEntry(entry)
  );
  const cleaned = rows.map((row) => row.trim()).filter((row) => row.length > 0);
  if (cleaned.length === 0) {
    return others;
  }

  return [
    ...others,
    {
      name: GUIDELINE_ITEMS_DATASET_NAME,
      notes:
        "Derived text items from legacy guideline blocks. Each row concatenates the main content, problem description, and recommendation.",
      columns: [{ name: GUIDELINE_ITEMS_COLUMN_NAME, type: "string" }],
      records: cleaned.map((text) => ({ [GUIDELINE_ITEMS_COLUMN_NAME]: text })),
    },
  ];
}

const DEFAULT_GUIDELINE_ITEMS = GUIDELINES.map((guideline) =>
  buildGuidelineItemText(guideline)
).filter((text) => text.length > 0);

type SetupCanvasRow = {
  canvas_id?: string;
  name?: string;
  sort_order?: number;
  canvas: CanvasDoc["canvases"][number];
};

function buildCanvasDoc(rows: SetupCanvasRow[] | undefined): CanvasDoc | null {
  if (!rows || rows.length === 0) return null;
  const canvases = [...rows]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((row) => ({
      ...row.canvas,
      id: row.canvas_id || row.canvas.id,
      name: row.name || row.canvas.name,
    }));
  return { version: 2, activeId: canvases[0].id, canvases };
}

function buildCanvasRows(doc: CanvasDoc | null) {
  return (doc?.canvases ?? []).map((canvas, index) => ({
    canvas_id: canvas.id,
    name: canvas.name,
    sort_order: index,
    canvas,
  }));
}

/* ---------------- flow card ---------------- */
function FlowCard({
  kicker,
  title,
  sub,
  nodes,
  edges,
  stat,
  onOpen,
}: {
  kicker: string;
  title: string;
  sub: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  stat: string;
  onOpen: () => void;
}) {
  return (
    <div className="sc-flow">
      <div className="sc-flow-h">
        <div className="tt">
          <span className="sc-lbl">{kicker}</span>
          <h4>{title}</h4>
          <span className="sub">{sub}</span>
        </div>
      </div>
      <div className="sc-flow-map" style={{ height: 158 }}>
        <FlowThumb nodes={nodes} edges={edges} h={158} />
      </div>
      <div className="sc-flow-foot">
        <span className="stat">{stat}</span>
        <span className="sp" />
        <button className="sc-btn primary" onClick={onOpen}>Open editor</button>
      </div>
    </div>
  );
}

/* ---------------- panes ---------------- */
function OvCard({
  id,
  icon,
  title,
  stat,
  desc,
  thumb,
  go,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  stat: string;
  desc: string;
  thumb: React.ReactNode;
  go: (id: string) => void;
}) {
  return (
    <div
      className="sc-ovcard"
      role="button"
      tabIndex={0}
      onClick={() => go(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(id); }
      }}
    >
      <div className="top">
        <span className="ico">{icon}</span>
        <h3>{title}</h3>
      </div>
      <p className="desc">{desc}</p>
      <span className="stat">{stat}</span>
      <div className="sc-thumb">{thumb}</div>
    </div>
  );
}

function Overview({
  go,
  guidelines,
  files,
  fields,
  agentLabel = "Primary agent",
}: {
  go: (id: string) => void;
  guidelines: number;
  files: number;
  fields: number;
  agentLabel?: string;
}) {
  return (
    <div className="sc-pane-inner">
      <div className="sc-pane-head">
        <span className="sc-lbl">{agentLabel}</span>
        <h1>Overview</h1>
        <p>
          Three things define this assistant: what it can <b>draw on</b>, what it{" "}
          <b>tracks</b>, and how it <b>decides</b>. Configure each below.
        </p>
      </div>
      <div className="sc-ovgrid">
        <OvCard
          id="knowledge"
          icon={<Ic.Book size={18} />}
          title="Knowledge"
          stat={`${guidelines} guideline rows · ${files} files`}
          desc="Guideline rows and files the model can draw on."
          thumb={<KnowledgeThumb h={116} />}
          go={go}
        />
        <OvCard
          id="state"
          icon={<Ic.List size={18} />}
          title="State"
          stat={`${fields} fields`}
          desc="What the assistant remembers across the conversation."
          thumb={<FlowThumb nodes={STATE_NODES} edges={STATE_EDGES} h={116} />}
          go={go}
        />
        <OvCard
          id="policy"
          icon={<Ic.Sliders size={18} />}
          title="Policy"
          stat={`${POLICY_NODES.length} nodes`}
          desc="How the assistant decides what to do next."
          thumb={<FlowThumb nodes={POLICY_NODES} edges={POLICY_EDGES} h={116} />}
          go={go}
        />
      </div>
      <span className="sc-lbl" style={{ display: "block", margin: "0 0 10px" }}>Readiness</span>
      <div className="sc-check">
        <div className="ci"><span className="mark done">✓</span><span className="nm">Knowledge — guideline rows</span><span className="meta">{guidelines} rows</span></div>
        <div className="ci"><span className="mark done">✓</span><span className="nm">State — schema defined</span><span className="meta">{fields} fields</span></div>
        <div className="ci"><span className="mark done">✓</span><span className="nm">Policy — decision flow drawn</span><span className="meta">{POLICY_NODES.length} nodes</span></div>
      </div>
    </div>
  );
}

/** Textarea that grows with its content so guideline rows show the full text. */
function AutoGrowTextarea({
  value,
  onChange,
  className,
  placeholder,
  style,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(resize, [value]);
  return (
    <textarea
      ref={ref}
      className={className}
      value={value}
      placeholder={placeholder}
      rows={1}
      onChange={(e) => onChange(e.target.value)}
      onInput={resize}
      style={{ overflow: "hidden", resize: "none", ...style }}
    />
  );
}

function KnowledgePane({
  files,
  setFiles,
  guidelineItems,
  setGuidelineItems,
}: {
  files: string[];
  setFiles: React.Dispatch<React.SetStateAction<string[]>>;
  guidelineItems: string[];
  setGuidelineItems: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const [drag, setDrag] = useState(false);
  // Accordion: which guideline rows are expanded (collapsed by default).
  const [openRows, setOpenRows] = useState<Set<number>>(() => new Set());
  const fileRef = React.useRef<HTMLInputElement>(null);
  const add = (l: FileList) => setFiles((f) => [...f, ...Array.from(l).map((x) => x.name)]);

  const updateRow = (i: number, value: string) =>
    setGuidelineItems((rows) => rows.map((row, j) => (j === i ? value : row)));
  const removeRow = (i: number) => {
    setGuidelineItems((rows) => rows.filter((_, j) => j !== i));
    setOpenRows((prev) => {
      const next = new Set<number>();
      for (const j of prev) {
        if (j < i) next.add(j);
        else if (j > i) next.add(j - 1);
      }
      return next;
    });
  };
  const addRow = () => {
    setGuidelineItems((rows) => {
      setOpenRows((prev) => new Set(prev).add(rows.length));
      return [...rows, ""];
    });
  };
  const toggleRow = (i: number) => {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <div className="sc-pane-inner">
      <div className="sc-pane-head">
        <span className="sc-lbl">Step 1</span>
        <h1>Knowledge</h1>
        <p>Collect the materials the model should draw from — uploaded files and structured datasets.</p>
      </div>

      <div className="sc-list-head sc-knowledge-head" style={{ marginTop: 0 }}>
        <span className="sc-lbl">
          Dataset: {GUIDELINE_ITEMS_DATASET_NAME} · {guidelineItems.length} rows
        </span>
        <div className="sc-knowledge-actions">
          <button type="button" className="sc-var-edit" onClick={addRow}>
            + Add guideline
          </button>
          <button
            type="button"
            className="sc-var-edit"
            onClick={() => fileRef.current?.click()}
          >
            + Add file
          </button>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => e.target.files && add(e.target.files)}
      />
      <div
        className={"sc-drop sc-drop--compact" + (drag ? " drag" : "")}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files) add(e.dataTransfer.files);
        }}
      >
        <span>
          Drop files here or{" "}
          <span className="browse" onClick={() => fileRef.current?.click()}>
            browse
          </span>
        </span>
        <span className="fmts">PDF · TXT · MD · DOCX</span>
      </div>
      {files.length > 0 && (
        <div className="sc-files" style={{ marginBottom: 10 }}>
          {files.map((f, i) => (
            <span key={i} className="sc-file">
              {f}
              <button onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="sc-guidelines" style={{ display: "grid", gap: 0 }}>
        {guidelineItems.map((row, i) => {
          const open = openRows.has(i);
          const preview = row.trim().replace(/\s+/g, " ");
          const previewShort =
            preview.length > 90 ? `${preview.slice(0, 90)}…` : preview;
          return (
            <div
              key={i}
              className={"sc-block" + (open ? " open" : "")}
              style={{ marginTop: 0 }}
            >
              <div
                className="sc-block-h"
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => toggleRow(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleRow(i);
                  }
                }}
              >
                <span className="cv" aria-hidden="true">
                  <Ic.Chevron size={14} />
                </span>
                <span className="sc-lbl" style={{ flex: "0 0 auto" }}>
                  {i + 1}
                </span>
                {!open && previewShort ? (
                  <span className="sc-guide-preview">{previewShort}</span>
                ) : (
                  <span style={{ flex: 1 }} />
                )}
                <span className="meta">{GUIDELINE_ITEMS_COLUMN_NAME}</span>
                <button
                  className="sc-row-x"
                  title="Remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRow(i);
                  }}
                  style={{ marginLeft: 8 }}
                >
                  ×
                </button>
              </div>
              {open && (
                <div className="sc-block-b sc-guide-body">
                  <AutoGrowTextarea
                    className="sc-textarea serif sc-guide-text"
                    value={row}
                    placeholder="One guideline per row…"
                    onChange={(value) => updateRow(i, value)}
                    style={{ minHeight: 48 }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const STATE_RULES_TEXT =
  "State rules:\n" +
  "- If a field is unknown, leave it empty after the colon.\n" +
  '- Gender should be "male", "female", "other", or blank.\n' +
  "- Age should be digits only, or blank.\n" +
  "- Wellness concern should only include symptoms. It should be blank for general conversation, otherwise a concise summary of symptoms.\n" +
  "- Update wellness concern only if new additional concerns are shared. Otherwise, no need to add patient's responses here.\n" +
  '- Candidate causes must be blank for general conversation. Candidate causes must be marked as "NA" when the gender is known and not male, or when the age is known and is either under 30 or over 75. Otherwise, if a wellness concern exists, use a comma-separated list of labels chosen only from the provided cause catalog. Refine the list incrementally, ruling out causes as new patient responses indicate.\n' +
  '- Emergency must be "true" only when the situation appears urgent or dangerous, otherwise blank.\n' +
  "- Return only the state block. Do not add an assistant message before or after END STATE.";

const STATE_SEED_DOC: CanvasDoc = {
  version: 2,
  activeId: "main",
  canvases: [
    {
      id: "main",
      name: "Main",
      freeText: "",
      graph: {
        nodes: [
          {
            id: "start",
            type: "start",
            position: { x: 360, y: 40 },
            data: {
              label:
                "You are a careful state-tracking assistant for a sleep app.\nUpdate only the patient state using the previous known state plus the latest user message.\nReturn exactly one JSON object and nothing else.",
            },
          },
          {
            id: "rules",
            type: "action",
            position: { x: 320, y: 300 },
            data: { label: STATE_RULES_TEXT, actionType: "prompt" },
          },
        ],
        edges: [{ id: "e_start_rules", source: "start", target: "rules" }],
      },
    },
  ],
};

const POLICY_SEED_DOC: CanvasDoc = {
  version: 2,
  activeId: "main",
  canvases: [
    {
      id: "main",
      name: "Main",
      freeText: "",
      graph: {
        nodes: [
          {
            id: "start",
            type: "start",
            position: { x: 340, y: 40 },
            data: {
              label:
                "You are a calm, helpful sleep assistant. You will be given the current conversation inputs plus an already-updated sleeper state. Use the updated state to decide the next assistant step.",
            },
          },
          {
            id: "emergency",
            type: "condition",
            position: { x: 340, y: 250 },
            data: { label: "the emergency flag in the state is set to true" },
          },
          {
            id: "urgent",
            type: "action",
            position: { x: 560, y: 430 },
            data: {
              label: "Advise the sleeper to seek urgent medical help and stop routine coaching.",
              actionType: "prompt",
            },
          },
          {
            id: "continue",
            type: "action",
            position: { x: 120, y: 430 },
            data: { label: "Continue the conversation and coach the sleeper.", actionType: "prompt" },
          },
        ],
        edges: [
          { id: "e_s_e", source: "start", target: "emergency" },
          { id: "e_e_u", source: "emergency", target: "urgent", label: "true" },
          { id: "e_e_c", source: "emergency", target: "continue", label: "false" },
        ],
      },
    },
    {
      // Structured sleep-intake interview: walks the assistant through every
      // history domain a clinician needs (complaint, schedule, lifestyle,
      // medical/psych/meds, subjective ratings) so the model reliably captures
      // a complete sleep history before offering any guidance.
      id: "intake",
      name: "Sleep Intake",
      freeText: "",
      graph: {
        nodes: [
          {
            id: "start",
            type: "start",
            position: { x: 340, y: 40 },
            data: {
              label:
                "You are conducting a structured sleep intake for a patient. Ask one focused, warm question at a time, confirm each answer, and record it to the patient state. Do not give advice in this canvas — your only goal is to capture a complete sleep history. Use the already-updated state to skip anything already known and ask only for what is still missing.",
            },
          },
          {
            id: "incomplete",
            type: "condition",
            position: { x: 340, y: 250 },
            data: {
              label:
                "the structured sleep intake is still incomplete — one or more of the intake domains below is missing from the state",
            },
          },
          {
            id: "complaint",
            type: "action",
            position: { x: 600, y: 430 },
            data: {
              label:
                "Capture the presenting complaint and its history: the main sleep problem in the patient's own words, when it began and what changed at onset (e.g. after childbirth or perimenopause), how it has progressed, and how many nights per week it occurs.",
              actionType: "prompt",
            },
          },
          {
            id: "schedule",
            type: "action",
            position: { x: 600, y: 640 },
            data: {
              label:
                "Capture the sleep schedule and pattern: weeknight and weekend bedtimes, time to fall asleep, number and timing of night awakenings (note any long early-morning awakening), nocturnal urination, hot flashes or pain that wake them, ability to return to sleep, wake time and time out of bed, and daytime function — fatigue, focus / brain fog, and napping.",
              actionType: "prompt",
            },
          },
          {
            id: "lifestyle",
            type: "action",
            position: { x: 600, y: 870 },
            data: {
              label:
                "Capture lifestyle and environment: caffeine (type, amount, timing of last intake), alcohol on weekdays vs weekends, other evening intake (e.g. chocolate), exercise, and the sleep environment — whether they share a bed, partner snoring, and any separate-sleeping arrangement.",
              actionType: "prompt",
            },
          },
          {
            id: "medical",
            type: "action",
            position: { x: 600, y: 1100 },
            data: {
              label:
                "Capture medical, psychiatric and medication history: weight change, cholesterol, joint / muscle pain, allergies / rhinitis, menopausal symptoms, and current medications (e.g. statin, NSAID); mood and anxiety including middle-of-the-night rumination and any history of depression or suicidal ideation; prior sleep medications tried and how the patient responded (e.g. Ambien, trazodone). Finally, ask the patient to rate sleep quality from 0–10 and sleep-related stress from 0–10.",
              actionType: "prompt",
            },
          },
          {
            id: "wrapup",
            type: "action",
            position: { x: 100, y: 430 },
            data: {
              label:
                "All intake domains are captured. Summarize the full sleep history back to the patient in a few sentences, confirm it is accurate, and let them know you're ready to move on to assessment.",
              actionType: "prompt",
            },
          },
        ],
        edges: [
          { id: "e_s_i", source: "start", target: "incomplete" },
          { id: "e_i_complaint", source: "incomplete", target: "complaint", label: "true" },
          { id: "e_complaint_schedule", source: "complaint", target: "schedule" },
          { id: "e_schedule_lifestyle", source: "schedule", target: "lifestyle" },
          { id: "e_lifestyle_medical", source: "lifestyle", target: "medical" },
          { id: "e_i_wrapup", source: "incomplete", target: "wrapup", label: "false" },
        ],
      },
    },
  ],
};

// Shown in a canvas host while the live config is still loading, so the seeded
// fallback doc never flashes before the saved canvas hydrates.
function CanvasLoadingPlaceholder() {
  return (
    <div
      className="sc-canvas-loading"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        minHeight: 200,
        opacity: 0.5,
        fontSize: 13,
      }}
    >
      Loading…
    </div>
  );
}

function StatePane({
  fields,
  setFields,
  stateDoc,
  onStateChange,
  stateCompile,
  fillHeight,
  currentState,
  stateOverride,
  highlightKeys,
  loaded = true,
  tabBarTrailing,
  onPersistFields,
  onCanvasCycle,
}: {
  fields: SchemaField[];
  setFields: React.Dispatch<React.SetStateAction<SchemaField[]>>;
  stateDoc: CanvasDoc | null;
  onStateChange: (doc: CanvasDoc) => void;
  stateCompile: ReturnType<typeof createStateExtractionCompiler>;
  fillHeight?: boolean;
  currentState?: Record<string, unknown> | null;
  /** A specific turn's snapshot to show instead of the live state (from a reply's State button). */
  stateOverride?: Record<string, unknown> | null;
  /** Field names to highlight (the ones the focused turn extracted). */
  highlightKeys?: Set<string> | null;
  loaded?: boolean;
  tabBarTrailing?: React.ReactNode;
  /** Persist the next schema immediately (used after delete so reload keeps it). */
  onPersistFields?: (next: SchemaField[]) => void | Promise<void>;
  /** Fires on mount/unmount so dirty-tracking can re-adopt the editor baseline. */
  onCanvasCycle?: (phase: "mount" | "unmount") => void;
}) {
  React.useEffect(() => {
    onCanvasCycle?.("mount");
    return () => onCanvasCycle?.("unmount");
  }, [onCanvasCycle]);
  // Prefer the schema as the source of truth for which chips to show. Live
  // conversation state may still hold keys for deleted fields — don't resurface
  // those after the user removed them from the schema.
  const schemaNames = new Set(fields.map(([name]) => name));
  // A reply's "State" button pins the panel to that turn's snapshot (stateOverride)
  // and highlights the fields it extracted; otherwise show the live state.
  const effectiveState = stateOverride ?? currentState;
  const currentEntries: [string, unknown][] = effectiveState
    ? Object.entries(effectiveState).filter(([key]) => schemaNames.has(key))
    : fields.map(([name, , initialValue]) => [name, initialValue]);
  // If live state was filtered down to nothing but the schema still has rows,
  // fall back to schema defaults so the panel doesn't look empty mid-edit.
  const displayEntries: [string, unknown][] =
    currentEntries.length > 0 || !effectiveState
      ? currentEntries
      : fields.map(([name, , initialValue]) => [name, initialValue]);
  const hasLiveState = !!effectiveState && currentEntries.length > 0;
  const [stateOpen, setStateOpen] = useState(true);
  // Pixel height of the expanded State variables block (null = content-sized).
  // Drag the handle under it to resize; persisted in localStorage.
  const [varsHeight, setVarsHeight] = useState<number | null>(null);
  const [varsSplitDragging, setVarsSplitDragging] = useState(false);
  const varsRef = React.useRef<HTMLDivElement | null>(null);
  // Collapsing/expanding the State variables block frees or reclaims height for
  // the canvas + inspector row below. That row measures its height only on
  // window resize, so nudge a re-measure here — otherwise the inspector can't be
  // dragged into the space freed by collapsing the variables.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(id);
  }, [stateOpen]);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("sc-state-vars-height");
      if (!raw) return;
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 80 && n <= 800) setVarsHeight(n);
    } catch {
      // ignore
    }
  }, []);
  React.useEffect(() => {
    if (typeof window === "undefined" || varsHeight == null) return;
    try {
      window.localStorage.setItem("sc-state-vars-height", String(varsHeight));
    } catch {
      // ignore
    }
  }, [varsHeight]);
  // Edit mode swaps the read-only value chips for an editable schema list
  // (name / type / initial value). Edits go through setFields, which marks the
  // config dirty so the Save button (on the canvas tab bar) persists them.
  const [editing, setEditing] = useState(false);
  const updateField = (i: number, pos: 0 | 1 | 2, value: string) =>
    setFields((rows) =>
      rows.map((r, j) =>
        j === i ? (r.map((c, k) => (k === pos ? value : c)) as SchemaField) : r
      )
    );
  const removeField = (i: number) => {
    const next = fields.filter((_, j) => j !== i);
    setFields(next);
    // Persist immediately — waiting for an explicit Save was leaving deletions
    // session-only, so they came back on reload.
    void onPersistFields?.(next);
  };
  const addField = () =>
    setFields((rows) => [...rows, ["new_variable", "string", "null"] as SchemaField]);
  const fmtStateVal = (v: unknown): string => {
    if (v === null || v === undefined || v === "" || v === "null") return "—";
    if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };

  return (
    <div className={"sc-pane-inner" + (fillHeight ? " sc-pane-fill" : "")}>
      <div className="sc-pane-head">
        <span className="sc-lbl">Step 2</span>
        <h1>State</h1>
        <p>The concise pieces of information the assistant tracks across the conversation, and how it updates them each turn.</p>
      </div>
      {(fields.length > 0 || editing || displayEntries.length > 0) && (
        <>
          <div
            ref={varsRef}
            className="sc-curstate"
            style={
              stateOpen
                ? {
                    // Title stays pinned; chips/editor scroll inside .sc-curstate-body.
                    height: varsHeight ?? undefined,
                    maxHeight: varsHeight ?? 240,
                    flex: "0 0 auto",
                  }
                : undefined
            }
          >
            <div className="sc-curstate-bar">
              <button
                type="button"
                className="sc-curstate-head"
                onClick={() => setStateOpen((o) => !o)}
                aria-expanded={stateOpen}
                title={stateOpen ? "Collapse" : "Expand"}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="11"
                  height="11"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={"sc-curstate-chev" + (stateOpen ? " open" : "")}
                  aria-hidden="true"
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
                <span className="sc-lbl">{hasLiveState && !editing ? "Current state · this conversation" : "State variables"}</span>
              </button>
              {stateOpen && (
                <div className="sc-curstate-actions">
                  <button type="button" className="sc-var-edit" onClick={() => setEditing((e) => !e)}>
                    {editing ? "Done" : "Edit"}
                  </button>
                  {editing && (
                    <button type="button" className="sc-var-edit" onClick={addField}>
                      + Add variable
                    </button>
                  )}
                </div>
              )}
            </div>
            {stateOpen && (
              <div className="sc-curstate-body">
                {editing ? (
                  <div className="sc-var-list">
                    {fields.map(([name, type, initial], i) => (
                      <div key={i} className="sc-var-row">
                        <input
                          className="sc-input"
                          value={name}
                          placeholder="field_name"
                          onChange={(e) => updateField(i, 0, e.target.value)}
                        />
                        <div className="sc-select-wrap">
                          <select
                            className="sc-select"
                            value={type}
                            onChange={(e) => updateField(i, 1, e.target.value)}
                          >
                            {STATE_TYPES.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </div>
                        <input
                          className="sc-input"
                          value={initial}
                          placeholder="null"
                          onChange={(e) => updateField(i, 2, e.target.value)}
                        />
                        <button
                          type="button"
                          className="sc-row-x"
                          title="Remove variable"
                          onClick={() => removeField(i)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {fields.length === 0 && (
                      <div className="sc-var-empty">No variables yet. Add one to start.</div>
                    )}
                  </div>
                ) : (
                  <div className="sc-curstate-rows">
                    {displayEntries.map(([k, v]) => {
                      const set = fmtStateVal(v) !== "—";
                      const highlighted = !!highlightKeys?.has(k);
                      return (
                        <div
                          key={k}
                          className={
                            "sc-curstate-row" +
                            (set ? "" : " unset") +
                            (highlighted ? " extracted" : "")
                          }
                        >
                          <span className="sc-curstate-k">{k}</span>
                          <span className="sc-curstate-v">{fmtStateVal(v)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Always mount the split so open↔collapsed doesn't jump; drag only
              resizes while expanded. Hairline is the sole gap above the canvas. */}
          <div
            className={"sc-vsplit" + (varsSplitDragging ? " active" : "")}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize state variables (double-click to reset)"
            title={stateOpen ? "Drag to resize · double-click to reset" : undefined}
            onDoubleClick={() => {
              if (stateOpen) setVarsHeight(null);
            }}
            onPointerDown={(e) => {
              if (!stateOpen) return;
              e.preventDefault();
              const el = varsRef.current;
              if (!el) return;
              const startY = e.clientY;
              const startH = el.getBoundingClientRect().height;
              setVarsSplitDragging(true);
              document.body.classList.add("ra-resizing-v");
              const onMove = (ev: PointerEvent) => {
                setVarsHeight(
                  Math.round(Math.max(80, Math.min(640, startH + (ev.clientY - startY))))
                );
              };
              const onUp = () => {
                setVarsSplitDragging(false);
                document.body.classList.remove("ra-resizing-v");
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp);
            }}
          />
        </>
      )}
      <div className="sc-canvas-host">
        {loaded ? (
          <Canvas
            value={stateDoc}
            seedDoc={STATE_SEED_DOC}
            compile={stateCompile}
            inspectorContext={{
              executionPhase: "state",
              runtimeProfile: "default",
              stateSchema: fields.map(([fieldName, type, initialValue]) => ({
                fieldName,
                type: type as StateFieldType,
                initialValue,
              })),
              stateUpdateSystemPrompt: STATE_PROMPT,
            }}
            fillHeight={fillHeight}
            tabBarTrailing={tabBarTrailing}
            onChange={({ doc }) => onStateChange(doc)}
          />
        ) : (
          <CanvasLoadingPlaceholder />
        )}
      </div>
    </div>
  );
}

function PolicyPane({
  policyDoc,
  onPolicyChange,
  fillHeight,
  movedToWeights,
  fireSignal,
  selectCanvasSignal,
  loaded = true,
  tabBarTrailing,
  onCanvasCycle,
}: {
  policyDoc: CanvasDoc | null;
  onPolicyChange: (doc: CanvasDoc) => void;
  fillHeight?: boolean;
  movedToWeights?: boolean;
  fireSignal?: CanvasFireSignal | null;
  selectCanvasSignal?: { canvasId: string; n: number } | null;
  loaded?: boolean;
  tabBarTrailing?: React.ReactNode;
  onCanvasCycle?: (phase: "mount" | "unmount") => void;
}) {
  React.useEffect(() => {
    onCanvasCycle?.("mount");
    return () => onCanvasCycle?.("unmount");
  }, [onCanvasCycle]);
  return (
    <div className={"sc-pane-inner" + (fillHeight ? " sc-pane-fill" : "")}>
      <div className="sc-pane-head">
        <span className="sc-lbl">Step 3</span>
        <h1>Policy</h1>
        <p>The assistant&apos;s decision logic given the current state, drawn as a flowchart that compiles to its prompt.</p>
      </div>
      <div className="sc-canvas-host">
        {loaded ? (
          <Canvas
            value={policyDoc}
            seedDoc={POLICY_SEED_DOC}
            nodeKinds={DEFAULT_POLICY_NODE_KINDS}
            inspectorContext={{ executionPhase: "policy", runtimeProfile: "default" }}
            fillHeight={fillHeight}
            graphTag={movedToWeights ? "Moved into the weights" : undefined}
            fireSignal={fireSignal}
            selectCanvasSignal={selectCanvasSignal}
            tabBarTrailing={tabBarTrailing}
            onChange={({ doc }) => onPolicyChange(doc)}
          />
        ) : (
          <CanvasLoadingPlaceholder />
        )}
      </div>
    </div>
  );
}

function EnvPane() {
  return (
    <div className="sc-pane-inner">
      <div className="sc-pane-head">
        <span className="sc-lbl">Optional</span>
        <h1>Environment agents</h1>
        <p>Add agents that simulate the world around the assistant for testing and evaluation.</p>
      </div>
      <div className="sc-rec-empty">No environment agents yet.</div>
      <button className="sc-btn primary" style={{ marginTop: 14 }}>+ Create environment agent</button>
    </div>
  );
}

/* ---------------- focused editor ---------------- */
function FootRow({ label }: { label: string }) {
  const [o, setO] = useState(false);
  return (
    <div className="sc-foot" onClick={() => setO((v) => !v)}>
      <span className="sc-lbl">{label}</span>
      <span className="pm">{o ? "–" : "+"}</span>
    </div>
  );
}

type ToolDefault = { type: NodeType; nt?: string; text: string; w: number; h: number };
const TOOL_DEFAULTS: Record<string, ToolDefault> = {
  ctrl: { type: "iff", nt: "If", text: "describe the condition…", w: 190, h: 84 },
  act: { type: "prompt", nt: "Prompt", text: "describe the action…", w: 190, h: 72 },
  end: { type: "endn", text: "End", w: 72, h: 40 },
  exp: { type: "transform", nt: "Prompt_transform", text: "describe the transform…", w: 195, h: 84 },
  async: { type: "tool", nt: "Async Job", text: "async_job", w: 165, h: 56 },
  patch: { type: "transform", nt: "Apply Patch", text: "apply a patch…", w: 175, h: 64 },
  err: { type: "endn", text: "Raise Error", w: 120, h: 40 },
};

function CanvasBoard({
  nodes: initNodes,
  edges: initEdges,
  group: initGroup,
  tools,
}: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  group: FlowGroup | null;
  tools: ToolPill[];
}) {
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const [nodes, setNodes] = useState<FlowNode[]>(() => clone(initNodes));
  const [edges, setEdges] = useState<FlowEdge[]>(() => clone(initEdges));
  const [group, setGroup] = useState<FlowGroup | null>(initGroup);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<[number, number] | null>(null);
  const [linkFromId, setLinkFromId] = useState<string | null>(null);

  // Multiple canvases live behind one editor; the live nodes/edges/group above are
  // the working buffer for whichever canvas is active. Switching or adding commits
  // the buffer back into `canvases` first, then loads the target canvas.
  type CanvasState = {
    id: string;
    name: string;
    seedNodes: FlowNode[];
    seedEdges: FlowEdge[];
    seedGroup: FlowGroup | null;
    nodes: FlowNode[];
    edges: FlowEdge[];
    group: FlowGroup | null;
  };
  const [canvases, setCanvases] = useState<CanvasState[]>(() => [
    {
      id: "main",
      name: "MAIN",
      seedNodes: clone(initNodes),
      seedEdges: clone(initEdges),
      seedGroup: initGroup,
      nodes: clone(initNodes),
      edges: clone(initEdges),
      group: initGroup,
    },
  ]);
  const [activeIdx, setActiveIdx] = useState(0);
  const activeName = canvases[activeIdx]?.name ?? "main";

  const clearTransient = () => {
    setSelected(null);
    setPending(null);
    setLinkFromId(null);
  };
  const switchCanvas = (idx: number) => {
    if (idx === activeIdx) return;
    setCanvases((cs) => cs.map((c, i) => (i === activeIdx ? { ...c, nodes, edges, group } : c)));
    const t = canvases[idx];
    setNodes(clone(t.nodes));
    setEdges(clone(t.edges));
    setGroup(t.group);
    clearTransient();
    setActiveIdx(idx);
  };
  const addCanvas = () => {
    const nextIdx = canvases.length;
    setCanvases((cs) => [
      ...cs.map((c, i) => (i === activeIdx ? { ...c, nodes, edges, group } : c)),
      {
        id: `canvas-${nextIdx}`,
        name: `CANVAS ${nextIdx + 1}`,
        seedNodes: [],
        seedEdges: [],
        seedGroup: null,
        nodes: [],
        edges: [],
        group: null,
      },
    ]);
    setNodes([]);
    setEdges([]);
    setGroup(null);
    clearTransient();
    setActiveIdx(nextIdx);
  };

  const innerRef = React.useRef<HTMLDivElement>(null);
  const nodesRef = React.useRef<FlowNode[]>(nodes);
  const dragRef = React.useRef<{ id: string; offX: number; offY: number; startX: number; startY: number; moved: boolean } | null>(null);
  const linkRef = React.useRef<{ from: string } | null>(null);
  const idRef = React.useRef(0);

  const toInner = (cx: number, cy: number): [number, number] => {
    const r = innerRef.current?.getBoundingClientRect();
    return r ? [cx - r.left, cy - r.top] : [cx, cy];
  };

  const byId: Record<string, FlowNode> = {};
  nodes.forEach((n) => { byId[n.id] = n; });
  const resolve = (ref: string | [number, number], side?: string): [number, number] =>
    Array.isArray(ref) ? ref : byId[ref] ? anchor(byId[ref], side) : [0, 0];

  React.useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  React.useEffect(() => {
    const move = (e: MouseEvent) => {
      const [mx, my] = toInner(e.clientX, e.clientY);
      if (dragRef.current) {
        const d = dragRef.current;
        if (Math.abs(e.clientX - d.startX) > 3 || Math.abs(e.clientY - d.startY) > 3) d.moved = true;
        setNodes((ns) => ns.map((n) => (n.id === d.id ? { ...n, x: Math.max(0, mx - d.offX), y: Math.max(0, my - d.offY) } : n)));
      } else if (linkRef.current) {
        setPending([mx, my]);
      }
    };
    const up = (e: MouseEvent) => {
      if (linkRef.current) {
        const [mx, my] = toInner(e.clientX, e.clientY);
        const from = linkRef.current.from;
        const target = nodesRef.current.find(
          (n) => n.id !== from && mx >= n.x && mx <= n.x + n.w && my >= n.y && my <= n.y + n.h,
        );
        if (target) {
          setEdges((es) => (es.some((x) => x.from === from && x.to === target.id) ? es : [...es, { from, to: target.id }]));
        }
        linkRef.current = null;
        setLinkFromId(null);
        setPending(null);
      }
      if (dragRef.current) {
        if (!dragRef.current.moved) setSelected(dragRef.current.id);
        dragRef.current = null;
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  const startDrag = (e: React.MouseEvent, n: FlowNode) => {
    e.preventDefault();
    e.stopPropagation();
    const [mx, my] = toInner(e.clientX, e.clientY);
    dragRef.current = { id: n.id, offX: mx - n.x, offY: my - n.y, startX: e.clientX, startY: e.clientY, moved: false };
    setSelected(n.id);
  };
  const startLink = (e: React.MouseEvent, n: FlowNode) => {
    e.preventDefault();
    e.stopPropagation();
    linkRef.current = { from: n.id };
    setLinkFromId(n.id);
    setPending(toInner(e.clientX, e.clientY));
  };

  const addNode = (cls?: string) => {
    const d = TOOL_DEFAULTS[cls ?? "act"] ?? TOOL_DEFAULTS.act;
    const id = `n${idRef.current++}-${cls ?? "act"}`;
    const off = (nodes.length % 6) * 26;
    setNodes((ns) => [...ns, { id, type: d.type, nt: d.nt, text: d.text, x: 130 + off, y: 90 + off, w: d.w, h: d.h }]);
    setSelected(id);
  };
  const removeSelected = () => {
    if (!selected) return;
    setNodes((ns) => ns.filter((n) => n.id !== selected));
    setEdges((es) => es.filter((e) => e.from !== selected && e.to !== selected));
    setSelected(null);
  };
  const reset = () => {
    const active = canvases[activeIdx];
    setNodes(clone(active.seedNodes));
    setEdges(clone(active.seedEdges));
    setGroup(active.seedGroup);
    setSelected(null);
    setPending(null);
    setLinkFromId(null);
    idRef.current = 0;
  };
  const updateText = (text: string) => {
    if (!selected) return;
    setNodes((ns) => ns.map((n) => (n.id === selected ? { ...n, text } : n)));
  };
  const onTool = (t: ToolPill) => {
    if (t.cls === "muted") removeSelected();
    else addNode(t.cls);
  };

  const sel = nodes.find((n) => n.id === selected) || null;
  const linkFrom = linkFromId ? byId[linkFromId] : null;

  return (
    <>
      <div className="sc-tabs">
        {canvases.map((c, i) => (
          <span
            key={c.id}
            className={"sc-tab" + (i === activeIdx ? " on" : "")}
            onClick={() => switchCanvas(i)}
          >
            {c.name}
          </span>
        ))}
        <span className="sc-tab" onClick={addCanvas}>+ CANVAS</span>
        <span className="sc-tab-count">{canvases.length} {canvases.length === 1 ? "CANVAS" : "CANVASES"}</span>
      </div>
      <div className="sc-tools">
        {tools.map((t, i) =>
          t.sep ? (
            <span key={i} className="sc-tools-sep" />
          ) : (
            <button
              key={i}
              className={"sc-pill " + t.cls}
              onClick={() => onTool(t)}
              disabled={t.cls === "muted" && !selected}
              style={t.cls === "muted" && !selected ? { opacity: 0.45 } : undefined}
            >
              {t.label}
            </button>
          )
        )}
      </div>
      <button className="sc-reset" onClick={reset}>Reset canvas</button>
      <div className="sc-stage">
        <div className="sc-board">
          <div
            className="sc-board-inner"
            ref={innerRef}
            onMouseDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}
          >
            <svg className="sc-edges">
              {edges.map((e, i) => {
                const p0 = resolve(e.from, e.fromSide || "b");
                const p1 = resolve(e.to, e.toSide || "t");
                const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
                return (
                  <g key={i}>
                    <path d={edgePath(p0, p1)} />
                    {e.label && (
                      <>
                        <rect className="sc-edge-lbl-bg" x={mx - 13} y={my - 8} width="26" height="14" />
                        <text className="sc-edge-lbl" x={mx} y={my + 3} textAnchor="middle">{e.label}</text>
                      </>
                    )}
                  </g>
                );
              })}
              {pending && linkFrom && (
                <path className="sc-edge-pending" d={edgePath(anchor(linkFrom, "b"), pending)} />
              )}
            </svg>
            {group && (
              <div className="sc-group" style={{ left: group.x, top: group.y, width: group.w, height: group.h }}>
                <span className="gl">{group.label}</span>
              </div>
            )}
            {nodes.map((n) => (
              <div
                key={n.id}
                className={"sc-node " + n.type + (n.id === selected ? " sel" : "")}
                style={{ left: n.x, top: n.y, width: n.w }}
                onMouseDown={(e) => startDrag(e, n)}
              >
                {n.nt && <span className="nt">{n.nt}</span>}
                <span className="nx">{n.text}</span>
                <span
                  className="sc-node-handle"
                  title="Drag to connect"
                  onMouseDown={(e) => startLink(e, n)}
                />
              </div>
            ))}
            <div className="sc-zoom">
              <button>+</button><button>–</button>
              <button title="fit">⤢</button><button title="full">⛶</button>
            </div>
          </div>
        </div>
        <div className="sc-insp">
          <span className="sc-lbl">Inspector</span>
          {sel ? (
            <>
              <span className="sc-insp-type">{sel.nt || sel.type}</span>
              <textarea
                className="sc-textarea serif"
                value={sel.text}
                onChange={(e) => updateText(e.target.value)}
                style={{ minHeight: 130, marginTop: 8 }}
              />
              <button className="sc-btn ghost" style={{ marginTop: 10 }} onClick={removeSelected}>
                Delete node
              </button>
            </>
          ) : (
            <p>Click a node to edit it, or drag it to move. Drag from a node&apos;s bottom handle onto another node to connect them. Use the toolbar to add nodes.</p>
          )}
        </div>
      </div>
      <FootRow label={`Compiler preview — ${activeName.toLowerCase()}`} />
      <FootRow label={`Additional notes — ${activeName.toLowerCase()}`} />
    </>
  );
}

function Editor({ which, onClose }: { which: "state" | "policy"; onClose: () => void }) {
  const cfg =
    which === "state"
      ? { title: "State extraction", sub: "→ compiles to extraction prompt", nodes: STATE_NODES, edges: STATE_EDGES, group: STATE_GROUP, tools: STATE_TOOLS }
      : { title: "Prompt composition", sub: "→ compiles to prompt", nodes: POLICY_NODES, edges: POLICY_EDGES, group: null, tools: POLICY_TOOLS };
  return (
    <div className="sc-editor">
      <div className="sc-editor-bar">
        <div><span className="sc-lbl">Canvas</span><h4>{cfg.title}</h4></div>
        <span className="sub" style={{ marginLeft: 10 }}>{cfg.sub}</span>
        <button className="done" onClick={onClose}>Done</button>
      </div>
      <div className="sc-editor-body">
        <CanvasBoard nodes={cfg.nodes} edges={cfg.edges} group={cfg.group} tools={cfg.tools} />
      </div>
    </div>
  );
}

/* ---------------- page ---------------- */
/**
 * All the data state + persistence for the Sleep setup sections, lifted out of
 * the page component so the same Knowledge/State/Policy editors can be rendered
 * both on the config page and in the chat's Observability overlay (SetupBar).
 */
export function useSleepSetup() {
  const canEdit = useCanEditSetup();
  const [files, setFiles] = useState<string[]>([]);
  const [fields, setFields] = useState<SchemaField[]>(STATE_FIELDS);
  const [guidelineItems, setGuidelineItems] = useState<string[]>(
    DEFAULT_GUIDELINE_ITEMS
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stateDoc, setStateDoc] = useState<CanvasDoc | null>(null);
  const [policyDoc, setPolicyDoc] = useState<CanvasDoc | null>(null);
  // False until the live config fetch settles. The canvas panes fall back to
  // their seed docs whenever the doc is null, so rendering them before the
  // fetch resolves shows the seeded policy and then visibly swaps it for the
  // saved one. Gate the canvases on this flag to avoid that flash.
  const [loaded, setLoaded] = useState(false);
  const configIdRef = React.useRef<string | null>(null);
  const preservedRef = React.useRef<Record<string, unknown>>({});
  const dirtyArmedRef = React.useRef(false);
  // Mirrors `dirty` for mount-adoption logic (avoid stale closures).
  const dirtyRef = React.useRef(false);
  // Fingerprint of last loaded/saved content. Save stays off unless the live
  // docs differ in structure or node description (not selection / position).
  const baselineRef = React.useRef<{
    policy: string;
    state: string;
    fields: string;
    guidelines: string;
  } | null>(null);
  const policyDocRef = React.useRef<CanvasDoc | null>(null);
  const stateDocRef = React.useRef<CanvasDoc | null>(null);
  const fieldsRef = React.useRef<SchemaField[]>(STATE_FIELDS);
  const guidelinesRef = React.useRef<string[]>(DEFAULT_GUIDELINE_ITEMS);
  // Canvas normalizes on mount; adopt that emit once per mount as the clean baseline.
  const policyAdoptedRef = React.useRef(false);
  const stateAdoptedRef = React.useRef(false);
  policyDocRef.current = policyDoc;
  stateDocRef.current = stateDoc;
  fieldsRef.current = fields;
  guidelinesRef.current = guidelineItems;
  dirtyRef.current = dirty;
  const stateCompile = React.useMemo(
    () =>
      createStateExtractionCompiler(
        fields.map(([name, type, initialValue]) => ({
          name,
          type: type as StateFieldType,
          initialValue,
        })),
      ),
    [fields],
  );

  // Stable JSON for node data so key-order differences don't look like edits.
  const stableValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = stableValue((value as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return value;
  };

  // Meaningful canvas content only: add/remove nodes & edges, rename canvases,
  // edit node data (description). Ignore position, selection, and active tab.
  const canvasFingerprint = (doc: CanvasDoc | null) => {
    if (!doc) return "";
    return JSON.stringify({
      version: doc.version,
      canvases: [...doc.canvases]
        .map((c) => ({
          id: c.id,
          name: c.name,
          freeText: c.freeText ?? "",
          nodes: [...(c.graph?.nodes ?? [])]
            .map((n) => ({
              id: n.id,
              type: n.type,
              data: stableValue(n.data ?? {}),
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
          edges: [...(c.graph?.edges ?? [])]
            .map((e) => ({
              id: e.id,
              source: e.source,
              target: e.target,
              sourceHandle: e.sourceHandle ?? null,
              targetHandle: e.targetHandle ?? null,
              label: e.label ?? null,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
  };

  const captureBaseline = (parts: {
    policy: CanvasDoc | null;
    state: CanvasDoc | null;
    fields: SchemaField[];
    guidelines: string[];
  }) => {
    baselineRef.current = {
      policy: canvasFingerprint(parts.policy ?? POLICY_SEED_DOC),
      state: canvasFingerprint(parts.state ?? STATE_SEED_DOC),
      fields: JSON.stringify(parts.fields),
      guidelines: JSON.stringify(parts.guidelines),
    };
  };

  const syncDirty = (parts?: {
    policy?: CanvasDoc | null;
    state?: CanvasDoc | null;
    fields?: SchemaField[];
    guidelines?: string[];
  }) => {
    if (!dirtyArmedRef.current || !baselineRef.current) {
      dirtyRef.current = false;
      setDirty(false);
      return;
    }
    const b = baselineRef.current;
    const policy = parts?.policy !== undefined ? parts.policy : policyDocRef.current;
    const state = parts?.state !== undefined ? parts.state : stateDocRef.current;
    const nextFields = parts?.fields !== undefined ? parts.fields : fieldsRef.current;
    const nextGuidelines =
      parts?.guidelines !== undefined ? parts.guidelines : guidelinesRef.current;
    const nextDirty =
      canvasFingerprint(policy ?? POLICY_SEED_DOC) !== b.policy ||
      canvasFingerprint(state ?? STATE_SEED_DOC) !== b.state ||
      JSON.stringify(nextFields) !== b.fields ||
      JSON.stringify(nextGuidelines) !== b.guidelines;
    dirtyRef.current = nextDirty;
    setDirty(nextDirty);
  };

  // First emit after a canvas mount: absorb normalize-only churn into the
  // baseline when clean. If there are already unsaved edits, keep the saved
  // baseline so remounting (tab switch, dock) doesn't grey out Save.
  const adoptCanvasBaselineIfClean = (
    which: "policy" | "state",
    nextFp: string
  ) => {
    if (!baselineRef.current) return;
    if (dirtyRef.current) return;
    baselineRef.current = { ...baselineRef.current, [which]: nextFp };
  };

  // Load the live configuration the chat runtime actually reads, so the studio
  // reflects (and overwrites) the same backend, not a local mock.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      let nextFields = STATE_FIELDS;
      let nextGuidelines = DEFAULT_GUIDELINE_ITEMS;
      let nextPolicy: CanvasDoc | null = null;
      let nextState: CanvasDoc | null = null;
      try {
        const res = await fetch(SLEEP_SETUP_ENDPOINT);
        if (res.ok) {
          const { config, policyCanvases, statePolicyCanvases } = (await res.json()) as {
            config: Record<string, unknown> | null;
            policyCanvases?: SetupCanvasRow[];
            statePolicyCanvases?: SetupCanvasRow[];
          };
          if (!cancelled && config) {
            configIdRef.current = (config.id as string) ?? null;
            // Preserve columns this UI does not manage. uploaded_files MUST be
            // echoed back: omitting it makes the save treat existing files as
            // orphans and delete them from storage.
            preservedRef.current = {
              config_name: config.config_name,
              uploaded_files: config.uploaded_files,
              datasets: config.datasets,
              environment_players: config.environment_players,
            };
            const schema = config.state_schema;
            // Honor an explicit empty array (user deleted every field). Only
            // keep the seeded STATE_FIELDS defaults when the column is absent.
            if (Array.isArray(schema)) {
              nextFields = schema.map((f) => {
                const r = (f ?? {}) as Record<string, unknown>;
                return [
                  String(r.field_name ?? ""),
                  String(r.type ?? "string"),
                  r.initial_value === null ? "null" : String(r.initial_value ?? ""),
                ] as SchemaField;
              });
              setFields(nextFields);
            }
            // Dataset rows are the source of truth; legacy guideline blocks
            // (older configs) are converted to rows and merged in once.
            const datasetRows = readGuidelineItemRows(config.datasets);
            const legacyRows = normalizeGuidelineBlocks(config.guideline_blocks)
              .map((block) => buildGuidelineItemText(block))
              .filter((text) => text.length > 0 && !datasetRows.includes(text));
            const restoredRows = [...datasetRows, ...legacyRows];
            if (restoredRows.length > 0) {
              nextGuidelines = restoredRows;
              setGuidelineItems(restoredRows);
            }
            nextPolicy = buildCanvasDoc(policyCanvases);
            if (nextPolicy) setPolicyDoc(nextPolicy);
            nextState = buildCanvasDoc(statePolicyCanvases);
            if (nextState) setStateDoc(nextState);
          }
        }
      } catch {
        /* ignore — start from the seeded defaults */
      } finally {
        if (!cancelled) {
          captureBaseline({
            policy: nextPolicy,
            state: nextState,
            fields: nextFields,
            guidelines: nextGuidelines,
          });
          setLoaded(true);
          setDirty(false);
          // Arm dirty-tracking only after the initial hydration settles, so
          // canvas seeding on mount doesn't register as an edit.
          setTimeout(() => {
            dirtyArmedRef.current = true;
            syncDirty();
          }, 0);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const editGuidelineItems: React.Dispatch<React.SetStateAction<string[]>> = (updater) => {
    setGuidelineItems((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      syncDirty({ guidelines: next });
      return next;
    });
  };
  const editFields: React.Dispatch<React.SetStateAction<SchemaField[]>> = (updater) => {
    setFields((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      syncDirty({ fields: next });
      return next;
    });
  };
  const onStateCanvasCycle = React.useCallback((phase: "mount" | "unmount") => {
    if (phase === "unmount") stateAdoptedRef.current = false;
  }, []);
  const onPolicyCanvasCycle = React.useCallback((phase: "mount" | "unmount") => {
    if (phase === "unmount") policyAdoptedRef.current = false;
  }, []);

  const save = async (overrides?: { fields?: SchemaField[] }) => {
    if (saving || !canEdit) return;
    setSaving(true);
    setSaveError(null);
    // Allow callers (e.g. delete-row) to pass the next schema explicitly so we
    // don't race React's setState and persist a stale `fields` snapshot.
    const fieldsToSave = overrides?.fields ?? fields;
    try {
      const policyDocToSave = policyDoc ?? POLICY_SEED_DOC;
      const stateDocToSave = stateDoc ?? STATE_SEED_DOC;
      const compilerFields = fieldsToSave.map(([name, type, initialValue]) => ({
        name,
        type: type as StateFieldType,
        initialValue,
      }));
      const config: Record<string, unknown> = {
        config_name: (preservedRef.current.config_name as string) ?? "sleep configuration",
        state_schema: fieldsToSave.map(([name, type, initial]) => ({
          field_name: name.trim(),
          type,
          initial_value: initial.trim(),
        })),
        state_update_prompt: compileStateExtractionPrompt(stateDocToSave, compilerFields).trim(),
        policy_prompt: compileCanvas(policyDocToSave).output.trim(),
        // Guidelines now live in the guideline_items dataset; clear the
        // legacy column so old blocks aren't re-converted on the next load.
        guideline_blocks: [],
        datasets: upsertGuidelineItemsDataset(
          preservedRef.current.datasets,
          guidelineItems
        ),
      };
      // Echo back preserved columns so a save never wipes them.
      for (const key of ["uploaded_files", "environment_players"] as const) {
        if (preservedRef.current[key] !== undefined) config[key] = preservedRef.current[key];
      }

      const res = await fetch(SLEEP_SETUP_ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config,
          policyCanvases: buildCanvasRows(policyDocToSave),
          statePolicyCanvases: buildCanvasRows(stateDocToSave),
        }),
      });
      if (res.ok) {
        const { id, executionPlanSaved, executionPlanError } =
          (await res.json()) as {
            id?: string;
            executionPlanSaved?: boolean;
            executionPlanError?: string;
          };
        if (id) configIdRef.current = id;
        preservedRef.current.datasets = config.datasets;
        captureBaseline({
          policy: policyDocToSave,
          state: stateDocToSave,
          fields: fieldsToSave,
          guidelines: guidelineItems,
        });
        // Allow the next canvas emit to re-absorb normalize-only differences.
        policyAdoptedRef.current = false;
        stateAdoptedRef.current = false;
        dirtyRef.current = false;
        setDirty(false);
        // The canvas rows saved, but the execution plan that actually drives the
        // runtime (and the policy-canvas trajectory) is regenerated separately and
        // best-effort. If that failed, the system will keep running the previous
        // plan — surface it instead of reporting a clean save.
        if (executionPlanSaved === false) {
          setSaveError(
            `Saved, but the execution plan failed to regenerate — the runtime will keep using the previous plan${
              executionPlanError ? `: ${executionPlanError.slice(0, 240)}` : "."
            }`
          );
        } else {
          setSaveError(null);
        }
      } else {
        const body = await res.text().catch(() => "");
        let detail = body;
        try {
          const j = JSON.parse(body) as { error?: string };
          if (j?.error) detail = j.error;
        } catch { /* keep raw body */ }
        setSaveError(`Save failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 240)}` : ""}`);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed (network error)");
    } finally {
      setSaving(false);
    }
  };

  const renderSectionPane = (
    which: string,
    opts?: {
      fillHeight?: boolean;
      fireSignal?: CanvasFireSignal | null;
      currentState?: Record<string, unknown> | null;
      /** When a reply's State button is clicked, show this turn's snapshot instead of the live state. */
      stateOverride?: Record<string, unknown> | null;
      /** Fields to highlight in the State panel (the ones that turn extracted). */
      stateHighlight?: Set<string> | null;
      /** When bumped, selects a specific policy canvas (e.g. a workflow stage's canvas). */
      policyCanvasSelect?: { canvasId: string; n: number } | null;
      /** Optional content docked at the trailing edge of the Policy canvas tab bar. */
      tabBarTrailing?: React.ReactNode;
    }
  ) => {
    let pane: React.ReactNode = null;
    if (which === "knowledge")
      pane = (
        <KnowledgePane
          files={files}
          setFiles={setFiles}
          guidelineItems={guidelineItems}
          setGuidelineItems={editGuidelineItems}
        />
      );
    else if (which === "state")
      pane = (
        <StatePane
          fields={fields}
          setFields={editFields}
          stateDoc={stateDoc}
          onStateChange={(doc) => {
            setStateDoc(doc);
            if (!dirtyArmedRef.current || !baselineRef.current) return;
            const nextFp = canvasFingerprint(doc);
            // First emit after (re)mount: absorb normalize churn when clean.
            if (!stateAdoptedRef.current) {
              stateAdoptedRef.current = true;
              adoptCanvasBaselineIfClean("state", nextFp);
            }
            syncDirty({ state: doc });
          }}
          onCanvasCycle={onStateCanvasCycle}
          stateCompile={stateCompile}
          fillHeight={opts?.fillHeight}
          currentState={opts?.currentState}
          stateOverride={opts?.stateOverride}
          highlightKeys={opts?.stateHighlight}
          loaded={loaded}
          tabBarTrailing={opts?.tabBarTrailing}
          onPersistFields={(next) => save({ fields: next })}
        />
      );
    else if (which === "policy")
      pane = (
        <PolicyPane
          policyDoc={policyDoc}
          onPolicyChange={(doc) => {
            setPolicyDoc(doc);
            if (!dirtyArmedRef.current || !baselineRef.current) return;
            const nextFp = canvasFingerprint(doc);
            if (!policyAdoptedRef.current) {
              policyAdoptedRef.current = true;
              adoptCanvasBaselineIfClean("policy", nextFp);
            }
            syncDirty({ policy: doc });
          }}
          onCanvasCycle={onPolicyCanvasCycle}
          fillHeight={opts?.fillHeight}
          fireSignal={opts?.fireSignal}
          selectCanvasSignal={opts?.policyCanvasSelect}
          loaded={loaded}
          tabBarTrailing={opts?.tabBarTrailing}
        />
      );
    else if (which === "env") pane = <EnvPane />;
    if (!pane) return null;
    return canEdit ? pane : <ReadOnlyPane>{pane}</ReadOnlyPane>;
  };

  return { files, fields, guidelineItems, dirty, saving, saveError, save, canEdit, renderSectionPane };
}

/**
 * Compact, single-line strip of the three model-setup options (Knowledge,
 * State, Policy) plus the full-editor overlay they open. Rendered inside the
 * chat's Observability panel header. The overlay is wrapped in `.sysconf` so
 * the section panes pick up the System Configuration palette even though they
 * live under the chat's `.ra-scope` theme.
 */
/** True when a state value counts as "empty" (nothing was extracted for it). */
function isEmptyStateValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  const s = String(v).trim();
  return s === "" || s === "null";
}

/**
 * Maps each turn id to the state fields it *extracted this turn* — i.e. fields
 * whose value became non-empty or changed from the previous turn's state. Drives
 * the per-reply "State" button (only shown when a turn extracted something) and
 * the highlight of those fields in the State panel.
 */
export function turnExtractedStateKeys(turns: Turn[] | undefined): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!turns) return map;
  for (let i = 0; i < turns.length; i++) {
    const cur = turns[i].state;
    if (!cur) continue;
    const prev = (i > 0 ? turns[i - 1].state : null) ?? {};
    const changed = Object.keys(cur).filter((k) => {
      const cv = cur[k];
      if (isEmptyStateValue(cv)) return false;
      return JSON.stringify(cv) !== JSON.stringify((prev as Record<string, unknown>)[k]);
    });
    if (changed.length > 0) map.set(turns[i].id, changed);
  }
  return map;
}

/** Unique tool names actually dispatched in a turn's trace (real signal). */
function traceToolNames(trace: TimedTraceEvent[]): string[] {
  const names = new Set<string>();
  for (const ev of trace) {
    if (ev.kind === "tool_dispatch" && ev.tool) names.add(ev.tool);
    else if (ev.kind === "openai_response")
      for (const call of ev.toolCalls) if (call.name) names.add(call.name);
  }
  return [...names];
}

export function SetupBar({
  onDockedChange,
  turns,
  slot,
  onTopDockChange,
  policyFocus,
  stateFocus,
  policyCanvasSelect,
}: {
  /** Notifies the host (Observability pane) when a section is docked inline so it
   *  can yield space (e.g. hide the trace) to the embedded component. */
  onDockedChange?: (docked: boolean) => void;
  /** Chat turns; the latest completed one drives the policy traversal animation. */
  turns?: Turn[];
  /**
   * Bumped when a reply's "Policy trace" button is clicked: switches to the Policy
   * section and re-animates that specific turn's path (instead of the latest turn).
   */
  policyFocus?: { id: string; n: number };
  /**
   * Bumped when a reply's "State" button is clicked: switches to the State section
   * and highlights the fields that turn extracted (showing that turn's snapshot).
   */
  stateFocus?: { id: string; n: number };
  /**
   * Bumped when a workflow stage is clicked: switches to Policy and selects that
   * stage's policy canvas.
   */
  policyCanvasSelect?: { canvasId: string; n: number };
  /**
   * DOM node inside the drawer's Model Setup pane to portal the docked (inline)
   * view into. SetupBar itself is mounted at the page level so the popped-out
   * floating window (portaled to <body>) survives the drawer closing; the docked
   * chrome only renders when this slot exists (i.e. the drawer is open).
   */
  slot?: HTMLElement | null;
  /**
   * Reports the height (px) occupied by the top-docked window, or 0 when it's not
   * top-docked. The host pads the app frame by this amount so the chat and side
   * panels reflow below the docked window instead of hiding behind it.
   */
  onTopDockChange?: (height: number) => void;
} = {}) {
  const setup = useSleepSetup();
  // `active` is the open section. The setup always renders docked inline in the
  // drawer — the pop-out-to-floating-window feature was removed.
  // Opens on Policy by default so the Model Setup tab lands on the flow.
  const [active, setActive] = useState<string | null>("policy");
  // The "How each turn reaches the model" modal (full prompts + the fixed order
  // they're sent in), opened from the "i" on the left of the section nav.
  const [compileInfoOpen, setCompileInfoOpen] = useState(false);

  // When a reply's "Policy trace" button is clicked (policyFocus.n bumps), switch
  // to the Policy section and pin the animation to that specific turn until the
  // next click. Otherwise the canvas animates the latest completed turn (live).
  const [focusedTurn, setFocusedTurn] = React.useState<{ id: string; n: number } | null>(null);
  React.useEffect(() => {
    if (policyFocus && policyFocus.n > 0) {
      setActive("policy");
      setFocusedTurn(policyFocus);
    }
    // Only react to a new click (n change), not to identity changes of the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyFocus?.n]);
  // A workflow stage click switches to Policy so its canvas becomes visible.
  React.useEffect(() => {
    if (policyCanvasSelect && policyCanvasSelect.n > 0) setActive("policy");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyCanvasSelect?.n]);

  // Build a fire signal so the Policy canvas animates the path the model took.
  // A focused turn (from a bubble's Policy button) wins; otherwise the latest
  // completed turn drives the walk. `tools` are the tool names actually dispatched
  // that turn (real trace data), used to mark matching tool nodes.
  const lastTurn = turns && turns.length > 0 ? turns[turns.length - 1] : null;
  const lastDoneTurn =
    lastTurn && (lastTurn.finalAnswer != null || lastTurn.error != null)
      ? lastTurn
      : null;
  const fireSignal = React.useMemo<CanvasFireSignal | null>(() => {
    const focusTurn = focusedTurn
      ? turns?.find((t) => t.id === focusedTurn.id) ?? null
      : null;
    const turn = focusTurn ?? lastDoneTurn;
    if (!turn) return null;
    return {
      // Include the focus nonce so re-clicking the same reply re-triggers the walk.
      id: focusTurn ? `${turn.id}#focus${focusedTurn!.n}` : turn.id,
      tools: traceToolNames(turn.trace),
      // Exact canvas nodes the runtime traversed this turn — the renderer
      // animates only from these (it never infers a path from the answer).
      exactNodeRefs: turn.nodeRefs ?? [],
      answer: turn.finalAnswer ?? "",
    };
  }, [focusedTurn, lastDoneTurn, turns]);
  // The most recent extracted patient state, shown in the State pane.
  const currentState = React.useMemo<Record<string, unknown> | null>(() => {
    if (!turns) return null;
    for (let i = turns.length - 1; i >= 0; i--) {
      const s = turns[i].state;
      if (s && Object.keys(s).length > 0) return s;
    }
    return null;
  }, [turns]);

  // State focus: clicking a reply's "State" button switches to the State section
  // and pins the panel to that turn's snapshot, highlighting the fields it
  // extracted. Cleared to null → the panel shows the latest state (live).
  const [focusedStateTurn, setFocusedStateTurn] = React.useState<{ id: string; n: number } | null>(null);
  React.useEffect(() => {
    if (stateFocus && stateFocus.n > 0) {
      setActive("state");
      setFocusedStateTurn(stateFocus);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateFocus?.n]);
  const extractedKeysByTurn = React.useMemo(() => turnExtractedStateKeys(turns), [turns]);
  // When a turn is focused, override the panel's state with that turn's snapshot
  // and highlight only the fields it extracted; otherwise show the live state.
  const { stateOverride, stateHighlight } = React.useMemo<{
    stateOverride: Record<string, unknown> | null;
    stateHighlight: Set<string> | null;
  }>(() => {
    if (!focusedStateTurn) return { stateOverride: null, stateHighlight: null };
    const turn = turns?.find((t) => t.id === focusedStateTurn.id) ?? null;
    if (!turn?.state) return { stateOverride: null, stateHighlight: null };
    return {
      stateOverride: turn.state,
      stateHighlight: new Set(extractedKeysByTurn.get(turn.id) ?? []),
    };
  }, [focusedStateTurn, turns, extractedKeysByTurn]);
  const OPTS: { id: string; label: string; ico: IconName }[] = [
    { id: "knowledge", label: "Knowledge", ico: "Book" },
    { id: "state", label: "State", ico: "List" },
    { id: "policy", label: "Policy", ico: "Sliders" },
  ];

  const docked = active != null;
  React.useEffect(() => {
    onDockedChange?.(docked);
  }, [docked, onDockedChange]);

  // No floating window anymore, so nothing ever reserves top-dock height. Reset
  // the host's reserved space once so the chat/side panels reflow full-height.
  React.useEffect(() => {
    onTopDockChange?.(0);
    return () => onTopDockChange?.(0);
  }, [onTopDockChange]);

  const close = () => setActive(null);

  // Save lives on the section nav bar itself (no separate title row). The
  // pop-out-to-floating-window control was removed per request.
  const navActions = active ? (
    <div className="obs-setup-actions">
      {setup.canEdit ? (
        <button
          type="button"
          className={"obs-setup-action" + (setup.dirty && !setup.saving ? " dirty" : "")}
          onClick={() => void setup.save()}
          disabled={setup.saving || !setup.dirty}
          title={setup.dirty ? "You have unsaved changes" : "No changes to save"}
        >
          {setup.saving ? (
            "Saving…"
          ) : setup.dirty ? (
            <>
              <span className="unsaved-dot" aria-hidden />
              Save
            </>
          ) : (
            "Save"
          )}
        </button>
      ) : (
        <span className="obs-setup-action" style={{ opacity: 0.6 }}>Read-only</span>
      )}
    </div>
  ) : null;

  // The docked chrome (section nav + inline pane) lives inside the drawer via
  // the `slot` portal target. The floating window is portaled to <body> and is
  // owned by this page-level SetupBar, so it stays present when the drawer — and
  // thus the slot — is closed.
  // Save lives on the canvas tab bar (the Main/+Canvas · Tools · Collapse line)
  // for the sections that HAVE a canvas — Policy and State — via tabBarTrailing.
  // Knowledge has no canvas, so its Save stays on the section nav row.
  const canvasSection = active === "policy" || active === "state";

  const dockedChrome = (
    <>
      <div className="obs-setup">
        {OPTS.map((o) => {
          const on = active === o.id;
          return (
            <button
              key={o.id}
              type="button"
              className={"obs-setup-chip" + (on ? " on" : "")}
              aria-pressed={on}
              onClick={() => (on ? close() : setActive(o.id))}
              title={on ? `Close ${o.label}` : `Open ${o.label}`}
            >
              <span>{o.label}</span>
            </button>
          );
        })}
        {!canvasSection ? navActions : null}
        <button
          type="button"
          className="obs-setup-info"
          aria-label="How each turn reaches the model"
          title="How each turn reaches the model — full prompts & order"
          onClick={() => setCompileInfoOpen(true)}
        >
          <Ic.Info size={16} />
        </button>
      </div>
      {compileInfoOpen && <CompilationInfoModal onClose={() => setCompileInfoOpen(false)} />}

      {/* Docked inline: the actual section component, embedded in the drawer.
          For canvas sections, Save is docked into the canvas tab bar
          (tabBarTrailing); otherwise it's on the nav bar above. */}
      {active && (
        <div className="sysconf obs-docked">
          <div className="obs-docked-body">
            {setup.renderSectionPane(active, {
              fillHeight: true,
              fireSignal,
              currentState,
              stateOverride,
              stateHighlight,
              policyCanvasSelect,
              tabBarTrailing: canvasSection ? navActions : undefined,
            })}
          </div>
        </div>
      )}
    </>
  );

  return (
    <>
      {/* Docked chrome renders into the drawer's slot when the drawer is open. */}
      {slot ? createPortal(dockedChrome, slot) : null}
    </>
  );
}

/**
 * Lightweight, in-memory agent state for the secondary agents (Environment,
 * Critic). Unlike the Primary agent (useSleepSetup) these are not persisted to
 * the backend — they reuse the same Knowledge / State / Policy editor panes so
 * each secondary agent has its own independent configuration in the session.
 */
function useLocalAgent({ movedToWeights }: { movedToWeights?: boolean } = {}) {
  const canEdit = useCanEditSetup();
  const [files, setFiles] = useState<string[]>([]);
  const [fields, setFields] = useState<SchemaField[]>(STATE_FIELDS);
  const [guidelineItems, setGuidelineItems] = useState<string[]>(
    DEFAULT_GUIDELINE_ITEMS
  );
  const [stateDoc, setStateDoc] = useState<CanvasDoc | null>(null);
  const [policyDoc, setPolicyDoc] = useState<CanvasDoc | null>(null);
  const stateCompile = React.useMemo(
    () =>
      createStateExtractionCompiler(
        fields.map(([name, type, initialValue]) => ({
          name,
          type: type as StateFieldType,
          initialValue,
        })),
      ),
    [fields],
  );
  const renderSectionPane = (which: string, opts?: { fillHeight?: boolean }) => {
    let pane: React.ReactNode = null;
    if (which === "knowledge")
      pane = (
        <KnowledgePane
          files={files}
          setFiles={setFiles}
          guidelineItems={guidelineItems}
          setGuidelineItems={setGuidelineItems}
        />
      );
    else if (which === "state")
      pane = (
        <StatePane
          fields={fields}
          setFields={setFields}
          stateDoc={stateDoc}
          onStateChange={setStateDoc}
          stateCompile={stateCompile}
          fillHeight={opts?.fillHeight}
        />
      );
    else if (which === "policy")
      pane = (
        <PolicyPane
          policyDoc={policyDoc}
          onPolicyChange={setPolicyDoc}
          fillHeight={opts?.fillHeight}
          movedToWeights={movedToWeights}
        />
      );
    if (!pane) return null;
    return canEdit ? pane : <ReadOnlyPane>{pane}</ReadOnlyPane>;
  };
  return { files, fields, guidelineItems, renderSectionPane };
}

type AgentSection = { id: string; ico: IconName; nm: string; st: string; done: boolean | null };

function SleepStudioConfigInner() {
  const router = useRouter();
  // Active selection is scoped to version + agent so identically-named sections
  // (Knowledge / State / Policy) don't collide across agents or versions.
  const [active, setActive] = useState<{ version: string; agent: string; section: string }>({
    version: "v0",
    agent: "primary",
    section: "overview",
  });
  // All accordions start collapsed; the active agent (v0 Primary) is still
  // highlighted to show which configuration the pane is displaying.
  const [openAgents, setOpenAgents] = useState<Set<string>>(new Set());
  const [publishVer, setPublishVer] = useState<{ id: string; label: string } | null>(null);
  const [training, setTraining] = useState(false);
  const closePublish = () => {
    setPublishVer(null);
    setTraining(false);
  };
  // v0 Primary is the persisted config; everything else is in-memory per session.
  const primary = useSleepSetup();
  const environment = useLocalAgent();
  const critic = useLocalAgent();
  // v1 is the trained version — its policy logic has been folded into the model
  // weights, shown with a dashed frame + tag on the policy canvas.
  const v1Primary = useLocalAgent({ movedToWeights: true });
  const v1Environment = useLocalAgent({ movedToWeights: true });
  const v1Critic = useLocalAgent({ movedToWeights: true });
  const { dirty, saving, saveError, save, canEdit } = primary;

  type AgentState = {
    guidelineItems: string[];
    files: string[];
    fields: SchemaField[];
    renderSectionPane: (which: string, opts?: { fillHeight?: boolean }) => React.ReactNode;
  };
  const ksp = (a: AgentState): AgentSection[] => [
    { id: "knowledge", ico: "Book", nm: "Knowledge", st: `${a.guidelineItems.length} guideline rows · ${a.files.length} files`, done: true },
    { id: "state", ico: "List", nm: "State", st: `${a.fields.length} fields`, done: true },
    { id: "policy", ico: "Sliders", nm: "Policy", st: `${POLICY_NODES.length} nodes`, done: true },
  ];

  type Agent = {
    id: string;
    name: string;
    state: AgentState;
    sections: AgentSection[];
  };
  const makeAgents = (p: AgentState, e: AgentState, c: AgentState): Agent[] => [
    {
      id: "primary",
      name: "Primary Agent",
      state: p,
      sections: [
        { id: "overview", ico: "Grid", nm: "Overview", st: "primary agent", done: null },
        ...ksp(p),
      ],
    },
    {
      id: "environment",
      name: "Environment",
      state: e,
      sections: [
        { id: "overview", ico: "Grid", nm: "Overview", st: "environment agent", done: null },
        ...ksp(e),
      ],
    },
    {
      id: "critic",
      name: "Critic",
      state: c,
      sections: [
        { id: "knowledge", ico: "Book", nm: "Knowledge", st: `${c.guidelineItems.length} guideline rows · ${c.files.length} files`, done: true },
      ],
    },
  ];

  const VERSIONS: { id: string; label: string; agents: Agent[] }[] = [
    { id: "v0", label: "Agent 0", agents: makeAgents(primary, environment, critic) },
    { id: "v1", label: "Agent 1", agents: makeAgents(v1Primary, v1Environment, v1Critic) },
  ];

  const toggleAgent = (versionId: string, agentId: string) => {
    const key = `${versionId}:${agentId}`;
    setOpenAgents((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        const ag = VERSIONS.find((v) => v.id === versionId)?.agents.find((a) => a.id === agentId);
        if (ag && ag.sections[0]) setActive({ version: versionId, agent: agentId, section: ag.sections[0].id });
      }
      return next;
    });
  };

  const activeVersion = VERSIONS.find((v) => v.id === active.version) ?? VERSIONS[0];
  const activeAgent = activeVersion.agents.find((a) => a.id === active.agent) ?? activeVersion.agents[0];
  const overviewCounts = {
    guidelines: activeAgent.state.guidelineItems.length,
    files: activeAgent.state.files.length,
    fields: activeAgent.state.fields.length,
  };

  return (
    <div className="sysconf">
      <div className="sc-bar">
        <Link
          href="/demo"
          aria-label="Back to Models"
          title="Back to Models"
          style={{ display: "inline-flex", textDecoration: "none" }}
        >
          <Logo />
        </Link>
        <div className="sc-bar-title">
          <b>Sleep Assistant</b>
          <span className="sep">·</span>
          <span className="dim">System Configuration</span>
        </div>
        <div className="sc-bar-right">
          {saveError && (
            <span className="sc-save" style={{ color: "#c2360f", maxWidth: 420, whiteSpace: "normal" }} title={saveError}>
              {saveError}
            </span>
          )}
          {canEdit ? (
            <>
              <span className="sc-save">
                <span className="dot" style={dirty || saving ? { background: "#c2611f" } : undefined} />
                {saving ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}
              </span>
              <button className="sc-close" onClick={() => void save()} disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          ) : (
            <span className="sc-save">
              <span className="dot" />
              Read-only — admins can edit
            </span>
          )}
        </div>
      </div>

      <div className="sc-body">
        <nav className="sc-nav">
          <button
            type="button"
            className="sc-back"
            onClick={() => router.push("/demo/sleep/studio")}
          >
            <div className="row"><span className="nm">Back to chat</span><span className="cv"><Ic.Chevron size={15} /></span></div>
          </button>
          {VERSIONS.map((ver) => (
            <div key={ver.id} className="sc-nav-ver">
              <div className="sc-nav-hd">
                <span>{ver.label}</span>
                {canEdit && (
                  <button
                    type="button"
                    className="sc-nav-pub"
                    title={`Train ${ver.label}`}
                    aria-label={`Train ${ver.label}`}
                    onClick={() => { setTraining(false); setPublishVer({ id: ver.id, label: ver.label }); }}
                  >
                    <Ic.Upload size={14} />
                  </button>
                )}
              </div>
              {ver.agents.map((ag) => {
                const open = openAgents.has(`${ver.id}:${ag.id}`);
                return (
                  <div key={ag.id} className="sc-agentgroup">
                    <button
                      type="button"
                      className={
                        "sc-agentpick" +
                        (open ? " open" : "") +
                        (active.version === ver.id && active.agent === ag.id ? " current" : "")
                      }
                      onClick={() => toggleAgent(ver.id, ag.id)}
                      aria-expanded={open}
                      aria-label={`${ver.label} ${ag.name} — toggle sections`}
                    >
                      <div className="row"><span className="nm">{ag.name}</span><span className="cv"><Ic.Chevron size={15} /></span></div>
                    </button>
                    {open && (
                      <div className="sc-navlist">
                        {ag.sections.map((n) => {
                          const I = Ic[n.ico];
                          const on = active.version === ver.id && active.agent === ag.id && active.section === n.id;
                          return (
                            <button
                              key={n.id}
                              className={"sc-navitem" + (on ? " on" : "")}
                              onClick={() => setActive({ version: ver.id, agent: ag.id, section: n.id })}
                            >
                              <span className="ico"><I size={17} /></span>
                              <span className="tt"><span className="nm">{n.nm}</span><span className="st">{n.st}</span></span>
                              {n.done !== null && <span className={"chk" + (n.done ? "" : " empty")}>{n.done ? "✓" : "○"}</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sc-pane">
          {active.section === "overview" ? (
            <Overview
              agentLabel={`${activeVersion.label} · ${active.agent === "environment" ? "Environment" : "Primary agent"}`}
              go={(id) => setActive({ version: active.version, agent: active.agent, section: id })}
              guidelines={overviewCounts.guidelines}
              files={overviewCounts.files}
              fields={overviewCounts.fields}
            />
          ) : (
            activeAgent.state.renderSectionPane(active.section)
          )}
        </div>
      </div>

      {publishVer && (
        <div className="sc-modal-scrim" onClick={closePublish}>
          <div className="sc-dialog" onClick={(e) => e.stopPropagation()}>
            <span className="sc-lbl">Train · {publishVer.label}</span>
            <h2 className="sc-dialog-title">
              Move to Agent {parseInt(publishVer.id.replace(/\D/g, ""), 10) + 1}
            </h2>
            {training ? (
              <div className="sc-dialog-training">
                <div className="sc-spinner" aria-hidden="true" />
                <p className="sc-dialog-text">We will notify you when the process is complete.</p>
              </div>
            ) : (
              <>
                <p className="sc-dialog-text">
                  Training folds everything you&apos;ve configured into the model itself. It
                  learns from the feedback you&apos;ve provided and the prompts you&apos;ve
                  defined, and all of the harness logic — knowledge, state, and policy — is
                  moved into the model weights. The result is a new, upgraded version of the
                  agent.
                </p>
                <div className="sc-dialog-actions">
                  <button className="sc-btn ghost" onClick={closePublish}>Cancel</button>
                  <button className="sc-btn primary" onClick={() => setTraining(true)}>Train</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <Link
        href="/demo/general-orchestration-daemon"
        className="god-fab"
        title="Talk to main agent"
      >
        Talk to main agent
      </Link>
    </div>
  );
}

export default function SleepStudioConfig() {
  // The config page is its own route (no shared studio layout), so it must
  // provide the auth context the read-only gate (useCanEditSetup) reads.
  return (
    <AuthProvider>
      <SleepStudioConfigInner />
    </AuthProvider>
  );
}
