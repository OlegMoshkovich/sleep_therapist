import type { CanvasDoc } from "../components/canvas/types";
import type { ServerRef } from "../lib/tools/types";

export type FieldType = "string" | "integer" | "number" | "boolean" | "string[]" | "json";

export const FIELD_TYPES: FieldType[] = [
  "string",
  "integer",
  "number",
  "boolean",
  "string[]",
  "json",
];

export interface StateField {
  id: string;
  name: string;
  type: FieldType;
  initialValue: string;
}

export interface KnowledgeBlock {
  id: string;
  topic: string;
  content: string;
}

export const SEED_DOC: CanvasDoc = {
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
            position: { x: 200, y: 20 },
            data: {
              label:
                "You are a helpful assistant. Use a tool only when its trigger condition fits the user's message; otherwise answer directly. If you used the Wikipedia lookup, cite it briefly in your answer.",
            },
          },
          {
            id: "cond_topic",
            type: "condition",
            position: { x: 200, y: 200 },
            data: {
              label: "the user is asking about a topic, person, place, or concept",
            },
          },
          {
            id: "wiki",
            type: "tool_call",
            position: { x: 40, y: 380 },
            data: {
              label: "ground the answer in Wikipedia",
              // The alias the model sees — independent of the remote tool name.
              toolName: "lookup_wikipedia",
              description:
                "Look up the Wikipedia summary for a topic. Returns title, extract, and canonical URL.",
              // The tool is a REFERENCE, not an implementation: { server, tool }
              // coordinates resolved at runtime against the servers map below.
              // The implementation lives in the external `wikipedia-mcp` server,
              // never bundled. "readArticle" is the tool that server exposes; it
              // takes a `title` and returns the article as markdown.
              sourceType: "mcp",
              ref: { server: "wikipedia", tool: "readArticle" },
              // Optional REST fallback: used only when the MCP server can't be
              // reached (so the demo runs out of the box).
              url: "https://en.wikipedia.org/api/rest_v1/page/summary/{title}",
              paramsSchema:
                '{ "title": { "type": "string", "description": "Wikipedia page title, e.g. Albert Einstein" } }',
            },
          },
          {
            id: "cond_save",
            type: "condition",
            position: { x: 200, y: 560 },
            data: {
              label:
                "the user said \"this is relevant for me\" or otherwise asked to remember or save something",
            },
          },
          {
            id: "save",
            type: "tool_call",
            position: { x: 40, y: 740 },
            data: {
              label: "persist what should be remembered as a Domain Knowledge note",
              toolName: "save_summary",
              description:
                "Save a short note to Domain Knowledge so it can be retrieved later. The note appears in the Domain Knowledge panel and feeds back into the system prompt on later turns.",
              sourceType: "knowledge_save",
              paramsSchema:
                '{ "summary": { "type": "string", "description": "A short note capturing what the user wants to remember, ideally in your own words (1-2 sentences)." } }',
            },
          },
          {
            id: "end",
            type: "prompt",
            position: { x: 200, y: 920 },
            data: { label: "answer the user", actionType: "prompt" },
          },
        ],
        edges: [
          { id: "e1", source: "start", target: "cond_topic", sourceHandle: null },
          { id: "e2", source: "cond_topic", target: "wiki", sourceHandle: "true" },
          { id: "e3", source: "cond_topic", target: "cond_save", sourceHandle: "false" },
          { id: "e4", source: "wiki", target: "cond_save", sourceHandle: null },
          { id: "e5", source: "cond_save", target: "save", sourceHandle: "true" },
          { id: "e6", source: "cond_save", target: "end", sourceHandle: "false" },
          { id: "e7", source: "save", target: "end", sourceHandle: null },
        ],
      },
    },
    {
      id: "corpus",
      name: "Corpus (B1)",
      freeText: "",
      graph: {
        nodes: [
          {
            id: "c_start",
            type: "start",
            position: { x: 200, y: 20 },
            data: {
              label:
                "You are a helpful assistant grounded in an uploaded document corpus. When the user's question can be answered from the documents, call search_documents and answer ONLY from the returned passages, citing them by their [n] index. If nothing relevant is returned, say so. For anything outside the documents, answer normally.",
            },
          },
          {
            id: "c_relevant",
            type: "condition",
            position: { x: 200, y: 200 },
            data: {
              // B1 — the relevance gate is judged by the model, not an authored
              // topic list. When true, the engine guarantees retrieval + answer.
              label: "the user's question can be answered from the uploaded documents",
            },
          },
          {
            id: "c_search",
            type: "tool_call",
            position: { x: 40, y: 380 },
            data: {
              label: "retrieve relevant passages from the corpus",
              toolName: "search_documents",
              description:
                "Search the uploaded document corpus and return the most relevant passages for the user's question.",
              // Same binding shape as Wikipedia — a { server, tool } reference
              // resolved against SEED_SERVERS.corpus. No REST fallback: the
              // corpus is private.
              sourceType: "mcp",
              ref: { server: "corpus", tool: "search_documents" },
              paramsSchema:
                '{ "query": { "type": "string", "description": "The question text, used to search the corpus" } }',
            },
          },
          {
            id: "c_end",
            type: "prompt",
            position: { x: 200, y: 560 },
            data: {
              label: "answer the user from the retrieved passages",
              actionType: "prompt",
            },
          },
        ],
        edges: [
          { id: "ce1", source: "c_start", target: "c_relevant", sourceHandle: null },
          { id: "ce2", source: "c_relevant", target: "c_search", sourceHandle: "true" },
          { id: "ce3", source: "c_relevant", target: "c_end", sourceHandle: "false" },
          { id: "ce4", source: "c_search", target: "c_end", sourceHandle: null },
        ],
      },
    },
    {
      id: "memory",
      name: "Memory (knowledge graph)",
      freeText: "",
      graph: {
        nodes: [
          {
            id: "m_start",
            type: "start",
            position: { x: 200, y: 20 },
            data: {
              label:
                "You are a helpful assistant with a persistent memory that survives across sessions, backed by a knowledge graph of entities (people, projects, preferences) and relations between them. When the user shares durable facts about themselves or their world, save them as entities/observations. Before answering anything that may depend on what you've been told before, recall from memory first. Weave recalled facts in naturally; don't announce that you're reading memory.",
            },
          },
          {
            id: "m_recall",
            type: "condition",
            position: { x: 200, y: 200 },
            data: {
              // Recall runs first: a new turn may depend on memory from an
              // earlier session, so query the graph before answering.
              label:
                "answering well could depend on something the user told you earlier (their name, preferences, people, or ongoing projects)",
            },
          },
          {
            id: "m_search",
            type: "tool_call",
            position: { x: 40, y: 380 },
            data: {
              label: "recall what you already know from long-term memory",
              toolName: "recall_memory",
              description:
                "Read everything in long-term memory (all stored entities and relations) so you can answer from what you already know about the user. Takes no arguments — prefer this over guessing a search query.",
              // Same binding shape as Wikipedia/Corpus: a { server, tool }
              // reference resolved against SEED_SERVERS.memory. "read_graph"
              // returns the whole graph — more reliable for personal recall than
              // a keyword search the model has to invent. No REST fallback — the
              // graph is private and stateful.
              sourceType: "mcp",
              ref: { server: "memory", tool: "read_graph" },
              paramsSchema: "{}",
            },
          },
          {
            id: "m_remember",
            type: "condition",
            position: { x: 200, y: 560 },
            data: {
              label:
                "the user shared a durable fact worth remembering across sessions (who they are, a stable preference, a person, or a project)",
            },
          },
          {
            id: "m_save",
            type: "tool_call",
            position: { x: 40, y: 740 },
            data: {
              label: "store the new facts as entities in the knowledge graph",
              toolName: "save_memory",
              description:
                "Save new entities (named nodes with a type and observations) to long-term memory so they can be recalled in later sessions. Group facts under the entity they describe.",
              sourceType: "mcp",
              ref: { server: "memory", tool: "create_entities" },
              paramsSchema:
                '{ "entities": { "type": "array", "description": "The entities to remember. Reuse an existing entity name to group related facts.", "items": { "type": "object", "properties": { "name": { "type": "string", "description": "A unique, stable name for the entity (e.g. the user\'s name or a project title)" }, "entityType": { "type": "string", "description": "The kind of entity, e.g. person, preference, project, place" }, "observations": { "type": "array", "items": { "type": "string" }, "description": "Short, self-contained facts about this entity" } }, "required": ["name", "entityType", "observations"] } } }',
            },
          },
          {
            id: "m_end",
            type: "prompt",
            position: { x: 200, y: 920 },
            data: {
              label: "answer the user, grounded in what you recalled",
              actionType: "prompt",
            },
          },
        ],
        edges: [
          { id: "me1", source: "m_start", target: "m_recall", sourceHandle: null },
          { id: "me2", source: "m_recall", target: "m_search", sourceHandle: "true" },
          { id: "me3", source: "m_recall", target: "m_remember", sourceHandle: "false" },
          { id: "me4", source: "m_search", target: "m_remember", sourceHandle: null },
          { id: "me5", source: "m_remember", target: "m_save", sourceHandle: "true" },
          { id: "me6", source: "m_remember", target: "m_end", sourceHandle: "false" },
          { id: "me7", source: "m_save", target: "m_end", sourceHandle: null },
        ],
      },
    },
    {
      id: "playwright",
      name: "Playwright browser",
      freeText: "",
      graph: {
        nodes: [
          {
            id: "p_start",
            type: "start",
            position: { x: 200, y: 20 },
            data: {
              label:
                "You are a helpful assistant that can drive a real web browser when a question depends on a specific live webpage. When the user asks about a page or names a URL, navigate to it and read it (snapshot the accessibility tree), then answer from what you actually saw. Quote or cite the URL. For anything that doesn't need browsing, answer normally.",
            },
          },
          {
            id: "p_cond",
            type: "condition",
            position: { x: 200, y: 200 },
            data: {
              label:
                "the user's question depends on a specific live webpage (a URL they named, or a page that needs to be checked right now)",
            },
          },
          {
            id: "p_nav",
            type: "tool_call",
            position: { x: 40, y: 380 },
            data: {
              label: "open the page in a real Chromium browser",
              toolName: "browse_open",
              description:
                "Navigate the browser to a URL. Always call this before browse_read so the snapshot reflects the right page. The page stays open in the browser session for the next tool call.",
              // Reference, not implementation: { server, tool } resolved against
              // SEED_SERVERS.playwright. browser_navigate is the tool name the
              // public @playwright/mcp server exposes; it takes a `url`.
              sourceType: "mcp",
              ref: { server: "playwright", tool: "browser_navigate" },
              paramsSchema:
                '{ "url": { "type": "string", "description": "The full URL to open, e.g. https://example.com" } }',
            },
          },
          {
            id: "p_snap",
            type: "tool_call",
            position: { x: 40, y: 560 },
            data: {
              label: "read what's on the page",
              toolName: "browse_read",
              description:
                "Capture the accessibility tree of the currently open page (after browse_open). Returns a structured snapshot of the headings, links, text, and form controls the user would see. Use this as your source of truth for answering questions about the page.",
              sourceType: "mcp",
              ref: { server: "playwright", tool: "browser_snapshot" },
              // browser_snapshot takes no arguments — the canvas compiler still
              // requires a (possibly empty) schema string.
              paramsSchema: "{}",
            },
          },
          {
            id: "p_end",
            type: "prompt",
            position: { x: 200, y: 740 },
            data: {
              label: "answer the user from the page you read, and cite the URL",
              actionType: "prompt",
            },
          },
        ],
        edges: [
          { id: "pe1", source: "p_start", target: "p_cond", sourceHandle: null },
          { id: "pe2", source: "p_cond", target: "p_nav", sourceHandle: "true" },
          { id: "pe3", source: "p_cond", target: "p_end", sourceHandle: "false" },
          // Sequential: after navigating, always snapshot before answering.
          { id: "pe4", source: "p_nav", target: "p_snap", sourceHandle: null },
          { id: "pe5", source: "p_snap", target: "p_end", sourceHandle: null },
        ],
      },
    },
  ],
};

