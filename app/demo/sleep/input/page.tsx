"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import SiteNavbar from "../../../components/SiteNavbar";
import Canvas, {
  type CanvasDoc,
  type CanvasEntry,
} from "../../../components/canvas/Canvas";
import {
  buildInspectorDatasetNames,
  buildInspectorDatasetsContext,
} from "../../../components/canvas/inspector-prompt-context";
import { DEFAULT_POLICY_NODE_KINDS } from "../../../components/canvas/node-kinds";
import { createStateExtractionCompiler } from "../../../components/canvas/stateCompiler";
import SimulationPlayerEditor, {
  DatasetRow,
  type SimulationPlayerConfig,
} from "../../../components/setup/SimulationPlayerEditor";
import {
  createEmptyDataset,
  createEmptyDatasetRecord,
  normalizeDatasets,
  resizeDatasetColumns,
  serializeDatasets,
  type SimulationPlayerDatasetColumn,
} from "../../../components/setup/dataset-schema";
import {
  normalizeGuidelineBlocks,
  serializeGuidelineBlocks,
} from "../../../components/setup/guideline-schema";
import { createSupabaseBrowserClient } from "../../../lib/supabase-browser";

// ── Types ────────────────────────────────────────────────────────────────────

type FieldType = "string" | "integer" | "boolean" | "string[]" | "number" | "json";

interface StateField {
  id: string;
  name: string;
  type: FieldType;
  initialValue: string;
}

interface GuidelineBlock {
  id: string;
  topic: string;
  content: string;
  problem: string;
  recommendation: string;
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  bucket?: string;
  path?: string;
  url?: string;
  isObjectUrl?: boolean;
  uploaded_by_email?: string | null;
  uploaded_by_uuid?: string;
  uploaded_at?: string;
}

interface SleepInputRow {
  id: string;
  created_at: string;
  updated_at: string;
  state_schema: Array<{ field_name?: string; type?: FieldType; initial_value?: string | null }>;
  state_update_prompt: string;
  policy_prompt: string;
  guideline_blocks: Array<{
    topic?: string;
    content?: string;
    problem?: string;
    recommendation?: string;
  }>;
  datasets?: unknown;
  uploaded_files: UploadedFile[];
  environment_players?: unknown;
}

interface PolicyCanvasRow {
  canvas_id: string;
  name: string;
  sort_order: number | null;
  canvas: CanvasEntry;
}

function buildCanvasDoc(rows: PolicyCanvasRow[]): CanvasDoc | null {
  if (rows.length === 0) {
    return null;
  }

  const canvases = [...rows]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((row) => ({
      ...row.canvas,
      id: row.canvas_id || row.canvas.id,
      name: row.name || row.canvas.name,
    }));

  return {
    version: 2,
    activeId: canvases[0].id,
    canvases,
  };
}

function buildCanvasRows(setupTable: string, setupId: string, policyCanvases: CanvasDoc | null) {
  return (policyCanvases?.canvases ?? []).map((canvas, index) => ({
    setup_table: setupTable,
    setup_id: setupId,
    canvas_id: canvas.id,
    name: canvas.name,
    sort_order: index,
    canvas,
  }));
}

const FIELD_TYPES: FieldType[] = ["string", "integer", "boolean", "string[]", "number", "json"];
const SLEEP_FILES_BUCKET = "sleep-input-files";
const SLEEP_SETUP_TABLE = "sleep_inputs";
const SLEEP_DEFAULT_FIELDS: Array<Omit<StateField, "id">> = [
  { name: "summary", type: "string", initialValue: "" },
  { name: "new_events", type: "json", initialValue: "[]" },
  { name: "age", type: "integer", initialValue: "null" },
  { name: "gender", type: "string", initialValue: "null" },
  { name: "emergency", type: "boolean", initialValue: "false" },
];
const SLEEP_PLAYER_COPY = {
  domainDescription:
    "Collect the materials the model should draw from, including guidelines, uploaded files, and structured datasets.",
  stateDescription:
    "Define the fields tracked across the conversation, then tell the model how to populate them from each user message.",
  stateSchemaDescription:
    "The most important concise pieces of user information to track across the conversation. Each field maps to a slot in the structured state block.",
  stateUpdateSublabel:
    "Instruct the model how to read each user message and update the fields in the conversation state schema.",
  stateUpdatePlaceholder:
    "e.g. Read the user message and update the state fields. If the user mentions their age, set age to the integer value. If they describe an emergency situation, set emergency to true…",
  guidelineTopicPlaceholder: "Topic {n}",
  guidelineContentPlaceholder: "Paste or type guideline content…",
  guidelineProblemPlaceholder: "Describe the problem or pattern this block addresses…",
  guidelineRecommendationPlaceholder:
    "What the assistant should recommend when this problem applies…",
  datasetPlaceholder:
    "Define typed columns and records for the dataset…",
} as const;

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function ensureConversationMemoryFields(fields: StateField[]): StateField[] {
  const nextFields = fields.filter(
    (field) => field.name.trim().toLowerCase() !== "new_conversations"
  );
  const normalizedNames = new Set(nextFields.map((field) => field.name.trim().toLowerCase()));

  if (!normalizedNames.has("summary")) {
    nextFields.unshift({ id: uid(), name: "summary", type: "string", initialValue: "" });
  }

  if (!normalizedNames.has("new_events")) {
    const summaryIndex = nextFields.findIndex((field) => field.name.trim().toLowerCase() === "summary");
    nextFields.splice(summaryIndex >= 0 ? summaryIndex + 1 : 0, 0, {
      id: uid(),
      name: "new_events",
      type: "json",
      initialValue: "[]",
    });
  }

  return nextFields;
}

