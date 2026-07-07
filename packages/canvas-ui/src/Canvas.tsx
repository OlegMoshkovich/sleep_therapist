"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";

import CanvasHeaderCard from "./CanvasHeaderCard";
import { EditorInner } from "./internal/EditorInner";
import { BASE_CANVAS_NODE_KINDS } from "./node-kinds";
import { compileCanvas } from "@airlab/canvas-compiler/compiler";
import { extractDoc } from "./legacy";
import {
  normalizeCanvasDoc,
  type CanvasDoc,
  type CanvasFireSignal,
  type CanvasHeader,
  type CanvasInspectorContext,
  type CompilerFn,
  type NodeKindDef,
} from "./types";

const DEFAULT_NODE_KINDS: NodeKindDef[] = BASE_CANVAS_NODE_KINDS;

export interface CanvasChange {
  doc: CanvasDoc;
  text: string;
}

export interface UnifiedCanvasProps {
  /** Persisted canvas doc. Pass null to start blank (or seed via `seedDoc`). */
  value: CanvasDoc | null;
  /** Called on every debounced edit. */
  onChange: (next: CanvasChange) => void;
  /** Optional decorative header that doubles as a collapse toggle. */
  header?: CanvasHeader;
  /** Initial expanded state when `header` is provided. Defaults to true. */
  defaultOpen?: boolean;
  /** Used when `value` is null — populates the canvas with this seed instead of blank. */
  seedDoc?: CanvasDoc;
  /**
   * Optional fallback for legacy markdown payloads (old `policy_prompt` rows
   * that embedded the canvas JSON inside an HTML comment). Used only when
   * `value` is null.
   */
  legacyMarkdown?: string;
  /** Override the default node-kind registry. */
  nodeKinds?: NodeKindDef[];
  /** Override the default compiler. */
  compile?: CompilerFn<string>;
  /** Optional context used by inspector controls. */
  inspectorContext?: CanvasInspectorContext;
  /** Extra tabs appended to the inspector panel (e.g. a State schema editor). */
  inspectorExtraTabs?: { id: string; label: string; content: ReactNode }[];
  /** Give the canvas + inspector a constant viewport-filling height (overlay). */
  fillHeight?: boolean;
  /** Decorative dashed frame + corner tag around the graph (e.g. trained version). */
  graphTag?: string;
  /** Animate a walk through the flow each time this changes (per chat turn). */
  fireSignal?: CanvasFireSignal | null;
}

export default function Canvas({
  value,
  onChange,
  header,
  defaultOpen,
  seedDoc,
  legacyMarkdown,
  nodeKinds = DEFAULT_NODE_KINDS,
  compile = compileCanvas,
  inspectorContext,
  inspectorExtraTabs,
  fillHeight,
  graphTag,
  fireSignal,
}: UnifiedCanvasProps) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  const hasHeader = !!header;

  const doc = useMemo<CanvasDoc | null>(() => {
    if (value) return normalizeCanvasDoc(value);
    if (legacyMarkdown) {
      return normalizeCanvasDoc(extractDoc(legacyMarkdown));
    }
    return null;
  }, [value, legacyMarkdown]);

  const normalizedSeedDoc = useMemo(
    () => normalizeCanvasDoc(seedDoc ?? null),
    [seedDoc]
  );

  const shouldRenderEditor = !hasHeader || open;

  return (
    <ReactFlowProvider>
      {header && (
        <CanvasHeaderCard
          {...header}
          expanded={open}
          onToggle={() => setOpen((o) => !o)}
        />
      )}
      {shouldRenderEditor && (
        <div className="rf-canvas-shell">
          <EditorInner<string>
            nodeKinds={nodeKinds}
            compile={compile}
            doc={doc}
            inspectorContext={inspectorContext}
            inspectorExtraTabs={inspectorExtraTabs}
            fillHeight={fillHeight}
            graphTag={graphTag}
            fireSignal={fireSignal}
            onChange={({ doc: nextDoc, result }) => {
              onChange({ doc: nextDoc, text: result.output });
            }}
            seedDoc={normalizedSeedDoc ?? undefined}
          />
        </div>
      )}
    </ReactFlowProvider>
  );
}

export * from "./types";
export * as CommonNodeKinds from "./node-kinds";