// Servers map (policy layer): a logical server name resolves to where the MCP
// server actually lives. A binding names { server, tool }; this map says where
// "server" lives, so the policy can be re-pointed without rewriting any
// binding. Resolution order for "wikipedia" (see app/lib/tools/servers.ts):
//   1. WIKIPEDIA_MCP_SERVER_URL — a hosted Streamable-HTTP MCP endpoint. The
//      in-repo server at /api/mcp/wikipedia is the intended target and works on
//      serverless/edge; set the var to e.g. https://<deployment>/api/mcp/wikipedia.
//   2. stdio `npx wikipedia-mcp` — the public server run locally as a
//      subprocess (dev / self-hosted Node). Referenced, not bundled.
//   3. the binding's REST fallback — so the demo never hard-breaks.
// Env values are resolved server-side so endpoints/tokens never live in
// client-persisted policy data.
export const SEED_SERVERS: Record<string, ServerRef> = {
  wikipedia: {
    url: "env:WIKIPEDIA_MCP_SERVER_URL",
    command: "npx",
    args: ["-y", "wikipedia-mcp"],
    auth: { type: "none" },
  },
  // Corpus RAG (Case B1). The in-repo server at /api/mcp/corpus is the target;
  // set CORPUS_MCP_SERVER_URL to e.g. https://<deployment>/api/mcp/corpus. The
  // bearer token doubles as the corpus_id in this first slice (the server reads
  // it from the Authorization header), so CORPUS_MCP_TOKEN selects which
  // uploaded corpus the agent reads. No REST/stdio fallback — the corpus is
  // private, so an unresolved server simply yields no grounding.
  corpus: {
    url: "env:CORPUS_MCP_SERVER_URL",
    auth: { type: "bearer", token: "env:CORPUS_MCP_TOKEN" },
  },
  // Memory knowledge graph. The in-repo server at /api/mcp/memory is the target;
  // set MEMORY_MCP_SERVER_URL to e.g. https://<deployment>/api/mcp/memory. Like
  // the corpus, the bearer token doubles as the namespace (the server reads it
  // from the Authorization header), so MEMORY_MCP_TOKEN selects whose memory the
  // agent reads and writes. No REST/stdio fallback — the graph is private and
  // stateful, so an unresolved server simply yields no memory (the agent stays
  // alive and answers without it).
  memory: {
    url: "env:MEMORY_MCP_SERVER_URL",
    auth: { type: "bearer", token: "env:MEMORY_MCP_TOKEN" },
  },
  // Playwright browser (Microsoft's @playwright/mcp). The server drives a real
  // Chromium instance, so it can only run where Chromium is available — local
  // dev, or a self-hosted MCP server with browsers installed. NOT on Vercel
  // serverless (no Chromium runtime, no persistent process). Resolution order:
  //   1. PLAYWRIGHT_MCP_SERVER_URL — a hosted Streamable-HTTP MCP endpoint
  //      (run `npx @playwright/mcp --port 8931` or the Docker image — see
  //      deploy/playwright-mcp/ — and point this at e.g. https://<host>/mcp).
  //      Optionally protect that host behind a token-checking proxy and set
  //      PLAYWRIGHT_MCP_TOKEN; when unset the bearer resolves to "none".
  //   2. stdio `npx @playwright/mcp@latest --headless` — the public server run
  //      locally as a subprocess. Referenced, not bundled; npx fetches it on
  //      first call. Chromium is installed lazily by Playwright.
  // No REST fallback — browser automation has no equivalent HTTP shape, so an
  // unresolved server simply fails the tool call (the agent says it can't
  // browse and answers normally).
  playwright: {
    url: "env:PLAYWRIGHT_MCP_SERVER_URL",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--headless"],
    auth: { type: "bearer", token: "env:PLAYWRIGHT_MCP_TOKEN" },
  },
};