function createGuidelineBlock(): GuidelineBlock {
  return { id: uid(), topic: "", content: "", problem: "", recommendation: "" };
}

function createFieldsFromTemplates(
  templates: Array<Omit<StateField, "id">> = SLEEP_DEFAULT_FIELDS
): StateField[] {
  return ensureConversationMemoryFields(
    templates.map((field) => ({ id: uid(), ...field }))
  );
}

function createEnvironmentPlayer(): SimulationPlayerConfig {
  return {
    id: uid(),
    fields: createFieldsFromTemplates(),
    stateUpdatePrompt: "",
    policyPrompt: "",
    policyCanvases: null,
    statePolicyCanvases: null,
    guidelines: [],
    datasets: [],
    uploadedFiles: [],
  };
}

function normalizeEnvironmentPlayers(raw: unknown): SimulationPlayerConfig[] {
  let players: unknown[] = [];
  if (Array.isArray(raw)) players = raw;
  else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      players = Array.isArray(parsed) ? parsed : [];
    } catch {
      players = [];
    }
  }

  return players.map((entry) => {
    const player = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const rawStateSchema = Array.isArray(player.state_schema) ? player.state_schema : [];
    const fields = rawStateSchema
      .map((field) => {
        if (!field || typeof field !== "object") return null;
        const rawField = field as Record<string, unknown>;
        const name = typeof rawField.field_name === "string" ? rawField.field_name : "";
        const type = typeof rawField.type === "string" && FIELD_TYPES.includes(rawField.type as FieldType)
          ? (rawField.type as FieldType)
          : "string";
        const initialValue =
          rawField.initial_value === null ? "null" : String(rawField.initial_value ?? "");
        if (!name.trim()) return null;
        return { id: uid(), name, type, initialValue };
      })
      .filter((field): field is StateField => field !== null);

    const guidelines = normalizeGuidelineBlocks(player.guideline_blocks).map((guideline) => ({
      id: uid(),
      topic: guideline.topic,
      content: guideline.content,
      problem: guideline.problem,
      recommendation: guideline.recommendation,
    }));
    const datasets = normalizeDatasets(player.datasets, uid);

    const rawFiles = Array.isArray(player.uploaded_files) ? player.uploaded_files : [];
    const uploadedFiles: UploadedFile[] = [];
    for (const file of rawFiles) {
      if (!file || typeof file !== "object") continue;
      const rawFile = file as Record<string, unknown>;
      uploadedFiles.push({
          id: typeof rawFile.id === "string" ? rawFile.id : uid(),
          name: typeof rawFile.name === "string" ? rawFile.name : "",
          size: typeof rawFile.size === "number" ? rawFile.size : 0,
          type: typeof rawFile.type === "string" ? rawFile.type : "",
          bucket: typeof rawFile.bucket === "string" ? rawFile.bucket : undefined,
          path: typeof rawFile.path === "string" ? rawFile.path : undefined,
          url: typeof rawFile.url === "string" ? rawFile.url : undefined,
          isObjectUrl: typeof rawFile.isObjectUrl === "boolean" ? rawFile.isObjectUrl : undefined,
          uploaded_by_email:
            typeof rawFile.uploaded_by_email === "string" ? rawFile.uploaded_by_email : undefined,
          uploaded_by_uuid:
            typeof rawFile.uploaded_by_uuid === "string" ? rawFile.uploaded_by_uuid : undefined,
          uploaded_at: typeof rawFile.uploaded_at === "string" ? rawFile.uploaded_at : undefined,
      });
    }

    return {
      id: typeof player.id === "string" ? player.id : uid(),
      fields:
        fields.length > 0 ? ensureConversationMemoryFields(fields) : createFieldsFromTemplates(),
      stateUpdatePrompt:
        typeof player.state_update_prompt === "string" ? player.state_update_prompt : "",
      policyPrompt: typeof player.policy_prompt === "string" ? player.policy_prompt : "",
      policyCanvases:
        player.policy_canvases && typeof player.policy_canvases === "object"
          ? (player.policy_canvases as CanvasDoc)
          : null,
      statePolicyCanvases:
        player.state_policy_canvases && typeof player.state_policy_canvases === "object"
          ? (player.state_policy_canvases as CanvasDoc)
          : null,
      guidelines,
      datasets,
      uploadedFiles,
    };
  });
}

