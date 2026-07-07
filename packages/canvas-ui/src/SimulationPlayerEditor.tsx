"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import {
  DEFAULT_POLICY_NODE_KINDS,
  STATE_CANVAS_NODE_KINDS,
} from "./node-kinds";
import { createStateExtractionCompiler } from "@airlab/canvas-compiler/stateCompiler";
import {
  createEmptyDataset,
  createEmptyDatasetRecord,
  resizeDatasetColumns,
  type SimulationPlayerDataset,
  type SimulationPlayerDatasetColumn,
  type SimulationPlayerDatasetColumnType,
} from "@airlab/canvas-core/components/setup/dataset-schema";
import type { UnifiedCanvasProps } from "./Canvas";
import type { CanvasDoc, CanvasFireSignal, NodeKindDef } from "./types";
import {
  buildInspectorDatasetNames,
  buildInspectorDatasetsContext,
} from "./inspector-prompt-context";

const Canvas = dynamic<UnifiedCanvasProps>(() => import("./Canvas"), {
  ssr: false,
  loading: () => (
    <div className="rounded-xl border border-[#c8c4b4] bg-[#dddacb] px-4 py-6 text-sm font-serif text-gray-500">
      Loading canvas editor…
    </div>
  ),
});

type FieldType = "string" | "integer" | "boolean" | "string[]" | "number" | "json";
const EMPTY_SHARED_DATASETS: SimulationPlayerDataset[] = [];
const DEFAULT_OPEN_ACCORDIONS = ["1", "2", "3"];
const EMPTY_FIELD_NAME_LIST: string[] = [];

export interface SimulationPlayerField {
  id: string;
  name: string;
  type: FieldType;
  initialValue: string;
}

export interface SimulationPlayerGuidelineBlock {
  id: string;
  topic: string;
  content: string;
  problem: string;
  recommendation: string;
}
export type {
  SimulationPlayerDataset,
  SimulationPlayerDatasetColumn,
  SimulationPlayerDatasetColumnType,
} from "@airlab/canvas-core/components/setup/dataset-schema";

