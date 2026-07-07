# Canvas

Generic, reusable canvas component for graph-based authoring. The shell
(ReactFlow integration, multi-canvas tabs, inspector, toolbar, debounced
change propagation) is shared; node kinds and the compiler are supplied by
the caller.

## Variants

| Variant | Compiles to | Example consumer |
|---|---|---|
| `model` | A prompt string | `app/components/policy/PolicyCanvas.tsx` |
| `system` | Executable code (e.g. a `root.ts` string or AST) | _none yet_ |

The variant flag is a self-documenting hint — the shell does not branch on
it. What actually differs between variants is:

1. The set of `NodeKindDef`s registered with the canvas.
2. The `compile: (doc) => { output, preview }` function supplied by the caller.

## Registering node kinds

```ts
import Canvas, {
  CommonNodeKinds,
  type NodeKindDef,
  type CompilerFn,
} from "@/app/components/canvas/Canvas";

// Reuse the built-in primitives:
const { START, CONDITION, PROMPT, CODE, TOOL_CALL } = CommonNodeKinds;

// Define domain-specific kinds:
const TOOL_CALL: NodeKindDef = {
  kind: "tool_call",
  toolbarLabel: "+ Tool",
  toolbarClassName: "...",
  component: ToolCallNode,
  defaultLabel: "tool_name(...)",
};

const KINDS: NodeKindDef[] = [START, CONDITION, PROMPT, CODE, TOOL_CALL];
```

## Compiler contract

```ts
type CompilerFn<TOutput> = (doc: CanvasDoc) => {
  output: TOutput;
  preview?: string; // shown in the editor below the canvas
};
```

The compiler is invoked on every debounced state change (150 ms). It must
be pure — no I/O, no side effects. Errors should be reported via `preview`
(e.g. `preview: "(add a Start node to compile)"`) rather than thrown.

## Minimal example — Model variant (compile to string)

```tsx
const compileToPrompt: CompilerFn<string> = (doc) => {
  const lines = doc.canvases.map((c) => `# ${c.name}\n${stringify(c.graph)}`);
  return { output: lines.join("\n\n"), preview: lines[0] };
};

<Canvas<string>
  variant="model"
  nodeKinds={[START, CONDITION, PROMPT]}
  compile={compileToPrompt}
  doc={loadedDoc}
  onChange={({ doc, result }) => {
    persistDoc(doc);
    setPromptString(result.output);
  }}
/>
```

## Minimal example — System variant (compile to code)

```tsx
interface CompiledSystem {
  rootTs: string;
  ast: SomeAst;
}

const compileToCode: CompilerFn<CompiledSystem> = (doc) => {
  const ast = buildAst(doc);
  return {
    output: { rootTs: emit(ast), ast },
    preview: emit(ast),
  };
};

<Canvas<CompiledSystem>
  variant="system"
  nodeKinds={[START, CONDITION, PROMPT, CODE, TOOL_CALL]}
  compile={compileToCode}
  doc={loadedDoc}
  onChange={({ doc, result }) => {
    persistDoc(doc);
    writeRootTs(result.output.rootTs);
  }}
/>
```

## Common node kinds

`CommonNodeKinds` re-exports primitives suitable for either variant:

| Kind | Behaviour |
|---|---|
| `START` | Singleton; not addable from the toolbar; auto-inserted into new canvases. |
| `CONDITION` | True/false branches (`sourceHandles` = `[{id:"true"}, {id:"false"}]`); edges are auto-labelled by handle. |
| `PROMPT` | Model-authored step. Its prompt type can be Default or Prompt transform. |
| `CODE` | Deterministic state/local mutation or constrained TypeScript step. |
| `TOOL_CALL` | Runtime tool invocation node with source, parameter, and result-variable settings. |
| `DISPLAY` | Chat output node. Text display reads a configured input variable; video display uses a video URL. |

Each kind has its own colour scheme and toolbar styling — override
`toolbarClassName` if your theme requires different colors.

## Adding a new node kind

```ts
import type { NodeKindDef } from "@/app/components/canvas/Canvas";

const MY_KIND: NodeKindDef = {
  kind: "my_kind",                // unique within the registry
  toolbarLabel: "+ My kind",
  toolbarClassName: "px-3 py-2 ...",
  component: MyKindNode,           // React Flow node component
  defaultLabel: "my new node",
  // Optional:
  // hideFromToolbar: true,
  // singleton: true,
  // sourceHandles: [{ id: "yes", label: "yes" }, { id: "no", label: "no" }],
  // inspector: {
  //   labelTitle: "Description",
  //   helpText: "Free text shown in the inspector help section.",
  //   textareaRows: 6,
  // },
};
```

## Wire format

```ts
interface CanvasDoc {
  version: 2;
  activeId: string;
  canvases: Array<{
    id: string;
    name: string;
    graph: { nodes: [...]; edges: [...] };
    freeText: string;
  }>;
}
```

This format is round-trippable as JSON. It is the source of truth — the
compiler's `output` is derived from it on every change and should never be
mutated independently.

## Persistence

The canvas is fully controlled. The caller persists `doc` wherever it
wants (a database row per canvas, a single JSON blob, a file, etc.) and
passes it back in on the next render. The shell has no persistence layer.

The caller is also responsible for any legacy-format migration. The policy
consumer, for example, parses an older markdown+JSON-comment encoding in
`app/components/policy/policy-serializer.ts` and supplies the result as
`doc` to the canvas.