function serializeEnvironmentPlayers(players: SimulationPlayerConfig[]) {
  return players.map((player) => ({
    id: player.id,
    state_schema: player.fields.map((field) => ({
      field_name: field.name.trim(),
      type: field.type,
      initial_value: field.initialValue.trim(),
    })),
    state_update_prompt: player.stateUpdatePrompt,
    policy_prompt: player.policyPrompt,
    guideline_blocks: serializeGuidelineBlocks(player.guidelines),
    datasets: serializeDatasets(player.datasets),
    uploaded_files: player.uploadedFiles.map((file) => ({
      id: file.id,
      name: file.name,
      size: file.size,
      type: file.type,
      bucket: file.bucket,
      path: file.path,
      uploaded_by_email: file.uploaded_by_email,
      uploaded_by_uuid: file.uploaded_by_uuid,
      uploaded_at: file.uploaded_at,
    })),
    policy_canvases: player.policyCanvases,
    state_policy_canvases: player.statePolicyCanvases,
  }));
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUploadedBy(file: UploadedFile): string | null {
  const parts: string[] = [];
  if (file.uploaded_by_email) parts.push(file.uploaded_by_email);
  if (file.uploaded_at) {
    const d = new Date(file.uploaded_at);
    if (!Number.isNaN(d.getTime())) parts.push(d.toLocaleString());
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionLabel({ number, title, description }: { number: string; title: string; description?: string }) {
  return (
    <div className="mb-5">
      <div className="flex items-baseline gap-3">
        <span className="text-xs font-mono text-gray-400">{number}</span>
        <h2 className="text-lg font-bold font-test-american-grotesk text-black">{title}</h2>
      </div>
      {description && (
        <p className="text-xs font-serif text-gray-500 mt-1 ml-6 leading-relaxed">{description}</p>
      )}
    </div>
  );
}

function AccordionSection({
  number,
  title,
  description,
  isOpen,
  onToggle,
  children,
}: {
  number: string;
  title: string;
  description?: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-[#c8c4b4] rounded-lg bg-[#dddacb]">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-start justify-between gap-4 px-5 py-4 text-left"
      >
        <SectionLabel number={number} title={title} description={description} />
        <span className="text-sm font-mono text-gray-500 mt-1">{isOpen ? "−" : "+"}</span>
      </button>
      {isOpen && <div className="px-5 pb-5">{children}</div>}
    </section>
  );
}

function FieldRow({
  field,
  onChange,
  onDelete,
}: {
  field: StateField;
  onChange: (id: string, key: keyof StateField, value: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <tr className="border-b border-[#c8c4b4] group">
      <td className="py-2 pr-3">
        <input
          type="text"
          value={field.name}
          placeholder="field_name"
          onChange={(e) => onChange(field.id, "name", e.target.value)}
          className="w-full bg-transparent font-mono text-sm text-gray-800 placeholder-gray-400 focus:outline-none border-b border-transparent focus:border-gray-400 pb-0.5"
        />
      </td>
      <td className="py-2 pr-3">
        <select
          value={field.type}
          onChange={(e) => onChange(field.id, "type", e.target.value)}
          className="bg-[#d6d3c4] text-sm font-mono text-gray-700 rounded px-2 py-1 border border-[#c8c4b4] focus:outline-none focus:border-gray-500 cursor-pointer"
        >
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </td>
      <td className="py-2 pr-3">
        <input
          type="text"
          value={field.initialValue}
          placeholder="null"
          onChange={(e) => onChange(field.id, "initialValue", e.target.value)}
          className="w-full bg-transparent font-mono text-sm text-gray-800 placeholder-gray-400 focus:outline-none border-b border-transparent focus:border-gray-400 pb-0.5"
        />
      </td>
      <td className="py-2 text-right">
        <button
          type="button"
          onClick={() => onDelete(field.id)}
          className="text-gray-400 hover:text-gray-700 transition-colors opacity-0 group-hover:opacity-100 text-lg leading-none"
          aria-label="Delete field"
        >
          ×
        </button>
      </td>
    </tr>
  );
}

function TextArea({
  label,
  sublabel,
  value,
  onChange,
  rows = 6,
  placeholder,
}: {
  label: string;
  sublabel?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-widest text-gray-500 font-sans mb-1">{label}</label>
      {sublabel && <p className="text-xs font-serif text-gray-400 mb-2 leading-relaxed">{sublabel}</p>}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full bg-[#d6d3c4] border border-[#c8c4b4] rounded px-4 py-3 text-sm font-serif text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-500 resize-y leading-relaxed"
      />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SleepInputPage() {
  // Section 2 – state schema
  const [fields, setFields] = useState<StateField[]>([
    { id: uid(), name: "age", type: "integer", initialValue: "null" },
    { id: uid(), name: "gender", type: "string", initialValue: "null" },
    { id: uid(), name: "emergency", type: "boolean", initialValue: "false" },
  ]);

  // Section 3 – prompts
  const [stateUpdatePrompt, setStateUpdatePrompt] = useState("");
  const [policyPrompt, setPolicyPrompt] = useState("");
  const [policyCanvases, setPolicyCanvases] = useState<CanvasDoc | null>(null);
  const [statePolicyCanvases, setStatePolicyCanvases] = useState<CanvasDoc | null>(null);
  const stateCanvasCompiler = useMemo(() => createStateExtractionCompiler(fields), [fields]);

  // Section 4 – guidelines
  const [guidelines, setGuidelines] = useState<GuidelineBlock[]>([]);
  const [datasets, setDatasets] = useState<SimulationPlayerConfig["datasets"]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [environmentPlayers, setEnvironmentPlayers] = useState<SimulationPlayerConfig[]>([]);
  const [sleepConfigId, setSleepConfigId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const dirtyArmedRef = useRef(false);
  const [openAccordions, setOpenAccordions] = useState<string[]>([]);

  function toggleAccordion(id: string) {
    setOpenAccordions((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }

  async function fetchSleepConfig() {
    const res = await fetch("/api/admin/setup/sleep");
    if (!res.ok) return;
    const {
      config,
      policyCanvases: rows,
      statePolicyCanvases: spcRows,
    } = (await res.json()) as {
      config: SleepInputRow | null;
      policyCanvases: PolicyCanvasRow[];
      statePolicyCanvases?: PolicyCanvasRow[];
    };
    if (!config) return;

    setSleepConfigId(config.id);
    setStatePolicyCanvases(buildCanvasDoc(spcRows ?? []));

    const restoredFields = (config.state_schema ?? []).map((f) => ({
      id: uid(),
      name: f.field_name ?? "",
      type: FIELD_TYPES.includes((f.type ?? "string") as FieldType) ? (f.type as FieldType) : "string",
      initialValue: f.initial_value === null ? "null" : String(f.initial_value ?? ""),
    }));
    setFields(
      restoredFields.length > 0
        ? ensureConversationMemoryFields(restoredFields)
        : createFieldsFromTemplates()
    );
    setStateUpdatePrompt(config.state_update_prompt ?? "");
    setPolicyPrompt(config.policy_prompt ?? "");
    setPolicyCanvases(buildCanvasDoc(rows ?? []));

    const restoredGuidelines = normalizeGuidelineBlocks(config.guideline_blocks).map((g) => ({
      id: uid(),
      topic: g.topic,
      content: g.content,
      problem: g.problem,
      recommendation: g.recommendation,
    }));
    setGuidelines(restoredGuidelines);
    setDatasets(normalizeDatasets(config.datasets, uid));

    setUploadedFiles((config.uploaded_files ?? []).map((f) => ({ ...f, id: f.id ?? uid() })));
    setEnvironmentPlayers(normalizeEnvironmentPlayers(config.environment_players));
    setIsDirty(false);
    setTimeout(() => { dirtyArmedRef.current = true; }, 0);
  }

  useEffect(() => {
    void fetchSleepConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!dirtyArmedRef.current) return;
    setIsDirty(true);
  }, [
    fields,
    stateUpdatePrompt,
    policyPrompt,
    policyCanvases,
    statePolicyCanvases,
    guidelines,
    datasets,
    uploadedFiles,
    environmentPlayers,
  ]);

  useEffect(() => {
    return () => {
      uploadedFiles.forEach((file) => {
        if (file.isObjectUrl && file.url) {
          URL.revokeObjectURL(file.url);
        }
      });
    };
  }, [uploadedFiles]);

  function buildPrimaryPlayerConfig(): SimulationPlayerConfig {
    return {
      id: "assistant",
      fields,
      stateUpdatePrompt,
      policyPrompt,
      policyCanvases,
      statePolicyCanvases,
      guidelines,
      datasets,
      uploadedFiles,
    };
  }

  function applyPrimaryPlayerConfig(next: SimulationPlayerConfig) {
    setFields(next.fields);
    setStateUpdatePrompt(next.stateUpdatePrompt);
    setPolicyPrompt(next.policyPrompt);
    setPolicyCanvases(next.policyCanvases);
    setStatePolicyCanvases(next.statePolicyCanvases);
    setGuidelines(next.guidelines);
    setDatasets(next.datasets);
    setUploadedFiles(next.uploadedFiles);
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  function updateField(id: string, key: keyof StateField, value: string) {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, [key]: value } : f)));
  }

  function deleteField(id: string) {
    setFields((prev) => prev.filter((f) => f.id !== id));
  }

  function addField() {
    setFields((prev) => [...prev, { id: uid(), name: "", type: "string", initialValue: "null" }]);
  }

  function updateGuideline(id: string, key: keyof GuidelineBlock, value: string) {
    setGuidelines((prev) => prev.map((g) => (g.id === id ? { ...g, [key]: value } : g)));
  }

  function deleteGuideline(id: string) {
    setGuidelines((prev) => prev.filter((g) => g.id !== id));
  }

  function addGuideline() {
    setGuidelines((prev) => [
      ...prev,
      createGuidelineBlock(),
    ]);
  }

  function updateDatasetName(id: string, value: string) {
    setDatasets((prev) =>
      prev.map((dataset) => (dataset.id === id ? { ...dataset, name: value } : dataset))
    );
  }

  function updateDatasetNotes(id: string, value: string) {
    setDatasets((prev) =>
      prev.map((dataset) => (dataset.id === id ? { ...dataset, notes: value } : dataset))
    );
  }

  function updateDatasetColumnCount(id: string, count: number) {
    setDatasets((prev) =>
      prev.map((dataset) =>
        dataset.id === id ? resizeDatasetColumns(dataset, count, uid) : dataset
      )
    );
  }

  function updateDatasetColumn(
    datasetId: string,
    columnId: string,
    key: keyof SimulationPlayerDatasetColumn,
    value: string
  ) {
    setDatasets((prev) =>
      prev.map((dataset) =>
        dataset.id !== datasetId
          ? dataset
          : {
              ...dataset,
              columns: dataset.columns.map((column) =>
                column.id === columnId
                  ? {
                      ...column,
                      [key]: key === "type" ? (value as SimulationPlayerDatasetColumn["type"]) : value,
                    }
                  : column
              ),
            }
      )
    );
  }

  function addDatasetRecord(datasetId: string) {
    setDatasets((prev) =>
      prev.map((dataset) =>
        dataset.id !== datasetId
          ? dataset
          : {
              ...dataset,
              records: [...dataset.records, createEmptyDatasetRecord(dataset.columns, uid)],
            }
      )
    );
  }

  function updateDatasetRecordValue(
    datasetId: string,
    recordId: string,
    columnId: string,
    value: string
  ) {
    setDatasets((prev) =>
      prev.map((dataset) =>
        dataset.id !== datasetId
          ? dataset
          : {
              ...dataset,
              records: dataset.records.map((record) =>
                record.id !== recordId
                  ? record
                  : {
                      ...record,
                      values: {
                        ...record.values,
                        [columnId]: value,
                      },
                    }
              ),
            }
      )
    );
  }

  function deleteDatasetRecord(datasetId: string, recordId: string) {
    setDatasets((prev) =>
      prev.map((dataset) =>
        dataset.id !== datasetId
          ? dataset
          : {
              ...dataset,
              records: dataset.records.filter((record) => record.id !== recordId),
            }
      )
    );
  }

  function deleteDataset(id: string) {
    setDatasets((prev) => prev.filter((dataset) => dataset.id !== id));
  }

  function addDataset() {
    setDatasets((prev) => [...prev, createEmptyDataset(uid, prev.length)]);
  }

  function updateEnvironmentPlayer(playerId: string, next: SimulationPlayerConfig) {
    setEnvironmentPlayers((prev) => prev.map((player) => (player.id === playerId ? next : player)));
  }

  function addEnvironmentPlayer() {
    setEnvironmentPlayers((prev) => [...prev, createEnvironmentPlayer()]);
  }

  function deleteEnvironmentPlayer(playerId: string) {
    setEnvironmentPlayers((prev) => prev.filter((player) => player.id !== playerId));
  }

  async function uploadFiles(fileList: FileList | null): Promise<UploadedFile[]> {
    if (!fileList) return [];
    const allowed = ["application/pdf", "text/plain", "text/markdown", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
    const acceptedFiles = Array.from(fileList).filter(
      (f) => allowed.includes(f.type) || f.name.endsWith(".md") || f.name.endsWith(".txt")
    );
    if (acceptedFiles.length === 0) return [] as UploadedFile[];

    setIsUploadingFiles(true);

    const supabase = createSupabaseBrowserClient();
    const uploaded: UploadedFile[] = [];
    for (const file of acceptedFiles) {
      const signRes = await fetch("/api/admin/setup/sleep/files/sign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, fileSize: file.size, fileType: file.type }),
      });
      if (!signRes.ok) {
        setIsUploadingFiles(false);
        return [] as UploadedFile[];
      }
      const { path, token, bucket, file: meta } = (await signRes.json()) as {
        path: string;
        token: string;
        bucket: string;
        file: {
          name: string;
          size: number;
          type: string;
          bucket: string;
          path: string;
          uploaded_by_email?: string | null;
          uploaded_by_uuid?: string;
          uploaded_at?: string;
        };
      };
      const { error: uploadErr } = await supabase.storage
        .from(bucket)
        .uploadToSignedUrl(path, token, file, { contentType: file.type || undefined });
      if (uploadErr) {
        setIsUploadingFiles(false);
        return [] as UploadedFile[];
      }
      uploaded.push({ id: uid(), ...meta });
    }

    setIsUploadingFiles(false);
    return uploaded;
  }

  async function handleFiles(fileList: FileList | null) {
    const uploaded = await uploadFiles(fileList);
    if (uploaded.length === 0) {
      return;
    }

    const nextFiles = [...uploadedFiles, ...uploaded];
    setUploadedFiles(nextFiles);
    await saveSleepConfiguration(nextFiles);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    void handleFiles(e.dataTransfer.files);
  }

  async function removeFile(id: string) {
    const fileToRemove = uploadedFiles.find((f) => f.id === id);
    if (!fileToRemove) return;
    const nextFiles = uploadedFiles.filter((f) => f.id !== id);

    if (fileToRemove.isObjectUrl && fileToRemove.url) {
      URL.revokeObjectURL(fileToRemove.url);
    }

    setUploadedFiles(nextFiles);

    if (fileToRemove.path) {
      await fetch("/api/admin/setup/sleep/files", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: fileToRemove.path, bucket: fileToRemove.bucket }),
      });
    }

    const saved = await saveSleepConfiguration(nextFiles);
    if (!saved) {
      return;
    }
  }

  async function addEnvironmentPlayerFiles(playerId: string, fileList: FileList | null) {
    const uploaded = await uploadFiles(fileList);
    if (uploaded.length === 0) {
      return;
    }

    const nextPlayers = environmentPlayers.map((player) =>
      player.id === playerId
        ? { ...player, uploadedFiles: [...player.uploadedFiles, ...uploaded] }
        : player
    );
    setEnvironmentPlayers(nextPlayers);
    await saveSleepConfiguration(undefined, nextPlayers);
  }

  async function removeEnvironmentPlayerFile(playerId: string, fileId: string) {
    const player = environmentPlayers.find((entry) => entry.id === playerId);
    const fileToRemove = player?.uploadedFiles.find((file) => file.id === fileId);
    if (!player || !fileToRemove) return;

    const nextPlayers = environmentPlayers.map((entry) =>
      entry.id === playerId
        ? { ...entry, uploadedFiles: entry.uploadedFiles.filter((file) => file.id !== fileId) }
        : entry
    );
    setEnvironmentPlayers(nextPlayers);

    if (fileToRemove.isObjectUrl && fileToRemove.url) {
      URL.revokeObjectURL(fileToRemove.url);
    }

    if (fileToRemove.path) {
      await fetch("/api/admin/setup/sleep/files", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: fileToRemove.path, bucket: fileToRemove.bucket }),
      });
    }

    await saveSleepConfiguration(undefined, nextPlayers);
  }

  async function openUploadedFile(file: UploadedFile) {
    const newTab = window.open("", "_blank");
    if (!newTab) {
      return;
    }

    const target = file.url || (file.path?.startsWith("http://") || file.path?.startsWith("https://") ? file.path : "");
    if (target) {
      newTab.location.href = target;
      newTab.opener = null;
      return;
    }

    if (!file.path) {
      newTab.close();
      return;
    }

    const res = await fetch("/api/admin/setup/sleep/files/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: file.path, bucket: file.bucket }),
    });
    if (!res.ok) {
      newTab.close();
      return;
    }
    const { signedUrl } = (await res.json()) as { signedUrl?: string };
    if (!signedUrl) {
      newTab.close();
      return;
    }

    newTab.location.href = signedUrl;
    newTab.opener = null;
  }

  async function saveSleepConfiguration(
    filesOverride?: UploadedFile[],
    environmentPlayersOverride?: SimulationPlayerConfig[]
  ) {
    const filesToSave = filesOverride ?? uploadedFiles;
    const environmentPlayersToSave = environmentPlayersOverride ?? environmentPlayers;

    const config = {
      config_name: "sleep configuration",
      state_schema: fields.map((f) => ({
        field_name: f.name.trim(),
        type: f.type,
        initial_value: f.initialValue.trim(),
      })),
      state_update_prompt: stateUpdatePrompt,
      policy_prompt: policyPrompt,
      guideline_blocks: serializeGuidelineBlocks(guidelines),
      datasets: serializeDatasets(datasets),
      uploaded_files: filesToSave.map((file) => ({
        id: file.id,
        name: file.name,
        size: file.size,
        type: file.type,
        bucket: file.bucket,
        path: file.path,
        uploaded_by_email: file.uploaded_by_email,
        uploaded_by_uuid: file.uploaded_by_uuid,
        uploaded_at: file.uploaded_at,
      })),
      environment_players: serializeEnvironmentPlayers(environmentPlayersToSave),
    };

    const policyCanvasRows = buildCanvasRows(
      SLEEP_SETUP_TABLE,
      sleepConfigId ?? "",
      policyCanvases
    ).map((row) => ({
      canvas_id: row.canvas_id,
      name: row.name,
      sort_order: row.sort_order,
      canvas: row.canvas,
    }));

    const statePolicyCanvasRows = buildCanvasRows(
      SLEEP_SETUP_TABLE,
      sleepConfigId ?? "",
      statePolicyCanvases
    ).map((row) => ({
      canvas_id: row.canvas_id,
      name: row.name,
      sort_order: row.sort_order,
      canvas: row.canvas,
    }));

    const res = await fetch("/api/admin/setup/sleep", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config,
        policyCanvases: policyCanvasRows,
        statePolicyCanvases: statePolicyCanvasRows,
      }),
    });
    if (!res.ok) return false;
    const { id } = (await res.json()) as { id: string };
    setSleepConfigId(id);
    return true;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSaving(true);
    await saveSleepConfiguration();
    setIsSaving(false);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  async function triggerSave() {
    setIsSaving(true);
    const ok = await saveSleepConfiguration();
    setIsSaving(false);
    if (ok) setIsDirty(false);
  }

  return (
    <div className="h-screen overflow-y-auto bg-[#E1DECF]">
      <SiteNavbar activePage="demos" />

      {/* Floating Save — only when there are unsaved changes */}
      {(isDirty || isSaving) && (
        <button
          type="button"
          onClick={triggerSave}
          disabled={isSaving}
          className="fixed bottom-6 right-6 z-50 bg-gray-900 text-[#E1DECF] text-sm font-sans uppercase tracking-widest px-5 py-3 rounded shadow-lg hover:bg-gray-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
      )}

      <div className="w-full px-4 sm:px-6 lg:px-8 py-12">
        <div className="max-w-7xl mx-auto">

        {/* Page header */}
        <div className="mb-12 border-b border-[#c8c4b4] pb-8 flex items-end justify-between">
          <div>
            <p className="text-xs font-sans tracking-widest uppercase text-gray-400 mb-2">Expert Setup</p>
            <h1 className="text-3xl font-bold font-test-american-grotesk text-black mb-3">
              Sleep — System Configuration
            </h1>
            <p className="text-sm font-serif text-gray-500 leading-relaxed max-w-xl">
              Define the datasets, state logic, and policy that will drive the sleep
              assistant, and optionally add environment agents for simulation work.
            </p>
            <Link
              href="/demo/nutrition/input"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-4 text-xs font-sans uppercase tracking-widest text-gray-600 hover:text-gray-900 underline"
            >
              Setup example
            </Link>
          </div>
          <div className="flex items-center gap-4 pb-1">
            <Link href="/demo" className="text-xs text-gray-500 underline hover:text-gray-700">
              Home
            </Link>
            <Link href="/demo/sleep" className="text-xs text-gray-500 underline hover:text-gray-700">
              Chat
            </Link>
            <Link href="/demo/sleep/expert-dashboard" className="text-xs text-gray-500 underline hover:text-gray-700">
              Records
            </Link>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <section className="border border-[#c8c4b4] rounded-xl bg-[#e7e4d8] p-5 space-y-5">
            <div>
              <p className="text-xs font-sans tracking-widest uppercase text-gray-400 mb-2">Assistant</p>
              <h2 className="text-2xl font-bold font-test-american-grotesk text-black">
                Primary Agent
              </h2>
            </div>

            <AccordionSection
              number="1"
              title="Domain Knowledge"
              description="Provide reference material the model will consult when generating responses."
              isOpen={openAccordions.includes("1")}
              onToggle={() => toggleAccordion("1")}
            >
            {/* Guideline blocks */}
            <p className="text-xs uppercase tracking-widest text-gray-400 font-sans mb-3">Guideline blocks</p>
            <div className="space-y-4 mb-4">
              {guidelines.map((g, i) => (
                <div key={g.id} className="bg-[#d6d3c4] border border-[#c8c4b4] rounded p-4">
                  <div className="flex items-center justify-between mb-3">
                    <input
                      type="text"
                      value={g.topic}
                      onChange={(e) => updateGuideline(g.id, "topic", e.target.value)}
                      placeholder={`Topic ${i + 1}`}
                      className="bg-transparent font-bold font-test-american-grotesk text-sm text-gray-900 placeholder-gray-400 focus:outline-none border-b border-transparent focus:border-gray-500 pb-0.5 flex-1 mr-4"
                    />
                    <button
                      type="button"
                      onClick={() => deleteGuideline(g.id)}
                      className="text-gray-400 hover:text-gray-700 transition-colors text-lg leading-none shrink-0"
                      aria-label="Delete guideline block"
                    >
                      ×
                    </button>
                  </div>
                  <textarea
                    value={g.content}
                    onChange={(e) => updateGuideline(g.id, "content", e.target.value)}
                    rows={5}
                    placeholder="Paste or type guideline content…"
                    className="w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-3 py-2 text-sm font-serif text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-500 resize-y leading-relaxed"
                  />

                  <div className="mt-3">
                    <label className="block text-xs uppercase tracking-widest text-gray-500 font-sans mb-1">
                      Problem description
                    </label>
                    <textarea
                      value={g.problem}
                      onChange={(e) => updateGuideline(g.id, "problem", e.target.value)}
                      rows={3}
                      placeholder="Describe the problem or pattern this block addresses…"
                      className="w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-3 py-2 text-sm font-serif text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-500 resize-y leading-relaxed"
                    />
                  </div>

                  <div className="mt-3">
                    <label className="block text-xs uppercase tracking-widest text-gray-500 font-sans mb-1">
                      Recommendation
                    </label>
                    <textarea
                      value={g.recommendation}
                      onChange={(e) => updateGuideline(g.id, "recommendation", e.target.value)}
                      rows={3}
                      placeholder="What the assistant should recommend when this problem applies…"
                      className="w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-3 py-2 text-sm font-serif text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-500 resize-y leading-relaxed"
                    />
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addGuideline}
              className="text-xs font-sans uppercase tracking-widest text-gray-500 hover:text-gray-800 transition-colors border border-[#c8c4b4] hover:border-gray-500 rounded px-4 py-2 mb-8"
            >
              {guidelines.length === 0 ? "+ Create guidelines" : "+ Add guideline block"}
            </button>

            {/* File upload */}
            <p className="text-xs uppercase tracking-widest text-gray-400 font-sans mb-3 mt-2">File upload</p>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg px-6 py-10 text-center cursor-pointer transition-colors ${
                dragOver
                  ? "border-gray-500 bg-[#cbc8b8]"
                  : "border-[#c8c4b4] hover:border-gray-500 hover:bg-[#d0cdc0]"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.txt,.md,.docx"
                className="hidden"
                onChange={(e) => void handleFiles(e.target.files)}
              />
              <p className="text-sm font-serif text-gray-500">
                {isUploadingFiles ? "Uploading..." : <>Drop files here or <span className="underline">browse</span></>}
              </p>
              <p className="text-xs font-mono text-gray-400 mt-1">PDF · TXT · MD · DOCX</p>
            </div>

            {uploadedFiles.length > 0 && (
              <ul className="mt-3 space-y-2">
                {uploadedFiles.map((f) => (
                  <li
                    key={f.id}
                    className="flex items-center justify-between bg-[#d6d3c4] border border-[#c8c4b4] rounded px-4 py-2"
                  >
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => void openUploadedFile(f)}
                        className="text-sm font-serif text-gray-800 truncate underline hover:text-gray-900 text-left"
                      >
                        {f.name}
                      </button>
                      <p className="text-xs font-mono text-gray-400">{formatBytes(f.size)}</p>
                      {formatUploadedBy(f) && (
                        <p className="text-xs font-mono text-gray-400">{formatUploadedBy(f)}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeFile(f.id);
                      }}
                      className="text-gray-400 hover:text-gray-700 transition-colors text-lg leading-none ml-4 shrink-0"
                      aria-label="Remove file"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-8">
              <p className="text-xs uppercase tracking-widest text-gray-400 font-sans mb-3">
                Datasets
              </p>
              <div className="space-y-4 mb-4">
                {datasets.map((dataset) => (
                  <DatasetRow
                    key={dataset.id}
                    dataset={dataset}
                    onChangeName={updateDatasetName}
                    onChangeNotes={updateDatasetNotes}
                    onChangeColumnCount={updateDatasetColumnCount}
                    onChangeColumn={updateDatasetColumn}
                    onAddRecord={addDatasetRecord}
                    onChangeRecordValue={updateDatasetRecordValue}
                    onDeleteRecord={deleteDatasetRecord}
                    onDelete={deleteDataset}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={addDataset}
                className="text-xs font-sans uppercase tracking-widest text-gray-500 hover:text-gray-800 transition-colors border border-[#c8c4b4] hover:border-gray-500 rounded px-4 py-2"
              >
                + Add dataset
              </button>
            </div>
            </AccordionSection>

            <AccordionSection
              number="2"
              title="State"
              description="Define the fields tracked across the conversation, then tell the model how to populate them from each user message."
              isOpen={openAccordions.includes("2")}
              onToggle={() => toggleAccordion("2")}
            >
            <div className="mb-8">
              <p className="text-xs uppercase tracking-widest text-gray-500 font-sans mb-2">
                State schema
              </p>
              <p className="text-xs font-serif text-gray-400 mb-3 leading-relaxed">
                The most important concise pieces of user information to track across the
                conversation. Each field maps to a slot in the structured state block.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-[#c8c4b4]">
                      <th className="text-xs uppercase tracking-widest text-gray-400 font-sans pb-2 pr-3 font-normal">Field name</th>
                      <th className="text-xs uppercase tracking-widest text-gray-400 font-sans pb-2 pr-3 font-normal">Type</th>
                      <th className="text-xs uppercase tracking-widest text-gray-400 font-sans pb-2 pr-3 font-normal">Initial value</th>
                      <th className="pb-2 w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map((field) => (
                      <FieldRow
                        key={field.id}
                        field={field}
                        onChange={updateField}
                        onDelete={deleteField}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                type="button"
                onClick={addField}
                className="mt-4 text-xs font-sans uppercase tracking-widest text-gray-500 hover:text-gray-800 transition-colors border border-[#c8c4b4] hover:border-gray-500 rounded px-4 py-2"
              >
                + Add field
              </button>
            </div>

            <TextArea
              label="State update prompt"
              sublabel="Instruct the model how to read each user message and update the fields in the conversation state schema."
              value={stateUpdatePrompt}
              onChange={setStateUpdatePrompt}
              rows={7}
              placeholder="e.g. Read the user message and update the state fields. If the user mentions their age, set age to the integer value. If they describe an emergency situation, set emergency to true…"
            />

            <div className="mt-10">
              <Canvas
                header={{
                  title: "State extraction",
                  subtitle: "compiles to extraction prompt",
                }}
                defaultOpen={false}
                value={statePolicyCanvases}
                compile={stateCanvasCompiler}
                inspectorContext={{
                  datasetNames: buildInspectorDatasetNames(datasets, guidelines),
                  executionPhase: "state",
                  runtimeProfile: "default",
                  datasetsContext: buildInspectorDatasetsContext(
                    datasets,
                    guidelines
                  ),
                  stateSchema: fields.map((field) => ({
                    fieldName: field.name,
                    type: field.type,
                    initialValue: field.initialValue,
                  })),
                  stateUpdateSystemPrompt: stateUpdatePrompt,
                  policyExecutionSystemPrompt: policyPrompt,
                }}
                onChange={({ doc, text }) => {
                  setStatePolicyCanvases(doc);
                  setStateUpdatePrompt(text);
                }}
              />
            </div>
            </AccordionSection>

            <AccordionSection
              number="3"
              title="Policy"
              description="The prompt composition canvas defines the prompt the model sees and compiles to a string."
              isOpen={openAccordions.includes("3")}
              onToggle={() => toggleAccordion("3")}
            >
            <div className="mt-10">
              <Canvas
                header={{
                  title: "Prompt composition",
                  subtitle: "compiles to prompt",
                }}
                value={policyCanvases}
                legacyMarkdown={policyPrompt}
                nodeKinds={DEFAULT_POLICY_NODE_KINDS}
                inspectorContext={{
                  datasetNames: buildInspectorDatasetNames(datasets, guidelines),
                  executionPhase: "policy",
                  runtimeProfile: "default",
                  datasetsContext: buildInspectorDatasetsContext(
                    datasets,
                    guidelines
                  ),
                  stateSchema: fields.map((field) => ({
                    fieldName: field.name,
                    type: field.type,
                    initialValue: field.initialValue,
                  })),
                  stateUpdateSystemPrompt: stateUpdatePrompt,
                  policyExecutionSystemPrompt: policyPrompt,
                }}
                onChange={({ doc, text }) => {
                  setPolicyCanvases(doc);
                  setPolicyPrompt(text);
                }}
              />
            </div>
            </AccordionSection>
          </section>

          <button
            type="button"
            onClick={addEnvironmentPlayer}
            className="text-xs font-sans uppercase tracking-widest text-gray-500 hover:text-gray-800 transition-colors border border-[#c8c4b4] hover:border-gray-500 rounded px-4 py-2"
          >
            + Create Environment Agent
          </button>

          {environmentPlayers.map((player, index) => (
            <SimulationPlayerEditor
              key={player.id}
              title={`Environment Agent ${index + 1}`}
              badge="Simulation Environment"
              copy={SLEEP_PLAYER_COPY}
              config={player}
              fieldTypes={FIELD_TYPES}
              isUploadingFiles={isUploadingFiles}
              onChange={(next) => updateEnvironmentPlayer(player.id, next)}
              onAddFiles={async (files) => addEnvironmentPlayerFiles(player.id, files)}
              onOpenFile={openUploadedFile}
              onRemoveFile={async (fileId) => removeEnvironmentPlayerFile(player.id, fileId)}
              onDeleteGroup={() => deleteEnvironmentPlayer(player.id)}
            />
          ))}

        </form>
        </div>
      </div>
    </div>
  );
}