export interface SimulationPlayerUploadedFile {
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

export interface SimulationPlayerSkill {
  id: string;
  name: string;
  startConditionCanvases: CanvasDoc | null;
  policyPrompt: string;
  policyCanvases: CanvasDoc | null;
  terminationConditionCanvases: CanvasDoc | null;
}

export interface SimulationPlayerConfig {
  id: string;
  fields: SimulationPlayerField[];
  stateUpdatePrompt: string;
  policyPrompt: string;
  policyCanvases: CanvasDoc | null;
  statePolicyCanvases: CanvasDoc | null;
  skills?: SimulationPlayerSkill[];
  guidelines: SimulationPlayerGuidelineBlock[];
  datasets: SimulationPlayerDataset[];
  uploadedFiles: SimulationPlayerUploadedFile[];
}

export interface SimulationPlayerCopy {
  domainDescription: string;
  stateDescription: string;
  stateSchemaDescription: string;
  stateUpdateSublabel: string;
  stateUpdatePlaceholder: string;
  guidelineTopicPlaceholder: string;
  guidelineContentPlaceholder: string;
  guidelineProblemPlaceholder: string;
  guidelineRecommendationPlaceholder: string;
  datasetPlaceholder: string;
  policyDescription?: string;
}

interface SimulationPlayerEditorProps {
  title: string;
  badge?: string;
  headerContent?: ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  defaultOpenAccordions?: string[];
  protectedFieldNames?: string[];
  lockedFieldTypeNames?: string[];
  stateCanvasNodeKinds?: NodeKindDef[];
  policyCanvasNodeKinds?: NodeKindDef[];
  stateSectionTitle?: string;
  stateSectionDescription?: string;
  stateCanvasTitle?: string;
  stateCanvasSubtitle?: string;
  policySectionTitle?: string;
  policySectionDescription?: string;
  policyCanvasTitle?: string;
  policyCanvasSubtitle?: string;
  copy: SimulationPlayerCopy;
  config: SimulationPlayerConfig;
  fieldTypes: FieldType[];
  isUploadingFiles: boolean;
  showStateUpdatePrompt?: boolean;
  showStateModelCanvas?: boolean;
  showPolicySection?: boolean;
  showGuidelines?: boolean;
  showFileUploads?: boolean;
  /**
   * Rendered inside the State accordion right after the state schema —
   * the interaction protocol is a contract on the canonical state fields.
   */
  interactionProtocolSection?: ReactNode;
  /**
   * Draft-wide shared datasets this agent can fall back to at runtime when a
   * name isn't among its own datasets. Shown to the canvas inspector so the
   * inspector context matches what the agent actually sees; not editable here.
   */
  sharedDatasets?: SimulationPlayerDataset[];
  inspectorRuntimeProfile?: "default" | "daemon" | "primary_agent";
  fireSignal?: CanvasFireSignal | null;
  onChange: (next: SimulationPlayerConfig) => void;
  onAddFiles: (files: FileList | null) => Promise<void>;
  onOpenFile: (file: SimulationPlayerUploadedFile) => Promise<void>;
  onRemoveFile: (fileId: string) => Promise<void>;
  onDeleteGroup?: () => void;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUploadedBy(file: SimulationPlayerUploadedFile): string | null {
  const parts: string[] = [];
  if (file.uploaded_by_email) parts.push(file.uploaded_by_email);
  if (file.uploaded_at) {
    const d = new Date(file.uploaded_at);
    if (!Number.isNaN(d.getTime())) parts.push(d.toLocaleString());
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function makeLocalId() {
  return Math.random().toString(36).slice(2, 9);
}

function createSkillConditionCanvas(
  skillName: string,
  conditionLabel: string
): CanvasDoc {
  const canvasId = makeLocalId();
  const startId = makeLocalId();
  const conditionId = makeLocalId();
  return {
    version: 2,
    activeId: canvasId,
    canvases: [
      {
        id: canvasId,
        name: skillName,
        freeText:
          "This canvas should end with the Condition node. The runtime reads that final condition as true or false.",
        graph: {
          nodes: [
            {
              id: startId,
              type: "start",
              position: { x: 160, y: 60 },
              data: { label: `Evaluate whether ${skillName} should apply.` },
            },
            {
              id: conditionId,
              type: "condition",
              position: { x: 160, y: 220 },
              data: { label: conditionLabel },
            },
          ],
          edges: [
            {
              id: makeLocalId(),
              source: startId,
              target: conditionId,
            },
          ],
        },
      },
    ],
  };
}

function createSkillPolicyCanvas(skillName: string): CanvasDoc {
  const canvasId = makeLocalId();
  const startId = makeLocalId();
  const actionId = makeLocalId();
  return {
    version: 2,
    activeId: canvasId,
    canvases: [
      {
        id: canvasId,
        name: skillName,
        freeText:
          "This policy runs while the temporally extended action is active.",
        graph: {
          nodes: [
            {
              id: startId,
              type: "start",
              position: { x: 180, y: 60 },
              data: { label: `Execute ${skillName}.` },
            },
            {
              id: actionId,
              type: "action",
              position: { x: 180, y: 220 },
              data: {
                label:
                  "Choose the next action for this skill from the current state.",
                actionType: "prompt",
                actionTypeSource: "auto",
              },
            },
          ],
          edges: [{ id: makeLocalId(), source: startId, target: actionId }],
        },
      },
    ],
  };
}

function createEmptySkill(index: number): SimulationPlayerSkill {
  const name = `Skill ${index + 1}`;
  return {
    id: makeLocalId(),
    name,
    startConditionCanvases: createSkillConditionCanvas(
      `${name} start condition`,
      "message contains __replace_me__"
    ),
    policyPrompt: "",
    policyCanvases: createSkillPolicyCanvas(`${name} policy`),
    terminationConditionCanvases: createSkillConditionCanvas(
      `${name} termination condition`,
      "message contains __replace_me__"
    ),
  };
}

function SectionLabel({
  number,
  title,
  description,
}: {
  number: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-2">
      <div className="flex items-baseline gap-3">
        <span className="text-xs font-mono text-gray-400">{number}</span>
        <h3 className="text-lg font-bold font-test-american-grotesk text-black">{title}</h3>
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
        className="w-full flex items-start justify-between gap-4 px-5 py-3 text-left"
      >
        <SectionLabel number={number} title={title} description={description} />
        <span
          className={`mt-1 shrink-0 text-[#5d6c62] transition-transform duration-150 ${
            isOpen ? "rotate-180" : ""
          }`}
        >
          ▾
        </span>
      </button>
      {isOpen && <div className="px-5 pb-4">{children}</div>}
    </section>
  );
}

function FieldRow({
  field,
  fieldTypes,
  isNameLocked,
  isTypeLocked,
  canDelete,
  onChange,
  onDelete,
}: {
  field: SimulationPlayerField;
  fieldTypes: FieldType[];
  isNameLocked: boolean;
  isTypeLocked: boolean;
  canDelete: boolean;
  onChange: (id: string, key: keyof SimulationPlayerField, value: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <tr className="border-b border-[#c8c4b4] group">
      <td className="py-2 pr-3">
        <input
          type="text"
          value={field.name}
          placeholder="field_name"
          readOnly={isNameLocked}
          onChange={(e) => onChange(field.id, "name", e.target.value)}
          className={`w-full bg-transparent font-mono text-sm text-gray-800 placeholder-gray-400 border-b border-transparent pb-0.5 ${
            isNameLocked
              ? "cursor-not-allowed text-gray-500"
              : "focus:outline-none focus:border-gray-400"
          }`}
        />
      </td>
      <td className="py-2 pr-3">
        <select
          value={field.type}
          disabled={isTypeLocked}
          onChange={(e) => onChange(field.id, "type", e.target.value)}
          className={`bg-[#d6d3c4] text-sm font-mono text-gray-700 rounded px-2 py-1 border border-[#c8c4b4] ${
            isTypeLocked
              ? "cursor-not-allowed opacity-70"
              : "focus:outline-none focus:border-gray-500 cursor-pointer"
          }`}
        >
          {fieldTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
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
        {canDelete ? (
          <button
            type="button"
            onClick={() => onDelete(field.id)}
            className="text-gray-400 hover:text-gray-700 transition-colors opacity-0 group-hover:opacity-100 text-lg leading-none"
            aria-label="Delete field"
          >
            ×
          </button>
        ) : (
          <span className="text-[10px] font-mono uppercase tracking-[0.16em] text-gray-400">
            Core
          </span>
        )}
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

const DATASET_COLUMN_TYPES: SimulationPlayerDatasetColumnType[] = [
  "string",
  "url",
  "string[]",
  "integer",
  "number",
  "boolean",
];

const DATASET_COLUMN_TYPE_LABELS: Record<SimulationPlayerDatasetColumnType, string> = {
  string: "string",
  url: "URL",
  "string[]": "string[]",
  integer: "integer",
  number: "number",
  boolean: "boolean",
};

function DatasetCellInput({
  column,
  value,
  onChange,
}: {
  column: SimulationPlayerDatasetColumn;
  value: string;
  onChange: (value: string) => void;
}) {
  if (column.type === "boolean") {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-2 py-1.5 text-sm font-mono text-gray-800 focus:outline-none focus:border-gray-500"
      >
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (column.type === "string[]") {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        placeholder="one item per line or comma-separated"
        className="w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-2 py-1.5 text-sm font-mono text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-500 resize-y"
      />
    );
  }

  const isNumeric = column.type === "integer" || column.type === "number";
  const inputType = column.type === "url" ? "url" : isNumeric ? "number" : "text";

  return (
    <input
      type={inputType}
      step={column.type === "integer" ? "1" : column.type === "number" ? "any" : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={column.type === "url" ? "https://example.com" : undefined}
      className="w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-2 py-1.5 text-sm font-mono text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-500"
    />
  );
}

export function DatasetRow({
  dataset,
  onChangeName,
  onChangeNotes,
  onChangeColumnCount,
  onChangeColumn,
  onAddRecord,
  onChangeRecordValue,
  onDeleteRecord,
  onDelete,
}: {
  dataset: SimulationPlayerDataset;
  onChangeName: (id: string, value: string) => void;
  onChangeNotes: (id: string, value: string) => void;
  onChangeColumnCount: (id: string, count: number) => void;
  onChangeColumn: (
    datasetId: string,
    columnId: string,
    key: keyof SimulationPlayerDatasetColumn,
    value: string
  ) => void;
  onAddRecord: (datasetId: string) => void;
  onChangeRecordValue: (
    datasetId: string,
    recordId: string,
    columnId: string,
    value: string
  ) => void;
  onDeleteRecord: (datasetId: string, recordId: string) => void;
  onDelete: (id: string) => void;
}) {
  const [visibleRecordCount, setVisibleRecordCount] = useState(5);
  const clampedVisibleRecordCount =
    dataset.records.length <= 5
      ? 5
      : Math.max(5, Math.min(visibleRecordCount, dataset.records.length));
  const visibleRecords = dataset.records.slice(
    0,
    Math.min(clampedVisibleRecordCount, dataset.records.length)
  );

  return (
    <div className="bg-[#d6d3c4] border border-[#c8c4b4] rounded p-4">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex-1">
          <label className="block text-xs uppercase tracking-widest text-gray-500 font-sans mb-1">
            Dataset name
          </label>
          <input
            type="text"
            value={dataset.name}
            onChange={(e) => onChangeName(dataset.id, e.target.value)}
            placeholder="Dataset name"
            className="w-full bg-transparent font-bold font-test-american-grotesk text-sm text-gray-900 placeholder-gray-400 focus:outline-none border-b border-transparent focus:border-gray-500 pb-0.5"
          />
        </div>
        <button
          type="button"
          onClick={() => onDelete(dataset.id)}
          className="text-gray-400 hover:text-gray-700 transition-colors text-lg leading-none"
          aria-label="Delete dataset"
        >
          ×
        </button>
      </div>
      <div className="grid gap-4 md:grid-cols-[160px_minmax(0,1fr)] mb-5">
        <div>
          <label className="block text-xs uppercase tracking-widest text-gray-500 font-sans mb-1">
            Columns
          </label>
          <input
            type="number"
            min={1}
            max={25}
            value={dataset.columns.length}
            onChange={(e) =>
              onChangeColumnCount(
                dataset.id,
                Number.parseInt(e.target.value || "1", 10)
              )
            }
            className="w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-3 py-2 text-sm font-mono text-gray-800 focus:outline-none focus:border-gray-500"
          />
        </div>
        <div className="rounded border border-[#c0bdb0] bg-[#cbc8b8] px-3 py-2">
          <p className="text-xs uppercase tracking-widest text-gray-500 font-sans mb-1">
            Preview
          </p>
          <p className="text-sm font-serif text-gray-700">
            Showing {Math.min(clampedVisibleRecordCount, dataset.records.length)} of {dataset.records.length} records
          </p>
        </div>
      </div>

      <div className="mb-5">
        <label className="block text-xs uppercase tracking-widest text-gray-500 font-sans mb-1">
          Notes
        </label>
        <textarea
          value={dataset.notes}
          onChange={(e) => onChangeNotes(dataset.id, e.target.value)}
          rows={3}
          placeholder="Add general notes about this dataset, its columns, assumptions, or caveats…"
          className="w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-3 py-2 text-sm font-serif text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-500 resize-y leading-relaxed"
        />
      </div>

      <div className="mb-5">
        <p className="text-xs uppercase tracking-widest text-gray-500 font-sans mb-2">
          Columns
        </p>
        <div className="space-y-3">
          {dataset.columns.map((column, index) => (
            <div key={column.id} className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
              <input
                type="text"
                value={column.name}
                onChange={(e) =>
                  onChangeColumn(dataset.id, column.id, "name", e.target.value)
                }
                placeholder={`column_${index + 1}`}
                className="w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-3 py-2 text-sm font-mono text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-500"
              />
              <select
                value={column.type}
                onChange={(e) =>
                  onChangeColumn(dataset.id, column.id, "type", e.target.value)
                }
                className="w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-3 py-2 text-sm font-mono text-gray-800 focus:outline-none focus:border-gray-500"
              >
                {DATASET_COLUMN_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {DATASET_COLUMN_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between gap-3 mb-3">
          <p className="text-xs uppercase tracking-widest text-gray-500 font-sans">
            Records
          </p>
          <button
            type="button"
            onClick={() => onAddRecord(dataset.id)}
            className="text-xs font-sans uppercase tracking-widest text-gray-500 hover:text-gray-800 transition-colors border border-[#c0bdb0] hover:border-gray-500 rounded px-3 py-2"
          >
            + Add record
          </button>
        </div>

        {dataset.records.length === 0 ? (
          <div className="rounded border border-dashed border-[#c0bdb0] bg-[#cbc8b8] px-4 py-5">
            <p className="text-sm font-serif text-gray-500">
              No records yet. Add a record to start filling the dataset.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded border border-[#c0bdb0]">
            <table className="min-w-full">
              <thead className="bg-[#cbc8b8]">
                <tr className="border-b border-[#c0bdb0]">
                  {dataset.columns.map((column) => (
                    <th
                      key={column.id}
                      className="px-3 py-2 text-left text-xs uppercase tracking-widest text-gray-500 font-sans font-normal"
                    >
                      {column.name || "Untitled column"}
                    </th>
                  ))}
                  <th className="w-10 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {visibleRecords.map((record) => (
                  <tr key={record.id} className="border-b border-[#c0bdb0] last:border-b-0">
                    {dataset.columns.map((column) => (
                      <td key={column.id} className="px-3 py-2 min-w-[180px]">
                        <DatasetCellInput
                          column={column}
                          value={record.values[column.id] ?? ""}
                          onChange={(value) =>
                            onChangeRecordValue(dataset.id, record.id, column.id, value)
                          }
                        />
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right align-top">
                      <button
                        type="button"
                        onClick={() => onDeleteRecord(dataset.id, record.id)}
                        className="text-gray-400 hover:text-gray-700 transition-colors text-lg leading-none"
                        aria-label="Delete record"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {dataset.records.length > 5 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {clampedVisibleRecordCount < dataset.records.length && (
              <button
                type="button"
                onClick={() =>
                  setVisibleRecordCount((prev) => (prev <= 5 ? 25 : prev + 20))
                }
                className="text-xs font-sans uppercase tracking-widest text-gray-500 hover:text-gray-800 transition-colors border border-[#c0bdb0] hover:border-gray-500 rounded px-3 py-2"
              >
                Show next 20
              </button>
            )}
            {clampedVisibleRecordCount > 5 && (
              <button
                type="button"
                onClick={() => setVisibleRecordCount(5)}
                className="text-xs font-sans uppercase tracking-widest text-gray-500 hover:text-gray-800 transition-colors border border-[#c0bdb0] hover:border-gray-500 rounded px-3 py-2"
              >
                Show first 5
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function SimulationPlayerEditor({
  title,
  badge,
  headerContent,
  collapsible = false,
  defaultCollapsed = false,
  defaultOpenAccordions = DEFAULT_OPEN_ACCORDIONS,
  protectedFieldNames = EMPTY_FIELD_NAME_LIST,
  lockedFieldTypeNames = EMPTY_FIELD_NAME_LIST,
  stateCanvasNodeKinds = STATE_CANVAS_NODE_KINDS,
  policyCanvasNodeKinds = DEFAULT_POLICY_NODE_KINDS,
  stateSectionTitle = "State",
  stateSectionDescription,
  stateCanvasTitle = "State extraction",
  stateCanvasSubtitle = "compiles to extraction prompt",
  policySectionTitle = "Policy",
  policySectionDescription,
  policyCanvasTitle = "Prompt composition",
  policyCanvasSubtitle = "compiles to prompt",
  copy,
  config,
  fieldTypes,
  isUploadingFiles,
  showStateUpdatePrompt = true,
  showStateModelCanvas = true,
  showPolicySection = true,
  showGuidelines = false,
  showFileUploads = true,
  interactionProtocolSection,
  sharedDatasets = EMPTY_SHARED_DATASETS,
  inspectorRuntimeProfile = "default",
  fireSignal,
  onChange,
  onAddFiles,
  onOpenFile,
  onRemoveFile,
  onDeleteGroup,
}: SimulationPlayerEditorProps) {
  const [openAccordions, setOpenAccordions] = useState<string[]>(defaultOpenAccordions);
  const [isEditorOpen, setIsEditorOpen] = useState(!defaultCollapsed);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isEditorBodyOpen = !collapsible || isEditorOpen;
  const stateCanvasCompiler = useMemo(
    () => createStateExtractionCompiler(config.fields),
    [config.fields]
  );
  // What the agent actually sees at runtime: its own datasets first, then
  // draft-wide shared datasets that aren't shadowed by a same-named own one.
  const inspectorDatasets = useMemo(() => {
    if (sharedDatasets.length === 0) {
      return config.datasets;
    }
    const ownNames = new Set(
      config.datasets.map((dataset) => dataset.name.trim().toLowerCase())
    );
    return [
      ...config.datasets,
      ...sharedDatasets.filter(
        (dataset) => !ownNames.has(dataset.name.trim().toLowerCase())
      ),
    ];
  }, [config.datasets, sharedDatasets]);
  const inspectorContext = useMemo(
    () => ({
      datasetNames: buildInspectorDatasetNames(
        inspectorDatasets,
        config.guidelines
      ),
      runtimeProfile: inspectorRuntimeProfile,
      datasetsContext:
        inspectorRuntimeProfile === "daemon"
          ? undefined
          : buildInspectorDatasetsContext(inspectorDatasets, config.guidelines),
      stateSchema: config.fields.map((field) => ({
        fieldName: field.name,
        type: field.type,
        initialValue: field.initialValue,
      })),
      stateUpdateSystemPrompt: config.stateUpdatePrompt,
      policyExecutionSystemPrompt: config.policyPrompt,
    }),
    [
      inspectorDatasets,
      config.fields,
      config.guidelines,
      config.policyCanvases,
      config.policyPrompt,
      config.stateUpdatePrompt,
      inspectorRuntimeProfile,
    ]
  );
  const stateInspectorContext = useMemo(
    () => ({ ...inspectorContext, executionPhase: "state" as const }),
    [inspectorContext]
  );
  const policyInspectorContext = useMemo(
    () => ({ ...inspectorContext, executionPhase: "policy" as const }),
    [inspectorContext]
  );
  const normalizedProtectedFieldNames = useMemo(
    () =>
      new Set(
        protectedFieldNames
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean)
      ),
    [protectedFieldNames]
  );
  const normalizedLockedFieldTypeNames = useMemo(
    () =>
      new Set(
        lockedFieldTypeNames
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean)
      ),
    [lockedFieldTypeNames]
  );

  function toggleAccordion(id: string) {
    setOpenAccordions((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }

  const updateConfig = useCallback(
    (patch: Partial<SimulationPlayerConfig>) => {
      onChange({ ...config, ...patch });
    },
    [config, onChange]
  );

  function updateField(id: string, key: keyof SimulationPlayerField, value: string) {
    updateConfig({
      fields: config.fields.map((field) => (field.id === id ? { ...field, [key]: value } : field)),
    });
  }

  function deleteField(id: string) {
    updateConfig({ fields: config.fields.filter((field) => field.id !== id) });
  }

  function addField() {
    updateConfig({
      fields: [...config.fields, { id: Math.random().toString(36).slice(2, 9), name: "", type: "string", initialValue: "null" }],
    });
  }

  function updateGuideline(
    id: string,
    key: keyof SimulationPlayerGuidelineBlock,
    value: string
  ) {
    updateConfig({
      guidelines: config.guidelines.map((guideline) =>
        guideline.id === id ? { ...guideline, [key]: value } : guideline
      ),
    });
  }

  function deleteGuideline(id: string) {
    updateConfig({ guidelines: config.guidelines.filter((guideline) => guideline.id !== id) });
  }

  function addGuideline() {
    updateConfig({
      guidelines: [
        ...config.guidelines,
        {
          id: Math.random().toString(36).slice(2, 9),
          topic: "",
          content: "",
          problem: "",
          recommendation: "",
        },
      ],
    });
  }

  function updateDatasetName(id: string, value: string) {
    updateConfig({
      datasets: config.datasets.map((dataset) =>
        dataset.id === id ? { ...dataset, name: value } : dataset
      ),
    });
  }

  function updateDatasetNotes(id: string, value: string) {
    updateConfig({
      datasets: config.datasets.map((dataset) =>
        dataset.id === id ? { ...dataset, notes: value } : dataset
      ),
    });
  }

  function updateDatasetColumnCount(id: string, count: number) {
    updateConfig({
      datasets: config.datasets.map((dataset) =>
        dataset.id === id ? resizeDatasetColumns(dataset, count, makeLocalId) : dataset
      ),
    });
  }

  function updateDatasetColumn(
    datasetId: string,
    columnId: string,
    key: keyof SimulationPlayerDatasetColumn,
    value: string
  ) {
    updateConfig({
      datasets: config.datasets.map((dataset) =>
        dataset.id !== datasetId
          ? dataset
          : {
              ...dataset,
              columns: dataset.columns.map((column) =>
                column.id === columnId
                  ? {
                      ...column,
                      [key]:
                        key === "type"
                          ? (value as SimulationPlayerDatasetColumnType)
                          : value,
                    }
                  : column
              ),
            }
      ),
    });
  }

  function addDatasetRecord(datasetId: string) {
    updateConfig({
      datasets: config.datasets.map((dataset) =>
        dataset.id !== datasetId
          ? dataset
          : {
              ...dataset,
              records: [...dataset.records, createEmptyDatasetRecord(dataset.columns, makeLocalId)],
            }
      ),
    });
  }

  function updateDatasetRecordValue(
    datasetId: string,
    recordId: string,
    columnId: string,
    value: string
  ) {
    updateConfig({
      datasets: config.datasets.map((dataset) =>
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
      ),
    });
  }

  function deleteDatasetRecord(datasetId: string, recordId: string) {
    updateConfig({
      datasets: config.datasets.map((dataset) =>
        dataset.id !== datasetId
          ? dataset
          : {
              ...dataset,
              records: dataset.records.filter((record) => record.id !== recordId),
            }
      ),
    });
  }

  function deleteDataset(id: string) {
    updateConfig({ datasets: config.datasets.filter((dataset) => dataset.id !== id) });
  }

  function addDataset() {
    updateConfig({
      datasets: [
        ...config.datasets,
        createEmptyDataset(makeLocalId, config.datasets.length),
      ],
    });
  }

  function updateSkill(
    id: string,
    updater: (skill: SimulationPlayerSkill) => SimulationPlayerSkill
  ) {
    updateConfig({
      skills: (config.skills ?? []).map((skill) =>
        skill.id === id ? updater(skill) : skill
      ),
    });
  }

  function addSkill() {
    const skills = config.skills ?? [];
    updateConfig({
      skills: [...skills, createEmptySkill(skills.length)],
    });
  }

  function deleteSkill(id: string) {
    updateConfig({
      skills: (config.skills ?? []).filter((skill) => skill.id !== id),
    });
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    await onAddFiles(e.dataTransfer.files);
  }

  return (
    <section className="border border-[#c8c4b4] rounded-xl bg-[#e7e4d8] p-5 space-y-5">
      <div className="flex items-start justify-between gap-4">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setIsEditorOpen((previous) => !previous)}
            className="flex min-w-0 flex-1 items-start justify-between gap-4 text-left"
            aria-expanded={isEditorOpen}
          >
            <p className="min-w-0 text-[10px] font-mono uppercase tracking-[0.24em] text-[#6c7464]">
              {title}
            </p>
            <span
              className={`mt-1 shrink-0 text-[#5d6c62] transition-transform duration-150 ${
                isEditorOpen ? "rotate-180" : ""
              }`}
            >
              ▾
            </span>
          </button>
        ) : (
          <div>
            {badge && <p className="text-xs font-sans tracking-widest uppercase text-gray-400 mb-2">{badge}</p>}
            <h2 className="text-2xl font-bold font-test-american-grotesk text-black">{title}</h2>
          </div>
        )}
        {onDeleteGroup && (
          <button
            type="button"
            onClick={onDeleteGroup}
            className="text-xs font-sans uppercase tracking-widest text-gray-500 underline hover:text-gray-900"
          >
            Remove
          </button>
        )}
      </div>

      {isEditorBodyOpen ? (
        <>
          {headerContent}

      <AccordionSection
        number="1"
        title="Datasets"
        description={copy.domainDescription}
        isOpen={openAccordions.includes("1")}
        onToggle={() => toggleAccordion("1")}
      >
        {showGuidelines && config.guidelines.length > 0 && (
          <>
            <p className="text-xs uppercase tracking-widest text-gray-400 font-sans mb-3">Guidelines</p>
            <div className="space-y-4 mb-4">
              {config.guidelines.map((guideline, index) => (
                <div key={guideline.id} className="bg-[#d6d3c4] border border-[#c8c4b4] rounded p-4">
                  <div className="flex items-center justify-between mb-3">
                    <input
                      type="text"
                      value={guideline.topic}
                      onChange={(e) => updateGuideline(guideline.id, "topic", e.target.value)}
                      placeholder={copy.guidelineTopicPlaceholder.replace("{n}", String(index + 1))}
                      className="bg-transparent font-bold font-test-american-grotesk text-sm text-gray-900 placeholder-gray-400 focus:outline-none border-b border-transparent focus:border-gray-500 pb-0.5 flex-1 mr-4"
                    />
                    <button
                      type="button"
                      onClick={() => deleteGuideline(guideline.id)}
                      className="text-gray-400 hover:text-gray-700 transition-colors text-lg leading-none shrink-0"
                      aria-label="Delete guideline block"
                    >
                      ×
                    </button>
                  </div>

                  <textarea
                    value={guideline.content}
                    onChange={(e) => updateGuideline(guideline.id, "content", e.target.value)}
                    rows={5}
                    placeholder={copy.guidelineContentPlaceholder}
                    className="w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-3 py-2 text-sm font-serif text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-500 resize-y leading-relaxed"
                  />

                  <div className="mt-3">
                    <label className="block text-xs uppercase tracking-widest text-gray-500 font-sans mb-1">
                      Problem description
                    </label>
                    <textarea
                      value={guideline.problem}
                      onChange={(e) => updateGuideline(guideline.id, "problem", e.target.value)}
                      rows={3}
                      placeholder={copy.guidelineProblemPlaceholder}
                      className="w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-3 py-2 text-sm font-serif text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-500 resize-y leading-relaxed"
                    />
                  </div>

                  <div className="mt-3">
                    <label className="block text-xs uppercase tracking-widest text-gray-500 font-sans mb-1">
                      Recommendation
                    </label>
                    <textarea
                      value={guideline.recommendation}
                      onChange={(e) => updateGuideline(guideline.id, "recommendation", e.target.value)}
                      rows={3}
                      placeholder={copy.guidelineRecommendationPlaceholder}
                      className="w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-3 py-2 text-sm font-serif text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-500 resize-y leading-relaxed"
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {showGuidelines && (
          <button
            type="button"
            onClick={addGuideline}
            className={`text-xs font-sans uppercase tracking-widest text-gray-500 hover:text-gray-800 transition-colors border border-[#c8c4b4] hover:border-gray-500 rounded px-4 py-2 ${
              config.guidelines.length > 0 ? "mb-8" : "mb-6"
            }`}
          >
            + Add guideline
          </button>
        )}

        {showFileUploads && (
          <>
            <p className="text-xs uppercase tracking-widest text-gray-400 font-sans mb-3 mt-2">Files</p>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => void handleDrop(e)}
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
                onChange={(e) => void onAddFiles(e.target.files)}
              />
              <p className="text-sm font-serif text-gray-500">
                {isUploadingFiles ? "Uploading..." : <>Drop files here or <span className="underline">browse</span></>}
              </p>
              <p className="text-xs font-mono text-gray-400 mt-1">PDF · TXT · MD · DOCX</p>
            </div>

            {config.uploadedFiles.length > 0 && (
              <ul className="mt-3 space-y-2">
                {config.uploadedFiles.map((file) => (
                  <li
                    key={file.id}
                    className="flex items-center justify-between bg-[#d6d3c4] border border-[#c8c4b4] rounded px-4 py-2"
                  >
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => void onOpenFile(file)}
                        className="text-sm font-serif text-gray-800 truncate underline hover:text-gray-900 text-left"
                      >
                        {file.name}
                      </button>
                      <p className="text-xs font-mono text-gray-400">{formatBytes(file.size)}</p>
                      {formatUploadedBy(file) && (
                        <p className="text-xs font-mono text-gray-400">{formatUploadedBy(file)}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onRemoveFile(file.id);
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
          </>
        )}

        <div className="mt-8">
          <p className="text-xs uppercase tracking-widest text-gray-400 font-sans mb-3">
            Datasets
          </p>
          <div className="space-y-4 mb-4">
            {config.datasets.map((dataset) => (
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
        title={stateSectionTitle}
        description={stateSectionDescription ?? copy.stateDescription}
        isOpen={openAccordions.includes("2")}
        onToggle={() => toggleAccordion("2")}
      >
        <div className="mb-8">
          <p className="text-xs uppercase tracking-widest text-gray-500 font-sans mb-2">State schema</p>
          <p className="text-xs font-serif text-gray-400 mb-3 leading-relaxed">
            {copy.stateSchemaDescription}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[#c8c4b4]">
                  <th className="text-xs uppercase tracking-widest text-gray-400 font-sans pb-2 pr-3 font-normal">
                    Field name
                  </th>
                  <th className="text-xs uppercase tracking-widest text-gray-400 font-sans pb-2 pr-3 font-normal">
                    Type
                  </th>
                  <th className="text-xs uppercase tracking-widest text-gray-400 font-sans pb-2 pr-3 font-normal">
                    Initial value
                  </th>
                  <th className="pb-2 w-8" />
                </tr>
              </thead>
              <tbody>
                {config.fields.map((field) => {
                  const normalizedFieldName = field.name.trim().toLowerCase();
                  return (
                  <FieldRow
                    key={field.id}
                    field={field}
                    fieldTypes={fieldTypes}
                    isNameLocked={normalizedProtectedFieldNames.has(normalizedFieldName)}
                    isTypeLocked={normalizedLockedFieldTypeNames.has(normalizedFieldName)}
                    canDelete={!normalizedProtectedFieldNames.has(normalizedFieldName)}
                    onChange={updateField}
                    onDelete={deleteField}
                  />
                  );
                })}
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

        {interactionProtocolSection && (
          <div className="mb-8">{interactionProtocolSection}</div>
        )}

        {showStateUpdatePrompt && (
          <TextArea
            label="State update prompt"
            sublabel={copy.stateUpdateSublabel}
            value={config.stateUpdatePrompt}
            onChange={(value) => updateConfig({ stateUpdatePrompt: value })}
            rows={7}
            placeholder={copy.stateUpdatePlaceholder}
          />
        )}

        {showStateModelCanvas && (
          <div className="mt-10">
            <Canvas
              header={{
                title: stateCanvasTitle,
                subtitle: stateCanvasSubtitle,
              }}
              defaultOpen={false}
              value={config.statePolicyCanvases}
              compile={stateCanvasCompiler}
              nodeKinds={stateCanvasNodeKinds}
              inspectorContext={stateInspectorContext}
              fireSignal={fireSignal}
              onChange={({ doc, text }) =>
                updateConfig({ statePolicyCanvases: doc, stateUpdatePrompt: text })
              }
            />
          </div>
        )}
      </AccordionSection>

      {showPolicySection && (
        <AccordionSection
          number="3"
          title={policySectionTitle}
          description={
            policySectionDescription ??
            copy.policyDescription ??
            "The prompt composition canvas defines the prompt the model sees and compiles to a string."
          }
          isOpen={openAccordions.includes("3")}
          onToggle={() => toggleAccordion("3")}
        >
          <div className="mt-10">
            <Canvas
              header={{
                title: policyCanvasTitle,
                subtitle: policyCanvasSubtitle,
              }}
              value={config.policyCanvases}
              legacyMarkdown={config.policyPrompt}
              nodeKinds={policyCanvasNodeKinds}
              inspectorContext={policyInspectorContext}
              fireSignal={fireSignal}
              onChange={({ doc, text }) =>
                updateConfig({ policyCanvases: doc, policyPrompt: text })
              }
            />
          </div>
        </AccordionSection>
      )}

      <AccordionSection
        number="4"
        title="Temporally Extended Actions (Skills)"
        description="Define optional multi-round skills. At runtime, one executable skill can take over policy execution until its termination condition becomes true."
        isOpen={openAccordions.includes("4")}
        onToggle={() => toggleAccordion("4")}
      >
        <div className="space-y-4">
          {(config.skills ?? []).length === 0 ? (
            <p className="rounded-lg border border-dashed border-[#c8c4b4] bg-[#d6d3c4] px-4 py-4 text-sm font-serif text-gray-600">
              No skills yet.
            </p>
          ) : (
            (config.skills ?? []).map((skill, index) => (
              <div
                key={skill.id}
                className="rounded-lg border border-[#c8c4b4] bg-[#d6d3c4] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <label className="block min-w-0 flex-1">
                    <span className="text-xs uppercase tracking-widest text-gray-500 font-sans">
                      Skill name
                    </span>
                    <input
                      value={skill.name}
                      onChange={(event) =>
                        updateSkill(skill.id, (current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      placeholder={`Skill ${index + 1}`}
                      className="mt-2 w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded px-3 py-2 text-sm font-serif text-gray-800 focus:outline-none focus:border-gray-500"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => deleteSkill(skill.id)}
                    className="mt-7 text-xs font-sans uppercase tracking-widest text-gray-500 underline hover:text-gray-900"
                  >
                    Remove
                  </button>
                </div>

                <div className="mt-4 space-y-4">
                  <Canvas
                    header={{
                      title: "Start condition",
                      subtitle: "true begins skill execution",
                    }}
                    defaultOpen={false}
                    value={skill.startConditionCanvases}
                    seedDoc={createSkillConditionCanvas(
                      `${skill.name || `Skill ${index + 1}`} start condition`,
                      "message contains __replace_me__"
                    )}
                    nodeKinds={policyCanvasNodeKinds}
                    inspectorContext={policyInspectorContext}
                    fireSignal={fireSignal}
                    onChange={({ doc }) =>
                      updateSkill(skill.id, (current) => ({
                        ...current,
                        startConditionCanvases: doc,
                      }))
                    }
                  />

                  <Canvas
                    header={{
                      title: "Skill policy",
                      subtitle: "runs while this skill is active",
                    }}
                    defaultOpen={false}
                    value={skill.policyCanvases}
                    seedDoc={createSkillPolicyCanvas(
                      `${skill.name || `Skill ${index + 1}`} policy`
                    )}
                    legacyMarkdown={skill.policyPrompt}
                    nodeKinds={policyCanvasNodeKinds}
                    inspectorContext={policyInspectorContext}
                    fireSignal={fireSignal}
                    onChange={({ doc, text }) =>
                      updateSkill(skill.id, (current) => ({
                        ...current,
                        policyCanvases: doc,
                        policyPrompt: text,
                      }))
                    }
                  />

                  <Canvas
                    header={{
                      title: "Termination condition",
                      subtitle: "true ends skill execution",
                    }}
                    defaultOpen={false}
                    value={skill.terminationConditionCanvases}
                    seedDoc={createSkillConditionCanvas(
                      `${skill.name || `Skill ${index + 1}`} termination condition`,
                      "message contains __replace_me__"
                    )}
                    nodeKinds={policyCanvasNodeKinds}
                    inspectorContext={policyInspectorContext}
                    fireSignal={fireSignal}
                    onChange={({ doc }) =>
                      updateSkill(skill.id, (current) => ({
                        ...current,
                        terminationConditionCanvases: doc,
                      }))
                    }
                  />
                </div>
              </div>
            ))
          )}
        </div>

        <button
          type="button"
          onClick={addSkill}
          className="mt-4 text-xs font-sans uppercase tracking-widest text-gray-500 hover:text-gray-800 transition-colors border border-[#c8c4b4] hover:border-gray-500 rounded px-4 py-2"
        >
          + Add skill
        </button>
      </AccordionSection>
        </>
      ) : null}
    </section>
  );
}