export const SEED_FIELDS: StateField[] = [
  { id: "topics_discussed", name: "topics_discussed", type: "string[]", initialValue: "[]" },
  { id: "user_focus", name: "user_focus", type: "string", initialValue: "(none yet)" },
  { id: "lookup_count", name: "lookup_count", type: "integer", initialValue: "0" },
  { id: "last_lookup_url", name: "last_lookup_url", type: "string", initialValue: "(none yet)" },
  { id: "tool_errors", name: "tool_errors", type: "integer", initialValue: "0" },
];

export const SEED_KNOWLEDGE: KnowledgeBlock[] = [
  {
    id: "citation",
    topic: "Citation rules",
    content:
      "When you use information from a lookup_wikipedia call, briefly mention that it comes from Wikipedia and, on a new line, link the article (e.g. https://en.wikipedia.org/wiki/<Article_Title>). If the result includes a canonical URL, use that.",
  },
  {
    id: "scope",
    topic: "Scope",
    content:
      "Only call lookup_wikipedia for stable, encyclopedic subjects (people, places, concepts, historical events). For current news, weather, opinions, personal advice, or anything time-sensitive, do not call the tool — say briefly that Wikipedia is not the right source and answer from your own knowledge instead.",
  },
  {
    id: "tone",
    topic: "Tone",
    content:
      "Keep answers under ~150 words unless the user asks for more depth. Lead with the single most important fact, then 2-4 bullet points. No filler.",
  },
];
