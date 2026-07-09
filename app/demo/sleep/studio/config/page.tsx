"use client";

import React, { useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import "../ra-theme.css";
import { Ic, type IconName } from "../ra-icons";
import { FlowThumb, KnowledgeThumb, Logo, anchor, edgePath } from "../ra-shared";
import {
  DATASETS,
  DATASET_TYPES,
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

/* ---------------- small controls ---------------- */
function Sel({ value, opts }: { value: string; opts: string[] }) {
  const [v, setV] = useState(value);
  return (
    <div className="sc-select-wrap">
      <select className="sc-select" value={v} onChange={(e) => setV(e.target.value)}>
        {opts.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    </div>
  );
}

/* ---------------- dataset row ---------------- */
function DatasetRow({
  name,
  cols,
  notes,
  records,
}: {
  name: string;
  cols: [string, string][];
  notes: string;
  records: number;
}) {
  const [open, setOpen] = useState(false);
  const [columns, setColumns] = useState(cols);
  return (
    <div className={"sc-ds" + (open ? " open" : "")}>
      <div className="sc-ds-row" onClick={() => setOpen((o) => !o)}>
        <span className="nm">{name}</span>
        <span className="sp" />
        <span className="meta">{columns.length} columns · {records} records</span>
        <span className="cv"><Ic.Chevron size={16} /></span>
      </div>
      {open && (
        <div className="sc-ds-body">
          <span className="sc-lbl sc-mini-lbl">Columns</span>
          <div className="sc-cols">
            {columns.map((c, i) => (
              <div key={i} className="sc-col">
                <input className="sc-input" defaultValue={c[0]} />
                <Sel value={c[1]} opts={DATASET_TYPES} />
              </div>
            ))}
          </div>
          <button
            className="sc-btn ghost"
            style={{ marginTop: 10 }}
            onClick={() => setColumns((cs) => [...cs, ["new_column", "string"]])}
          >
            + Add column
          </button>
          <span className="sc-lbl sc-mini-lbl">Notes</span>
          <textarea
            className="sc-textarea serif"
            defaultValue={notes}
            placeholder="Notes about this dataset, its columns, assumptions, or caveats…"
          />
          <span className="sc-lbl sc-mini-lbl">Records</span>
          <div className="sc-rec-empty">
            {records > 0
              ? `${records} record${records > 1 ? "s" : ""}. Add a record to extend the dataset.`
              : "No records yet. Add a record to start filling the dataset."}
          </div>
          <button className="sc-btn ghost" style={{ marginTop: 10 }}>+ Add record</button>
        </div>
      )}
    </div>
  );
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
  onPopOut,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  stat: string;
  desc: string;
  thumb: React.ReactNode;
  go: (id: string) => void;
  onPopOut: (id: string) => void;
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
        <button
          className="sc-ovexpand"
          title="Open in floating window"
          aria-label={`Open ${title} in floating window`}
          onClick={(e) => { e.stopPropagation(); onPopOut(id); }}
        >
          <Ic.Expand size={15} />
        </button>
      </div>
      <p className="desc">{desc}</p>
      <span className="stat">{stat}</span>
      <div className="sc-thumb">{thumb}</div>
    </div>
  );
}

function Overview({
  go,
  onPopOut,
  guidelines,
  files,
  fields,
  agentLabel = "Primary agent",
}: {
  go: (id: string) => void;
  onPopOut: (id: string) => void;
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
          desc="Datasets and files the model can draw on."
          thumb={<KnowledgeThumb h={116} />}
          go={go}
          onPopOut={onPopOut}
        />
        <OvCard
          id="state"
          icon={<Ic.List size={18} />}
          title="State"
          stat={`${fields} fields`}
          desc="What the assistant remembers across the conversation."
          thumb={<FlowThumb nodes={STATE_NODES} edges={STATE_EDGES} h={116} />}
          go={go}
          onPopOut={onPopOut}
        />
        <OvCard
          id="policy"
          icon={<Ic.Sliders size={18} />}
          title="Policy"
          stat={`${POLICY_NODES.length} nodes`}
          desc="How the assistant decides what to do next."
          thumb={<FlowThumb nodes={POLICY_NODES} edges={POLICY_EDGES} h={116} />}
          go={go}
          onPopOut={onPopOut}
        />
      </div>
      <span className="sc-lbl" style={{ display: "block", margin: "0 0 10px" }}>Readiness</span>
      <div className="sc-check">
        <div className="ci"><span className="mark done">✓</span><span className="nm">Knowledge — datasets defined</span><span className="meta">2 datasets</span></div>
        <div className="ci"><span className="mark done">✓</span><span className="nm">State — schema defined</span><span className="meta">{fields} fields</span></div>
        <div className="ci"><span className="mark done">✓</span><span className="nm">Policy — decision flow drawn</span><span className="meta">{POLICY_NODES.length} nodes</span></div>
      </div>
    </div>
  );
}

function KnowledgePane({
  files,
  setFiles,
  guidelineItems,
  setGuidelineItems,
  dirty,
  onCommit,
}: {
  files: string[];
  setFiles: React.Dispatch<React.SetStateAction<string[]>>;
  guidelineItems: string[];
  setGuidelineItems: React.Dispatch<React.SetStateAction<string[]>>;
  dirty: boolean;
  onCommit: () => void;
}) {
  const [drag, setDrag] = useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const add = (l: FileList) => setFiles((f) => [...f, ...Array.from(l).map((x) => x.name)]);

  const updateRow = (i: number, value: string) =>
    setGuidelineItems((rows) => rows.map((row, j) => (j === i ? value : row)));
  const removeRow = (i: number) =>
    setGuidelineItems((rows) => rows.filter((_, j) => j !== i));
  const addRow = () => setGuidelineItems((rows) => [...rows, ""]);

  return (
    <div className="sc-pane-inner">
      <div className="sc-pane-head">
        <span className="sc-lbl">Step 1</span>
        <h1>Knowledge</h1>
        <p>Collect the materials the model should draw from — uploaded files and structured datasets.</p>
      </div>

      <div className="sc-list-head" style={{ marginTop: 0 }}>
        <span className="sc-lbl">Dataset: {GUIDELINE_ITEMS_DATASET_NAME} · {guidelineItems.length} rows</span>
        <button
          className="sc-btn primary"
          onClick={onCommit}
          disabled={!dirty}
          style={{ opacity: dirty ? 1 : 0.5, cursor: dirty ? "pointer" : "default" }}
        >
          {dirty ? "Commit changes" : "Committed"}
        </button>
      </div>
      <p className="desc" style={{ margin: "0 0 8px" }}>
        One row per guideline. Legacy guideline blocks were converted into rows
        (content, problem description, and recommendation concatenated) and now
        live in this dataset.
      </p>
      <div
        className="sc-guidelines"
        style={{ maxHeight: 480, overflowY: "auto", display: "grid", gap: 10, paddingRight: 6 }}
      >
        {guidelineItems.map((row, i) => (
          <div key={i} className="sc-block" style={{ marginTop: 0 }}>
            <div className="sc-block-h" style={{ cursor: "default" }}>
              <span className="sc-lbl" style={{ flex: 1 }}>Row {i + 1}</span>
              <span className="meta">{GUIDELINE_ITEMS_COLUMN_NAME}</span>
              <button className="sc-row-x" title="Remove" onClick={() => removeRow(i)} style={{ marginLeft: 8 }}>×</button>
            </div>
            <div className="sc-block-b">
              <textarea
                className="sc-textarea serif"
                value={row}
                placeholder="One guideline per row…"
                onChange={(e) => updateRow(i, e.target.value)}
                style={{ minHeight: 120, marginTop: 8 }}
              />
            </div>
          </div>
        ))}
      </div>
      <button className="sc-btn ghost" style={{ marginTop: 10 }} onClick={addRow}>
        {guidelineItems.length === 0 ? "+ Create guideline rows" : "+ Add row"}
      </button>

      <span className="sc-lbl sc-field-lbl">Files</span>
      <input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={(e) => e.target.files && add(e.target.files)} />
      <div
        className={"sc-drop" + (drag ? " drag" : "")}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files) add(e.dataTransfer.files); }}
      >
        <span>Drop files here or <span className="browse" onClick={() => fileRef.current?.click()}>browse</span></span>
        <span className="fmts">PDF · TXT · MD · DOCX</span>
      </div>
      {files.length > 0 && (
        <div className="sc-files">
          {files.map((f, i) => (
            <span key={i} className="sc-file">
              {f}
              <button onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}

      <div className="sc-list-head">
        <span className="sc-lbl">Datasets</span>
      </div>
      {DATASETS.map((d) => (
        <DatasetRow key={d.name} name={d.name} cols={d.cols} notes={d.notes} records={d.records} />
      ))}
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
  loaded = true,
}: {
  fields: SchemaField[];
  setFields: React.Dispatch<React.SetStateAction<SchemaField[]>>;
  stateDoc: CanvasDoc | null;
  onStateChange: (doc: CanvasDoc) => void;
  stateCompile: ReturnType<typeof createStateExtractionCompiler>;
  fillHeight?: boolean;
  currentState?: Record<string, unknown> | null;
  loaded?: boolean;
}) {
  const currentEntries: [string, unknown][] = currentState
    ? Object.entries(currentState)
    : fields.map(([name, , initialValue]) => [name, initialValue]);
  const hasLiveState = !!currentState;
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
      {currentEntries.length > 0 && (
        <div className="sc-curstate">
          <span className="sc-lbl">{hasLiveState ? "Current state · this conversation" : "State variables"}</span>
          <div className="sc-curstate-rows">
            {currentEntries.map(([k, v]) => {
              const set = fmtStateVal(v) !== "—";
              return (
                <div key={k} className={"sc-curstate-row" + (set ? "" : " unset")}>
                  <span className="sc-curstate-k">{k}</span>
                  <span className="sc-curstate-v">{fmtStateVal(v)}</span>
                </div>
              );
            })}
          </div>
        </div>
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
  loaded = true,
}: {
  policyDoc: CanvasDoc | null;
  onPolicyChange: (doc: CanvasDoc) => void;
  fillHeight?: boolean;
  movedToWeights?: boolean;
  fireSignal?: CanvasFireSignal | null;
  loaded?: boolean;
}) {
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

  // Load the live configuration the chat runtime actually reads, so the studio
  // reflects (and overwrites) the same backend, not a local mock.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
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
            if (Array.isArray(schema) && schema.length > 0) {
              setFields(
                schema.map((f) => {
                  const r = (f ?? {}) as Record<string, unknown>;
                  return [
                    String(r.field_name ?? ""),
                    String(r.type ?? "string"),
                    r.initial_value === null ? "null" : String(r.initial_value ?? ""),
                  ] as SchemaField;
                }),
              );
            }
            // Dataset rows are the source of truth; legacy guideline blocks
            // (older configs) are converted to rows and merged in once.
            const datasetRows = readGuidelineItemRows(config.datasets);
            const legacyRows = normalizeGuidelineBlocks(config.guideline_blocks)
              .map((block) => buildGuidelineItemText(block))
              .filter((text) => text.length > 0 && !datasetRows.includes(text));
            const restoredRows = [...datasetRows, ...legacyRows];
            if (restoredRows.length > 0) setGuidelineItems(restoredRows);
            const pDoc = buildCanvasDoc(policyCanvases);
            if (pDoc) setPolicyDoc(pDoc);
            const sDoc = buildCanvasDoc(statePolicyCanvases);
            if (sDoc) setStateDoc(sDoc);
          }
        }
      } catch {
        /* ignore — start from the seeded defaults */
      } finally {
        if (!cancelled) {
          setLoaded(true);
          setDirty(false);
          // Arm dirty-tracking only after the initial hydration settles, so
          // canvas seeding on mount doesn't register as an edit.
          setTimeout(() => { dirtyArmedRef.current = true; }, 0);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const markDirty = () => { if (dirtyArmedRef.current) setDirty(true); };

  const editGuidelineItems: React.Dispatch<React.SetStateAction<string[]>> = (updater) => {
    setGuidelineItems(updater);
    markDirty();
  };
  const editFields: React.Dispatch<React.SetStateAction<SchemaField[]>> = (updater) => {
    setFields(updater);
    markDirty();
  };

  const save = async () => {
    if (saving || !canEdit) return;
    setSaving(true);
    setSaveError(null);
    try {
      const policyDocToSave = policyDoc ?? POLICY_SEED_DOC;
      const stateDocToSave = stateDoc ?? STATE_SEED_DOC;
      const compilerFields = fields.map(([name, type, initialValue]) => ({
        name,
        type: type as StateFieldType,
        initialValue,
      }));
      const config: Record<string, unknown> = {
        config_name: (preservedRef.current.config_name as string) ?? "sleep configuration",
        state_schema: fields.map(([name, type, initial]) => ({
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
        const { id } = (await res.json()) as { id?: string };
        if (id) configIdRef.current = id;
        preservedRef.current.datasets = config.datasets;
        setDirty(false);
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
          dirty={dirty}
          onCommit={save}
        />
      );
    else if (which === "state")
      pane = (
        <StatePane
          fields={fields}
          setFields={editFields}
          stateDoc={stateDoc}
          onStateChange={(doc) => { setStateDoc(doc); markDirty(); }}
          stateCompile={stateCompile}
          fillHeight={opts?.fillHeight}
          currentState={opts?.currentState}
          loaded={loaded}
        />
      );
    else if (which === "policy")
      pane = (
        <PolicyPane
          policyDoc={policyDoc}
          onPolicyChange={(doc) => { setPolicyDoc(doc); markDirty(); }}
          fillHeight={opts?.fillHeight}
          fireSignal={opts?.fireSignal}
          loaded={loaded}
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
}: {
  /** Notifies the host (Observability pane) when a section is docked inline so it
   *  can yield space (e.g. hide the trace) to the embedded component. */
  onDockedChange?: (docked: boolean) => void;
  /** Chat turns; the latest completed one drives the policy traversal animation. */
  turns?: Turn[];
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
  // `active` is the open section. `floating` toggles between the docked-inline
  // view (component lives in the drawer) and the popped-out floating window.
  // Opens on Policy by default so the Model Setup tab lands on the flow.
  const [active, setActive] = useState<string | null>("policy");
  const [floating, setFloating] = useState(false);

  // Build a fire signal from the latest completed turn so the Policy canvas
  // animates the path the model took. The signal id is the turn id (a new turn
  // re-triggers the walk); `tools` are the tool names actually dispatched that
  // turn (real data from the trace), used to mark matching tool nodes.
  const lastTurn = turns && turns.length > 0 ? turns[turns.length - 1] : null;
  const lastDoneTurn =
    lastTurn && (lastTurn.finalAnswer != null || lastTurn.error != null)
      ? lastTurn
      : null;
  const fireSignal = React.useMemo<CanvasFireSignal | null>(() => {
    if (!lastDoneTurn) return null;
    return {
      id: lastDoneTurn.id,
      tools: traceToolNames(lastDoneTurn.trace),
      // Exact canvas nodes the runtime traversed this turn — the renderer
      // animates only from these (it never infers a path from the answer).
      exactNodeRefs: lastDoneTurn.nodeRefs ?? [],
      answer: lastDoneTurn.finalAnswer ?? "",
    };
  }, [lastDoneTurn]);
  // The most recent extracted patient state, shown in the State pane.
  const currentState = React.useMemo<Record<string, unknown> | null>(() => {
    if (!turns) return null;
    for (let i = turns.length - 1; i >= 0; i--) {
      const s = turns[i].state;
      if (s && Object.keys(s).length > 0) return s;
    }
    return null;
  }, [turns]);
  const OPTS: { id: string; label: string; ico: IconName }[] = [
    { id: "knowledge", label: "Knowledge", ico: "Book" },
    { id: "state", label: "State", ico: "List" },
    { id: "policy", label: "Policy", ico: "Sliders" },
  ];

  const docked = active != null && !floating;
  React.useEffect(() => {
    onDockedChange?.(docked);
  }, [docked, onDockedChange]);

  // When true, the popped-out window snaps to a full-width bar across the top of
  // the screen instead of free-floating at `win` geometry.
  const [topDocked, setTopDocked] = useState(false);

  const close = () => {
    setActive(null);
    setFloating(false);
    setTopDocked(false);
  };
  const label = active ? OPTS.find((o) => o.id === active)?.label ?? active : "";

  // The popped-out window's geometry (fixed-positioned). Drag the title bar to
  // move it; drag the bottom-right handle to resize. `win` is null until it's
  // popped out (initialized centered by `popOut`, below).
  const [win, setWin] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragRef = React.useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  const sizeRef = React.useRef<{ sx: number; sy: number; bw: number; bh: number } | null>(null);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  // Tell the host how much vertical space the top-docked window occupies so it
  // can pad the app frame (chat + side panels reflow below it). 0 = not docked.
  const topDockHeight = topDocked && floating && win ? win.h : 0;
  React.useEffect(() => {
    onTopDockChange?.(topDockHeight);
    return () => onTopDockChange?.(0);
  }, [topDockHeight, onTopDockChange]);

  const FLOAT_MIN_W = 360;
  const FLOAT_MIN_H = 280;

  // Pop out centered, sized to the viewport.
  const popOut = () => {
    const w = Math.min(720, window.innerWidth - 32);
    const h = Math.round(window.innerHeight * 0.8);
    setWin({
      x: Math.round((window.innerWidth - w) / 2),
      y: Math.round((window.innerHeight - h) / 2),
      w,
      h,
    });
    setFloating(true);
  };

  const onBarPointerDown = (e: React.PointerEvent) => {
    // Let the Save/Dock/Close buttons work normally — only drag from empty bar.
    // When snapped to the top it isn't a free window, so dragging is disabled.
    if ((e.target as HTMLElement).closest("button") || !win || topDocked) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, bx: win.x, by: win.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onBarPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setWin((w) =>
      w
        ? {
            ...w,
            // Keep at least part of the title bar on screen.
            x: clamp(d.bx + (e.clientX - d.sx), 40 - w.w, window.innerWidth - 80),
            y: clamp(d.by + (e.clientY - d.sy), 0, window.innerHeight - 44),
          }
        : w
    );
  };
  const onBarPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onResizePointerDown = (e: React.PointerEvent) => {
    if (!win) return;
    e.stopPropagation();
    sizeRef.current = { sx: e.clientX, sy: e.clientY, bw: win.w, bh: win.h };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onResizePointerMove = (e: React.PointerEvent) => {
    const s = sizeRef.current;
    if (!s) return;
    setWin((w) =>
      w
        ? {
            ...w,
            w: clamp(s.bw + (e.clientX - s.sx), FLOAT_MIN_W, window.innerWidth - w.x - 8),
            h: clamp(s.bh + (e.clientY - s.sy), FLOAT_MIN_H, window.innerHeight - w.y - 8),
          }
        : w
    );
  };
  const onResizePointerUp = (e: React.PointerEvent) => {
    sizeRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // The header actions are shared between the docked view and the floating
  // window — only the pop-out/dock toggle differs.
  const SaveBtn = setup.canEdit ? (
    <button
      className="sc-close"
      onClick={setup.save}
      disabled={setup.saving || !setup.dirty}
    >
      {setup.saving ? "Saving…" : "Save"}
    </button>
  ) : (
    <span className="sc-lbl" style={{ opacity: 0.6 }}>Read-only</span>
  );

  // The docked chrome (section chips + inline pane) lives inside the drawer via
  // the `slot` portal target. The floating window is portaled to <body> and is
  // owned by this page-level SetupBar, so it stays present when the drawer — and
  // thus the slot — is closed.
  const dockedChrome = (
    <>
      <div className="obs-setup">
        {OPTS.map((o) => {
          const I = Ic[o.ico];
          const on = active === o.id;
          return (
            <button
              key={o.id}
              type="button"
              className={"obs-setup-chip" + (on ? " on" : "")}
              aria-pressed={on}
              onClick={() => (on && !floating ? close() : setActive(o.id))}
              title={on ? `Close ${o.label}` : `Open ${o.label}`}
            >
              <I size={13} />
              <span>{o.label}</span>
            </button>
          );
        })}
      </div>

      {/* Docked inline: the actual section component, embedded in the drawer. */}
      {active && !floating && (
        <div className="sysconf obs-docked">
          <div className="sc-modal-bar obs-docked-bar">
            <span className="sc-lbl">{label}</span>
            <span className="sp" />
            {SaveBtn}
            <button
              className="sc-close obs-dock-toggle"
              aria-label="Pop out to a floating window"
              title="Pop out to a floating window"
              onClick={popOut}
            >
              <Ic.Expand size={13} /> Pop out
            </button>
            <button
              className="sc-close sc-modal-x"
              aria-label="Close"
              onClick={close}
            >
              ✕
            </button>
          </div>
          <div className="obs-docked-body">
            {setup.renderSectionPane(active, { fillHeight: true, fireSignal, currentState })}
          </div>
        </div>
      )}
    </>
  );

  return (
    <>
      {/* Docked chrome renders into the drawer's slot when the drawer is open. */}
      {slot ? createPortal(dockedChrome, slot) : null}

      {/* Popped out: a non-modal floating window — no dimming backdrop, so the
          chat behind it stays visible and usable. Drag by the title bar to move,
          drag the bottom-right handle to resize; Dock returns it to the drawer.
          Portaled to <body> and owned by the page-level SetupBar, so it stays
          present when the drawer (and thus the slot) is closed. */}
      {active && floating && win && typeof document !== "undefined" &&
        createPortal(
        <div className="sysconf obs-float-scope">
          <div
            className={"sc-modal sc-modal--sheet obs-float" + (topDocked ? " obs-float--top" : "")}
            style={
              topDocked
                ? { left: 0, right: 0, top: 0, width: "auto", height: win.h }
                : { left: win.x, top: win.y, width: win.w, height: win.h }
            }
          >
            <div
              className={"sc-modal-bar" + (topDocked ? "" : " sc-modal-bar--draggable")}
              onPointerDown={onBarPointerDown}
              onPointerMove={onBarPointerMove}
              onPointerUp={onBarPointerUp}
              onPointerCancel={onBarPointerUp}
            >
              <span className="sc-lbl">{label}</span>
              <span className="sp" />
              {SaveBtn}
              <button
                className={"sc-close obs-dock-toggle" + (topDocked ? " on" : "")}
                aria-label={topDocked ? "Unsnap from the top" : "Dock to the top of the screen"}
                title={topDocked ? "Unsnap from the top" : "Dock to the top of the screen"}
                aria-pressed={topDocked}
                onClick={() => setTopDocked((t) => !t)}
              >
                <Ic.Expand size={13} /> Top
              </button>
              <button
                className="sc-close obs-dock-toggle"
                aria-label="Dock back into the side drawer"
                title="Dock back into the side drawer"
                onClick={() => { setTopDocked(false); setFloating(false); }}
              >
                <Ic.Panel size={13} /> Dock
              </button>
              <button
                className="sc-close sc-modal-x"
                aria-label="Close"
                onClick={close}
              >
                ✕ Close
              </button>
            </div>
            <div className="sc-modal-body">{setup.renderSectionPane(active, { fillHeight: true, fireSignal, currentState })}</div>
            <div
              className="obs-float-resize"
              role="separator"
              aria-label="Resize window"
              title="Drag to resize"
              onPointerDown={onResizePointerDown}
              onPointerMove={onResizePointerMove}
              onPointerUp={onResizePointerUp}
              onPointerCancel={onResizePointerUp}
            />
          </div>
        </div>,
        document.body
      )}
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
          dirty={false}
          onCommit={() => {}}
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
  const [floating, setFloating] = useState<string | null>(null);
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
              <button className="sc-close" onClick={save} disabled={saving || !dirty}>
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
              onPopOut={setFloating}
              guidelines={overviewCounts.guidelines}
              files={overviewCounts.files}
              fields={overviewCounts.fields}
            />
          ) : (
            activeAgent.state.renderSectionPane(active.section)
          )}
        </div>
      </div>

      {floating && (
        <div className="sc-modal-scrim" onClick={() => setFloating(null)}>
          <div className="sc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-bar">
              <span className="sc-lbl">{floating}</span>
              <span className="sp" />
              <button className="sc-close" onClick={() => setFloating(null)}>Close</button>
            </div>
            <div className="sc-modal-body">{activeAgent.state.renderSectionPane(floating, { fillHeight: true })}</div>
          </div>
        </div>
      )}

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
