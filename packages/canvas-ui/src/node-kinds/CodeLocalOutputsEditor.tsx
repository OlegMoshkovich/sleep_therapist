"use client";

import { useEffect, useState } from "react";
import type { CanvasNodeData } from "../types";
import type { FieldType } from "@airlab/canvas-core/lib/canvas-hybrid-runtime";
import {
  NODE_EXECUTABLE_CODE_LOCAL_OUTPUTS_DATA_KEY,
  normalizeNodeCodeLocalOutputFields,
  type CanvasCodeLocalOutputField,
} from "@airlab/canvas-core/lib/canvas-node-code-script";

interface CodeLocalOutputRow extends CanvasCodeLocalOutputField {
  id: string;
}

const OUTPUT_TYPES: FieldType[] = [
  "string",
  "integer",
  "boolean",
  "string[]",
  "number",
  "json",
];

const fieldLabel = "block text-[10px] uppercase tracking-widest text-gray-500 font-sans mt-2";
const input =
  "w-full bg-[#cbc8b8] border border-[#c0bdb0] rounded-none px-2 py-1.5 text-xs font-mono text-gray-800 focus:outline-none focus:border-gray-500";

function makeRowId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `c-${Math.random().toString(36).slice(2, 10)}`;
}

function rowsFromValue(raw: unknown): CodeLocalOutputRow[] {
  return normalizeNodeCodeLocalOutputFields(raw).map((field) => ({
    id: makeRowId(),
    ...field,
  }));
}

function valueFromRows(rows: CodeLocalOutputRow[]): CanvasCodeLocalOutputField[] {
  return rows
    .map((row) => ({
      name: row.name.trim(),
      type: row.type,
    }))
    .filter((row) => row.name.length > 0);
}

export function CodeLocalOutputsEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (next: CanvasCodeLocalOutputField[]) => void;
}) {
  const [rows, setRows] = useState<CodeLocalOutputRow[]>(() => rowsFromValue(value));

  useEffect(() => {
    const nextRows = rowsFromValue(value);
    const currentValue = JSON.stringify(valueFromRows(rows));
    const nextValue = JSON.stringify(valueFromRows(nextRows));
    if (currentValue === nextValue) {
      return;
    }
    setRows(nextRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function commit(nextRows: CodeLocalOutputRow[]) {
    setRows(nextRows);
    onChange(valueFromRows(nextRows));
  }

  function patch(id: string, patchObj: Partial<CodeLocalOutputRow>) {
    commit(rows.map((row) => (row.id === id ? { ...row, ...patchObj } : row)));
  }

  function remove(id: string) {
    commit(rows.filter((row) => row.id !== id));
  }

  function add() {
    commit([
      ...rows,
      {
        id: makeRowId(),
        name: "",
        type: "string",
      },
    ]);
  }

  return (
    <div className="mt-3">
      <label className={fieldLabel}>Declared local outputs</label>
      <p className="text-[10px] font-serif text-gray-500 mt-1 leading-snug">
        Optional. Declare local variables this script writes so downstream conditions and
        runtime steps can see them structurally in the editor.
      </p>

      <div className="mt-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-gray-500 font-sans">
          Saved values
        </span>
        <button
          type="button"
          onClick={add}
          className="text-[10px] font-sans uppercase tracking-widest border border-gray-500 text-gray-700 hover:bg-gray-100 rounded-none px-2 py-0.5"
        >
          + Output field
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-[10px] font-serif text-gray-500 italic mt-2">
          No declared locals yet.
        </p>
      ) : (
        <div className="space-y-2 mt-2">
          {rows.map((row) => (
            <div
              key={row.id}
              className="border border-[#c0bdb0] rounded-none p-2 bg-[#e0dccc] space-y-1.5"
            >
              <div className="flex items-center gap-1.5">
                <input
                  value={row.name}
                  onChange={(e) => patch(row.id, { name: e.target.value })}
                  placeholder="variable_name"
                  className={`${input} flex-1`}
                />
                <select
                  value={row.type}
                  onChange={(e) =>
                    patch(row.id, {
                      type: e.target.value as FieldType,
                    })
                  }
                  className={`${input} w-24`}
                >
                  {OUTPUT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => remove(row.id)}
                  className="text-gray-500 hover:text-red-600 text-base leading-none px-1"
                  aria-label="Remove output field"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function updateCodeLocalOutputFields(
  update: (patch: Partial<CanvasNodeData>) => void,
  next: CanvasCodeLocalOutputField[]
) {
  update({
    [NODE_EXECUTABLE_CODE_LOCAL_OUTPUTS_DATA_KEY]: next,
  });
}
