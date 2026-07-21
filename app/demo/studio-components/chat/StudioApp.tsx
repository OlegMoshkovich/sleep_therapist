"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasDoc, CanvasFireSignal } from "../../../components/canvas/Canvas";
import type { Turn, TimedTraceEvent } from "../../../components/trace/TraceView";
import { AuthProvider, useAuth } from "../../../context/AuthContext";
import AuthModal from "../../../components/AuthModal";
import SiteLogo from "../../../components/SiteLogo";
import {
  CHAT_MODEL_PREF_KEY,
  OPENAI_MODEL,
  isChatModelId,
  type ChatModelId,
} from "../../../lib/openai-config";
import { RightDrawer, type DrawerId } from "../RightDrawer";
import type { FeedbackEntry, FeedbackSignal } from "../FeedbackControls";
import type { SimRunControls } from "../SimulationPanel";
import { useVoiceRecorder, useTTS } from "../useVoice";
import { Ic } from "../ra-icons";
import { stripMarkdownForSpeech } from "./helpers";
import {
  ADMIN_ONLY_DRAWERS,
  MOBILE_DRAWER_TAB_KEY,
  MONO_PREF_KEY,
  PANEL_TABS,
  SIM_TITLE_PREFIX,
  TTS_PREF_KEY,
} from "./constants";
import { AccountPane } from "./AccountPane";
import {
  BottomCanvasDrawer,
  WORKFLOW_STAGE_POLICY_CANVAS,
  createBottomWorkflowSeed,
} from "./BottomCanvasDrawer";
import { BubbleFullscreen } from "./BubbleFullscreen";
import { ChatsPane } from "./ChatsPane";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { MobileNav } from "./MobileNav";
import { ResizeHandle } from "./ResizeHandle";
import { RightRail } from "./RightRail";
import { Sidebar, SidebarRail } from "./Sidebar";
import { SimControlsPill } from "./SimControlsPill";
import { TrainingPill } from "./TrainingPill";
import { MoveToV2Modal } from "./MoveToV2Modal";
import { Thread } from "./Thread";
import { ThreadHeader } from "./ThreadHeader";
import type { Conversation, Message, StudioChatConfig } from "./types";

export function StudioApp({ config }: { config: StudioChatConfig }) {
  const SetupBar = config.SetupBar;
  const SimulationPanel = config.SimulationPanel;
  const workflowSeed = useMemo(
    () => createBottomWorkflowSeed(config.emptyStatePrimaryAgent),
    [config.emptyStatePrimaryAgent]
  );
  const { user, isAdmin, signOut, roleLoaded } = useAuth();
  // The studio assembles behind the splash overlay; this flag tells the splash
  // when the initial data (role + conversations) is ready so it can fade out.
  const [convosLoaded, setConvosLoaded] = useState(false);
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Mirror of activeId that is safe to read from a long-lived closure (the
  // Simulation loop reuses one captured send() across turns). Kept in sync
  // below AND written synchronously in send() the moment a conversation is
  // created, so back-to-back sends target the same conversation.
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  // When set (by the Simulation panel), the next conversation send() creates is
  // titled as a simulation instead of using the first user message.
  const simulationTitleRef = useRef<string | null>(null);
  // The patient scenario that drove that run, saved on the conversation so
  // selecting the run later can repopulate the Patient scenario field.
  const simulationScenarioRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  // Black & white theme preference (persisted). Default ON — adds `.ra-mono`
  // to the root scope. Explicit "0" in localStorage keeps the greige palette.
  const [monoTheme, setMonoTheme] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem(MONO_PREF_KEY) !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(MONO_PREF_KEY, monoTheme ? "1" : "0");
    } catch {
      // ignore
    }
  }, [monoTheme]);
  // Voice: TTS auto-play preference (persisted to localStorage) and hooks.
  const [autoSpeak, setAutoSpeak] = useState(false);
  const autoSpeakRef = useRef(autoSpeak);
  useEffect(() => {
    autoSpeakRef.current = autoSpeak;
  }, [autoSpeak]);
  // Set true right before we kick off a send() so the next assistant message
  // triggers TTS. Cleared on conversation switch so historical loads don't play.
  const speakNextAssistantRef = useRef(false);
  const { speak, stop: stopSpeaking, isSpeaking } = useTTS();
  // Live description of what the server is doing this turn (streamed stage events),
  // shown in place of the anonymous typing dots.
  const [typingLabel, setTypingLabel] = useState("");
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  // "How to use the studio" help panel, anchored bottom-left of the sidebar.
  const [infoOpen, setInfoOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Thread chrome (Collapse all / Hide controls) — lifted so it can dock above
  // the composer input; TODAY stays at the top of the message list.
  const [collapsedByIdx, setCollapsedByIdx] = useState<Record<number, boolean>>({});
  const [hideBubbleControls, setHideBubbleControls] = useState(true);
  const [threadFullscreen, setThreadFullscreen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ChatModelId>(OPENAI_MODEL);
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(CHAT_MODEL_PREF_KEY);
      if (stored && isChatModelId(stored)) setSelectedModel(stored);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    setHideBubbleControls(true);
    setCollapsedByIdx({});
    setThreadFullscreen(false);
  }, [activeId]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 900px)");
    const sync = () => { if (mq.matches) setHideBubbleControls(true); };
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  // Bottom canvas drawer: a full-width sheet that slides up from the bottom and
  // hosts a Canvas editor. Its doc and height are kept here so they survive
  // open/close.
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [canvasDoc, setCanvasDoc] = useState<CanvasDoc | null>(null);
  // Workflow persistence: the overview canvas is stored as `workflow_canvases`
  // on the sleep setup config. Load it once so edits survive reload, and expose
  // a Save that PUTs it back (the endpoint needs `config`, so we round-trip it).
  const [workflowSaving, setWorkflowSaving] = useState(false);
  const [workflowSaved, setWorkflowSaved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/setup/${config.apiTopic}`);
        if (!res.ok) return;
        const { workflowCanvases } = (await res.json()) as {
          workflowCanvases?: Array<{ canvas_id?: string; name?: string; sort_order?: number; canvas: CanvasDoc["canvases"][number] }>;
        };
        if (cancelled || !Array.isArray(workflowCanvases) || workflowCanvases.length === 0) return;
        const canvases = [...workflowCanvases]
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map((row) => ({ ...row.canvas, id: row.canvas_id || row.canvas.id, name: row.name || row.canvas.name }));
        setCanvasDoc({ version: 2, activeId: canvases[0].id, canvases });
      } catch {
        /* keep the seeded default */
      }
    })();
    return () => { cancelled = true; };
  }, [config.apiTopic]);
  const saveWorkflow = useCallback(async () => {
    if (!canvasDoc || workflowSaving) return;
    setWorkflowSaving(true);
    try {
      // The PUT requires `config`; fetch the current one so we don't clobber it.
      const cur = await fetch(`/api/admin/setup/${config.apiTopic}`);
      const setupConfig = (cur.ok ? (await cur.json())?.config : null) ?? {};
      const workflowCanvases = canvasDoc.canvases.map((canvas, index) => ({
        canvas_id: canvas.id,
        name: canvas.name,
        sort_order: index,
        canvas,
      }));
      const res = await fetch(`/api/admin/setup/${config.apiTopic}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: setupConfig, workflowCanvases }),
      });
      if (res.ok) {
        setWorkflowSaved(true);
        setTimeout(() => setWorkflowSaved(false), 1800);
      }
    } catch {
      /* best-effort */
    } finally {
      setWorkflowSaving(false);
    }
  }, [canvasDoc, workflowSaving, config.apiTopic]);
  // Bottom workflow drawer: open at ~1/3 of the viewport height.
  const [canvasHeight, setCanvasHeight] = useState(360);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setCanvasHeight(Math.round(window.innerHeight / 3));
  }, []);
  // When the bottom drawer opens/resizes, nudge fillHeight canvases (e.g. the
  // Policy canvas in the right drawer) to re-measure against the newly reserved
  // bottom space. They listen for window resize; dispatch one after layout.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(id);
  }, [canvasOpen, canvasHeight]);
  // Secondary right-side panels share ONE drawer; multiple open ones become tabs.
  const [openDrawers, setOpenDrawers] = useState<DrawerId[]>([]);
  const [activeDrawer, setActiveDrawer] = useState<DrawerId | null>(null);
  // Live simulation controls, lifted from SimulationPanel so Pause/Stop can dock
  // in the drawer tab bar (next to ×) while a run is in progress — or float when
  // the drawer is closed so the run stays controllable.
  const [simRunControls, setSimRunControls] = useState<SimRunControls | null>(null);
  // Stable identity — SimulationPanel's effect depends on onRunControls; an
  // inline arrow would change every render and loop setState ("Maximum update depth").
  const onSimRunControls = useCallback(
    (controls: SimRunControls | null) => setSimRunControls(controls),
    []
  );
  const [simControlsCollapsed, setSimControlsCollapsed] = useState(false);
  const [v2Training, setV2Training] = useState(false);
  const [v2ModalOpen, setV2ModalOpen] = useState(false);
  const [v2ModalTraining, setV2ModalTraining] = useState(false);
  const openV2Modal = useCallback((asTraining = false) => {
    setV2ModalTraining(asTraining);
    setV2ModalOpen(true);
  }, []);
  useEffect(() => {
    if (!simRunControls) setSimControlsCollapsed(false);
  }, [simRunControls]);
  // Closing the side drawer mid-run collapses the floating pill to "Running"/"Paused".
  const prevOpenDrawersLenRef = useRef(0);
  useEffect(() => {
    const wasOpen = prevOpenDrawersLenRef.current > 0;
    prevOpenDrawersLenRef.current = openDrawers.length;
    if (wasOpen && openDrawers.length === 0 && simRunControls) {
      setSimControlsCollapsed(true);
    }
  }, [openDrawers.length, simRunControls]);
  // The Model Setup pane's container inside the drawer. The page-level SetupBar
  // portals its docked view here; keeping SetupBar mounted at the page level (not
  // inside the drawer) lets its popped-out floating window survive drawer close.
  const [modelSetupSlot, setModelSetupSlot] = useState<HTMLElement | null>(null);
  // Simulation pane slot — same pattern as Model Setup so a live run survives
  // the drawer closing.
  const [simulationSlot, setSimulationSlot] = useState<HTMLElement | null>(null);
  // Height reserved at the top of the frame for the top-docked Model Setup window
  // so the chat and side panels reflow below it instead of hiding behind it.
  const [topDockH, setTopDockH] = useState(0);
  const openDrawer = useCallback((id: DrawerId) => {
    // Non-admins can never open the internal panels, even if some stray caller
    // asks for one.
    if (!isAdmin && ADMIN_ONLY_DRAWERS.includes(id)) return;
    // Opening any function panel opens the whole set, so the desktop drawer
    // always shows all tabs (the clicked one becomes active). Non-admins get the
    // set with the admin-only panels filtered out. Chats/Account are mobile-only
    // sheet tabs and open on their own.
    if (PANEL_TABS.includes(id)) {
      const panelTabs = isAdmin
        ? PANEL_TABS
        : PANEL_TABS.filter((d) => !ADMIN_ONLY_DRAWERS.includes(d));
      setOpenDrawers((prev) => {
        const extras = prev.filter((d) => !PANEL_TABS.includes(d));
        return [...panelTabs, ...extras];
      });
    } else {
      setOpenDrawers((prev) => (prev.includes(id) ? prev : [...prev, id]));
    }
    setActiveDrawer(id);
  }, [isAdmin]);
  const closeDrawer = useCallback((id: DrawerId) => {
    setOpenDrawers((prev) => {
      const next = prev.filter((d) => d !== id);
      setActiveDrawer((cur) => (cur === id ? next[next.length - 1] ?? null : cur));
      return next;
    });
  }, []);
  const closeAllDrawers = useCallback(() => {
    setOpenDrawers([]);
    setActiveDrawer(null);
  }, []);
  // Mobile bottom-sheet: remember the last tab the user was on and reopen the
  // sheet there. Defaults to Model Setup on the first ever open. Only the single
  // mobile hamburger uses this; desktop still opens a specific panel per click.
  const rememberedMobileTabRef = useRef<DrawerId>("modelsetup");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(MOBILE_DRAWER_TAB_KEY) as DrawerId | null;
      if (saved) rememberedMobileTabRef.current = saved;
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    // Only remember tabs that actually exist in the mobile sheet.
    if (!activeDrawer || activeDrawer === "expert" || activeDrawer === "upload") return;
    rememberedMobileTabRef.current = activeDrawer;
    try {
      localStorage.setItem(MOBILE_DRAWER_TAB_KEY, activeDrawer);
    } catch {
      /* ignore */
    }
  }, [activeDrawer]);
  const openMobileDrawer = useCallback(() => {
    let target = rememberedMobileTabRef.current;
    // Non-admins never get the internal panels; fall back to Chats.
    if (!isAdmin && ADMIN_ONLY_DRAWERS.includes(target)) target = "chats";
    openDrawer(target);
  }, [openDrawer, isAdmin]);
  const [turns, setTurns] = useState<Turn[]>([]); // observability trace, one per send
  // Turn ids that extracted at least one piece of state this turn — drives which
  // replies show a "State" button (and it highlights those exact fields).
  const stateTurnIds = useMemo(
    () => new Set(config.turnExtractedStateKeys(turns).keys()),
    [turns, config.turnExtractedStateKeys]
  );
  // The latest completed turn (drives the live workflow-stage highlight).
  const lastCompletedTurn = useMemo<Turn | null>(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.finalAnswer != null || t.error != null) return t;
    }
    return null;
  }, [turns]);
  // Clicking an assistant bubble opens Observability and expands that turn's
  // trace. `n` bumps on every click so re-clicking the same bubble re-focuses.
  const [traceFocus, setTraceFocus] = useState<{ id: string; n: number }>({
    id: "",
    n: 0,
  });
  const focusTrace = useCallback(
    (turnId: string) => {
      if (!isAdmin) return; // Observability is admin-only.
      setTraceFocus((prev) => ({ id: turnId, n: prev.n + 1 }));
      openDrawer("observability");
    },
    [isAdmin, openDrawer]
  );
  // Policy-canvas trace focus: clicking a reply's "Policy trace" button opens
  // Model Setup (which lands on Policy) and re-animates that specific turn's path
  // on the canvas. `n` bumps each click so re-clicking the same reply re-fires.
  const [policyFocus, setPolicyFocus] = useState<{ id: string; n: number }>({
    id: "",
    n: 0,
  });
  const focusPolicy = useCallback(
    (turnId: string) => {
      if (!isAdmin) return; // Model Setup / Policy is admin-only.
      openDrawer("modelsetup");
      // Also open the workflow so its stage highlight (following this turn) is visible.
      setCanvasOpen(true);
      setPolicyFocus((prev) => ({ id: turnId, n: prev.n + 1 }));
    },
    [isAdmin, openDrawer]
  );
  // Workflow-stage highlight: normally the latest completed turn, but when a
  // reply's Policy trace is opened, it follows THAT turn — so the Overall Workflow
  // canvas highlights the stage the traced node belongs to.
  const workflowTurn = useMemo<Turn | null>(() => {
    if (policyFocus.id) {
      const t = turns.find((x) => x.id === policyFocus.id);
      if (t) return t;
    }
    return lastCompletedTurn;
  }, [policyFocus.id, turns, lastCompletedTurn]);
  const workflowFireSignal = useMemo<CanvasFireSignal | null>(() => {
    const stage = config.deriveWorkflowStage(workflowTurn);
    if (!stage || !workflowTurn) return null;
    // Find the stage node by workflowStageId in the live doc (seed or saved).
    const wfDoc = canvasDoc ?? workflowSeed;
    for (const canvas of wfDoc.canvases) {
      const node = canvas.graph.nodes.find(
        (n) => (n.data as Record<string, unknown>)?.workflowStageId === stage
      );
      if (node) {
        return {
          // Include the focus nonce so re-clicking a bubble's Policy trace re-fires.
          id: `${workflowTurn.id}#wf-${stage}#${policyFocus.n}`,
          tools: [],
          exactNodeRefs: [{ nodeId: node.id, canvasId: canvas.id }],
        };
      }
    }
    return null;
  }, [workflowTurn, canvasDoc, policyFocus.n, workflowSeed]);
  // State-panel focus: clicking a reply's "State" button opens Model Setup on the
  // State section and highlights the fields that reply extracted.
  const [stateFocus, setStateFocus] = useState<{ id: string; n: number }>({
    id: "",
    n: 0,
  });
  const focusState = useCallback(
    (turnId: string) => {
      if (!isAdmin) return; // Model Setup / State is admin-only.
      openDrawer("modelsetup");
      setStateFocus((prev) => ({ id: turnId, n: prev.n + 1 }));
    },
    [isAdmin, openDrawer]
  );
  // Clicking a workflow stage opens Model Setup → Policy and selects that stage's
  // dedicated policy canvas (Intake → Sleep Intake, Assess → Assess, …).
  const [policyCanvasSelect, setPolicyCanvasSelect] = useState<{ canvasId: string; n: number }>({
    canvasId: "",
    n: 0,
  });
  const onWorkflowStageClick = useCallback(
    (stageId: string) => {
      if (!isAdmin) return;
      const canvasId = WORKFLOW_STAGE_POLICY_CANVAS[stageId] ?? "main";
      openDrawer("modelsetup");
      setPolicyCanvasSelect((prev) => ({ canvasId, n: prev.n + 1 }));
    },
    [isAdmin, openDrawer]
  );
  const [feedbackMode, setFeedbackMode] = useState(false); // per-bubble feedback
  const [feedbackByIdx, setFeedbackByIdx] = useState<Record<number, FeedbackEntry[]>>({});
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(300); // px, resizable
  // Right drawer width. `null` means "use the CSS default" (half the screen, via
  // `--obs-w` falling back to 50vw) — so the drawer opens at half the screen by
  // default, immune to persistence/effect races. A number is set only once the
  // user actually drags to resize, and that px width is what we persist.
  const [obsWidth, setObsWidth] = useState<number | null>(null);
  // Right drawer resize bounds, derived from the viewport on mount (kept in state
  // to avoid touching `window` during SSR/hydration). `def` = half the screen.
  const [obsBounds, setObsBounds] = useState({ min: 320, max: 680, def: 400 });
  // restore persisted drawer widths (client-only, avoids hydration mismatch)
  useEffect(() => {
    const s = Number(localStorage.getItem("ra-sidebar-w"));
    if (s) setSidebarWidth(Math.max(240, Math.min(520, s)));
    // Half the screen is the default width; allow dragging up to 75% of it.
    const half = Math.round(window.innerWidth / 2);
    const min = 320;
    const max = Math.max(half, Math.round(window.innerWidth * 0.75));
    setObsBounds({ min, max, def: half });
    // Only adopt a persisted width if the user previously resized; otherwise stay
    // null so the CSS 50vw default applies.
    const o = Number(localStorage.getItem("ra-obs-w2"));
    if (o) setObsWidth(Math.max(min, Math.min(max, o)));
  }, []);
  useEffect(() => {
    localStorage.setItem("ra-sidebar-w", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    if (obsWidth != null) localStorage.setItem("ra-obs-w2", String(obsWidth));
  }, [obsWidth]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Hydrate TTS preference from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setAutoSpeak(window.localStorage.getItem(TTS_PREF_KEY) === "1");
    } catch {
      // localStorage may throw in private mode — safe to ignore.
    }
  }, []);

  // Persist TTS preference; stop any playing audio when the user turns it off.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(TTS_PREF_KEY, autoSpeak ? "1" : "0");
    } catch {
      // ignore
    }
    if (!autoSpeak) stopSpeaking();
  }, [autoSpeak, stopSpeaking]);

  // Play the newest assistant reply when speakNextAssistantRef was armed by send().
  // The flag ensures we only speak fresh replies, not history loaded on convo switch.
  useEffect(() => {
    if (!speakNextAssistantRef.current) return;
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "ai") return;
    speakNextAssistantRef.current = false;
    if (!autoSpeakRef.current) return;
    const clean = stripMarkdownForSpeech(last.text);
    if (clean) void speak(clean);
  }, [messages, speak]);

  // Voice input: browser SpeechRecognition streams interim text live while the
  // user speaks, MediaRecorder + Whisper produces the final canonical transcript
  // on stop, and any pre-existing typed input is preserved as a prefix.
  const voiceBaselineRef = useRef("");
  const joinVoice = (base: string, spoken: string) => {
    const b = base.trim();
    const s = spoken.trim();
    if (!b) return s;
    if (!s) return b;
    return `${b} ${s}`;
  };
  const { isRecording, isTranscribing, toggle: toggleMicInner } = useVoiceRecorder({
    onInterim: (text) => {
      setInput(joinVoice(voiceBaselineRef.current, text));
    },
    onTranscript: (text) => {
      const combined = joinVoice(voiceBaselineRef.current, text);
      voiceBaselineRef.current = "";
      void send(combined);
    },
    onError: (msg) => {
      // Roll the input back to whatever they had typed before hitting the mic
      // so a failed voice attempt doesn't destroy their draft.
      setInput(voiceBaselineRef.current);
      voiceBaselineRef.current = "";
      setMessages((prev) => [...prev, { role: "ai", text: `Voice input: ${msg}` }]);
    },
  });
  const toggleMic = useCallback(() => {
    // Snapshot the current typed input before we start recording so we can
    // (a) prefix live interim text with it, and (b) restore it on error.
    if (!isRecording) {
      voiceBaselineRef.current = input;
    }
    toggleMicInner();
  }, [isRecording, input, toggleMicInner]);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversations?topic=${config.apiTopic}`);
      if (!res.ok) { setConvos([]); return; }
      const { conversations } = (await res.json()) as {
        conversations: Array<{
          id: string;
          title: string;
          updated_at?: string;
          turn_count?: number;
          scenario?: string | null;
          has_feedback?: boolean;
        }>;
      };
      setConvos((conversations ?? []).map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updated_at,
        turnCount: c.turn_count,
        scenario: c.scenario,
        hasFeedback: !!c.has_feedback,
      })));
    } catch {
      setConvos([]);
    } finally {
      setConvosLoaded(true);
    }
  }, [config.apiTopic]);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  const loadMessages = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}/messages`);
      if (!res.ok) { setMessages([]); setTurns([]); return; }
      const { messages: rows } = (await res.json()) as {
        messages: Array<{
          id: string;
          role: string;
          content: string;
          created_at?: string;
          // Persisted per-turn observability metadata on assistant messages.
          trace?: {
            trace?: TimedTraceEvent[];
            nodeRefs?: { nodeId: string; canvasId?: string }[];
            state?: Record<string, unknown>;
          } | null;
        }>;
      };
      // Rebuild both the visible thread and the Observability `turns` so a
      // reopened conversation replays its trace and re-animates the policy canvas
      // (nodeRefs), instead of only working for messages sent this session.
      const rebuiltMessages: Message[] = [];
      const rebuiltTurns: Turn[] = [];
      let lastUserText = "";
      let lastUserIdx = -1;
      for (const m of rows ?? []) {
        if (m.role === "user") {
          lastUserText = m.content;
          rebuiltMessages.push({ role: "user", text: m.content });
          lastUserIdx = rebuiltMessages.length - 1;
          continue;
        }
        const meta = m.trace && typeof m.trace === "object" ? m.trace : null;
        let turnId: string | undefined;
        if (meta) {
          const startedAt = m.created_at ? Date.parse(m.created_at) : 0;
          turnId = m.id;
          rebuiltTurns.push({
            id: turnId,
            userMessage: lastUserText,
            startedAt,
            finalAnswer: m.content,
            state: meta.state,
            nodeRefs: meta.nodeRefs,
            trace: (meta.trace ?? []).map((e) => ({
              ...e,
              tMs: (e as { ts?: number }).ts ?? startedAt,
            })),
          });
          // Give the preceding patient message the same turn id so its bubble can
          // open the same turn's State/Feedback after a reload.
          if (lastUserIdx >= 0) rebuiltMessages[lastUserIdx].turnId = turnId;
        }
        rebuiltMessages.push({ role: "ai", text: m.content, turnId });
        lastUserIdx = -1;
      }
      setMessages(rebuiltMessages);
      setTurns(rebuiltTurns);
    } catch {
      setMessages([]);
      setTurns([]);
    }
  }, []);

  // Load any feedback already left on this conversation's bubbles. A message can
  // hold several signals (score, text_correction, correct_output, comment), so
  // entries are grouped into an array per message index.
  const loadFeedback = useCallback(async (id: string) => {
    setFeedbackByIdx({});
    try {
      const res = await fetch(`/api/feedback?conversationId=${encodeURIComponent(id)}`);
      if (!res.ok) return;
      const { feedback } = (await res.json()) as {
        feedback: Array<{
          message_index: number;
          rating: number | null;
          signal: FeedbackSignal | null;
          comment: string | null;
        }>;
      };
      const map: Record<number, FeedbackEntry[]> = {};
      for (const f of feedback ?? []) {
        (map[f.message_index] ??= []).push({
          rating: f.rating === 1 || f.rating === -1 ? f.rating : null,
          signal: f.signal ?? null,
          comment: f.comment ?? "",
        });
      }
      setFeedbackByIdx(map);
    } catch {
      /* best-effort — leave indicators empty */
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || typing) return;
      setInput("");
      // Any in-flight TTS should stop when the user sends a new message.
      stopSpeaking();
      // If voice replies are on, mark the next assistant message to be spoken.
      speakNextAssistantRef.current = autoSpeakRef.current;

      // Observability: ask the endpoint for the REAL server-side trace
      // (system prompt, model, every OpenAI round-trip) instead of faking it.
      const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      // Show the user message and open an observability turn up front, so even
      // a failure before the chat call (e.g. creating the conversation) is
      // visible in the thread and the trace — never a silent "nothing happens".
      // The user message shares the turn's id so its bubble can open the same
      // turn's State/Feedback (the state is extracted from what the patient said).
      setMessages((prev) => [...prev, { role: "user", text: trimmed, turnId }]);
      setTyping(true);
      setStreaming("");

      const startedAt = Date.now();
      setTurns((prev) => [
        ...prev,
        { id: turnId, userMessage: trimmed, startedAt, trace: [] },
      ]);
      const finishTurn = (patch: Partial<Turn>) =>
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, ...patch } : t))
        );

      try {
        let conversationId = activeIdRef.current;
        if (!conversationId) {
          const simTitle = simulationTitleRef.current;
          simulationTitleRef.current = null;
          const simScenario = simulationScenarioRef.current;
          simulationScenarioRef.current = null;
          const res = await fetch("/api/conversations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: simTitle ?? trimmed.slice(0, 60),
              topic: config.apiTopic,
              // Persist the scenario for simulation runs (null for hand-typed chats).
              ...(simScenario !== null ? { scenario: simScenario } : {}),
            }),
          });
          if (!res.ok) {
            throw new Error(`Couldn't start a conversation (HTTP ${res.status}).`);
          }
          const { id } = await res.json();
          conversationId = id as string;
          setActiveId(conversationId);
          // Write the ref synchronously so the next send() in a simulation loop
          // (which reuses this same closure) targets this conversation instead
          // of creating another one.
          activeIdRef.current = conversationId;
          await loadConversations();
        }

        setTypingLabel("Thinking…");
        const res = await fetch(`/api/chat/${config.apiTopic}/base`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            userMessage: trimmed,
            model: selectedModel,
            trace: true,
            stream: true,
          }),
        });
        if (!res.ok || !res.body) {
          throw new Error(`Chat request failed (HTTP ${res.status}).`);
        }

        // Read the SSE stream: "stage" events update the live description while the
        // turn runs; the single "result" event carries the final answer + trace.
        type ResultPayload = {
          content?: string;
          trace?: TimedTraceEvent[];
          state?: Record<string, unknown>;
          nodeRefs?: { nodeId: string; canvasId?: string }[];
        };
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let data: ResultPayload | null = null;
        let streamError: string | null = null;
        readLoop: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) >= 0) {
            const rawEvent = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const eventName = /^event: (.+)$/m.exec(rawEvent)?.[1];
            const dataLine = /^data: (.+)$/m.exec(rawEvent)?.[1];
            if (!dataLine) continue;
            const payload = JSON.parse(dataLine);
            if (eventName === "stage") {
              setTypingLabel(payload.text ?? "");
            } else if (eventName === "result") {
              data = payload as ResultPayload;
            } else if (eventName === "error") {
              streamError = payload.error ?? "Chat request failed.";
              break readLoop;
            }
          }
        }
        if (streamError) {
          throw new Error(streamError);
        }
        if (!data) {
          throw new Error("Chat request ended without a response.");
        }
        const answer = data.content ?? "";
        // Prefer the server-provided wall-clock (ts) so each row shows true
        // per-call latency; fall back to arrival time for older payloads.
        const stamped = (data.trace ?? []).map((e) => ({
          ...e,
          tMs: (e as { ts?: number }).ts ?? Date.now(),
        }));
        setMessages((prev) => [...prev, { role: "ai", text: answer, turnId }]);
        setStreaming("");
        loadConversations();
        finishTurn({
          finalAnswer: answer,
          trace: stamped,
          state: data.state,
          nodeRefs: data.nodeRefs,
        });
        return answer;
      } catch (err) {
        const message =
          err instanceof Error && err.message.trim()
            ? err.message.trim()
            : "Something went wrong while sending the message.";
        setMessages((prev) => [...prev, { role: "ai", text: message, turnId }]);
        setStreaming("");
        finishTurn({
          error: message,
          trace: [
            {
              kind: "openai_response",
              loop: 0,
              content: message,
              toolCalls: [],
              finishReason: "error",
              tMs: Date.now(),
            },
          ],
        });
        return message;
      } finally {
        setTyping(false);
        setTypingLabel("");
      }
    },
    [typing, loadConversations, stopSpeaking, selectedModel, config.apiTopic]
  );

  // Clears the thread + observability turns (which resets the policy-canvas trace
  // animation, since it's driven off the latest completed turn). Shared by the New
  // conversation button and by starting a simulation run.
  const resetConversation = () => {
    setActiveId(null);
    setMessages([]);
    setStreaming("");
    setInput("");
    setFeedbackByIdx({});
    setEditingIdx(null);
    setTurns([]); // reset the policy trace / observability
    speakNextAssistantRef.current = false;
    stopSpeaking();
  };
  const onNew = () => {
    resetConversation();
    setMenuOpen(false);
    // Start clean: hide all the panels (Model Setup / Observability / Simulation)
    // and the workflow canvas by default.
    closeAllDrawers();
    setCanvasOpen(false);
    setTimeout(() => inputRef.current?.focus(), 30);
  };
  // Start a fresh, empty conversation for a simulation run. The actual
  // conversation row is created lazily by the first send() (titled via
  // simulationTitleRef), so the whole run flows through the real chat pipeline —
  // messages land in the main window, the trace fills Observability, and the
  // policy canvas animates, exactly like a hand-typed conversation.
  const beginSimulation = useCallback(
    (scenario: string, turns: number) => {
      // Reset the thread + policy trace, but KEEP the Simulation panel open (unlike
      // the New conversation button, which hides the panels).
      resetConversation();
      // Title encodes the run's turn count + scenario so the Simulation panel's run
      // list can show them: "Simulation · {n} turns · {scenario}".
      const label = scenario.trim().slice(0, 80) || "Improvised patient";
      const plural = turns === 1 ? "turn" : "turns";
      simulationTitleRef.current = `Simulation · ${turns} ${plural} · ${label}`;
      // Save the exact scenario that drove the run (empty string for improvised).
      simulationScenarioRef.current = scenario;
    },
    // resetConversation is a stable inline function defined every render; the values
    // it touches are all setState/refs, so it's safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Simulation runs live in the Simulation panel's own list, not the main sidebar
  // conversation list. Split the conversations so each surface shows its own set.
  const simulationRuns = useMemo(
    () => convos.filter((c) => c.title.startsWith(SIM_TITLE_PREFIX)),
    [convos]
  );
  const regularConvos = useMemo(
    () => convos.filter((c) => !c.title.startsWith(SIM_TITLE_PREFIX)),
    [convos]
  );

  const onSelect = (id: string) => {
    setActiveId(id);
    setStreaming("");
    setEditingIdx(null);
    speakNextAssistantRef.current = false;
    stopSpeaking();
    loadMessages(id);
    loadFeedback(id);
    setMenuOpen(false);
  };
  const onRename = async (id: string, title: string) => {
    const next = title.trim();
    if (!next) return;
    // Optimistic — update the list immediately, then persist.
    setConvos((prev) => prev.map((c) => (c.id === id ? { ...c, title: next } : c)));
    try {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
    } catch {
      // network error — reload to resync titles with the server
      loadConversations();
    }
  };
  const onDelete = async (id: string) => {
    try {
      await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    } catch {
      // network error — fall through and remove locally anyway
    }
    setConvos((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) {
      setActiveId(null);
      setMessages([]);
      setStreaming("");
      setFeedbackByIdx({});
      setEditingIdx(null);
    }
  };

  const onDeleteMany = async (ids: string[]) => {
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) return;
    await Promise.all(
      unique.map(async (id) => {
        try {
          await fetch(`/api/conversations/${id}`, { method: "DELETE" });
        } catch {
          // network error — still drop locally
        }
      })
    );
    const removed = new Set(unique);
    setConvos((prev) => prev.filter((c) => !removed.has(c.id)));
    if (activeId && removed.has(activeId)) {
      setActiveId(null);
      setMessages([]);
      setStreaming("");
      setFeedbackByIdx({});
      setEditingIdx(null);
    }
  };

  // ── Per-bubble feedback ────────────────────────────────────────────────
  const onToggleFeedback = (index: number) =>
    setEditingIdx((prev) => (prev === index ? null : index));

  // Surfaces a failed feedback save/delete instead of letting it fail silently.
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  const onSaveFeedback = async (index: number, entries: FeedbackEntry[]) => {
    // Empty set means the expert cleared everything → treat as remove.
    if (entries.length === 0) {
      onRemoveFeedback(index);
      return;
    }
    const msg = messages[index];
    if (!activeId || !msg) {
      // No conversation to attach to yet — don't drop the input silently.
      setFeedbackError("Can't save feedback: no active conversation for this reply.");
      return;
    }
    // Optimistic update; reconciled/reverted based on the server response.
    setFeedbackByIdx((prev) => ({ ...prev, [index]: entries }));
    setEditingIdx(null);
    setFeedbackError(null);
    try {
      // Persist the full signal set; the server reconciles (upserts present
      // signals, deletes cleared ones).
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: activeId,
          messageIndex: index,
          messageRole: msg.role,
          messageExcerpt: msg.text,
          entries: entries.map((e) => ({
            signal: e.signal,
            rating: e.rating,
            comment: e.comment,
          })),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Feedback save failed (HTTP ${res.status}).`);
      }
      // Tint this conversation in the sidebar / Runs list.
      setConvos((prev) =>
        prev.map((c) => (c.id === activeId ? { ...c, hasFeedback: true } : c))
      );
    } catch (err) {
      console.error("[feedback] save failed", err);
      setFeedbackError(
        err instanceof Error ? err.message : "Feedback save failed. Please try again."
      );
    }
  };

  const onRemoveFeedback = async (index: number) => {
    const remaining = { ...feedbackByIdx };
    delete remaining[index];
    setFeedbackByIdx(remaining);
    setEditingIdx(null);
    if (!activeId) return;
    setFeedbackError(null);
    try {
      const res = await fetch(
        `/api/feedback?conversationId=${encodeURIComponent(activeId)}&messageIndex=${index}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Feedback delete failed (HTTP ${res.status}).`);
      }
      const stillHas = Object.values(remaining).some((e) => e.length > 0);
      if (!stillHas) {
        setConvos((prev) =>
          prev.map((c) => (c.id === activeId ? { ...c, hasFeedback: false } : c))
        );
      }
    } catch (err) {
      console.error("[feedback] delete failed", err);
      setFeedbackError(
        err instanceof Error ? err.message : "Feedback delete failed. Please try again."
      );
    }
  };

  return (
    <div
      className={"ra-scope" + (monoTheme ? " ra-mono" : "")}
      onClick={() => {
        if (menuOpen) setMenuOpen(false);
        if (infoOpen) setInfoOpen(false);
      }}
    >
      {/* Splash overlay covers the app while it assembles, then fades out. */}
      <StudioSplash ready={roleLoaded && convosLoaded} studioPath={config.studioPath} />
      {/* Reserve space at the top (Model Setup top-dock) and bottom (canvas
          drawer) so the rest of the UI reflows into the remaining area instead of
          being covered — the bottom drawer pushes the chat up rather than
          overlaying it. */}
      <div
        className="app-frame"
        style={{
          ...(topDockH ? { paddingTop: topDockH } : {}),
          ...(canvasOpen ? { paddingBottom: canvasHeight } : {}),
          // Tell fillHeight canvases above the drawer how much bottom space is
          // reserved, so they shrink to fit instead of running under the drawer.
          // The bottom drawer overrides this back to 0 for its own canvas (CSS).
          ["--rf-fill-reserve-bottom" as string]: canvasOpen ? `${canvasHeight}px` : "0px",
        }}
      >
        <div className="body">
          {sidebarOpen ? (
            <>
              <Sidebar
                productName={config.productName}
                convos={regularConvos}
                activeId={activeId}
                onSelect={onSelect}
                onNew={onNew}
                onDelete={onDelete}
                onDeleteMany={onDeleteMany}
                onRename={onRename}
                query={query}
                setQuery={setQuery}
                menuOpen={menuOpen}
                setMenuOpen={setMenuOpen}
                infoOpen={infoOpen}
                setInfoOpen={setInfoOpen}
                onClose={() => setSidebarOpen(false)}
                onToggleFeedbackMode={() => setFeedbackMode((m) => !m)}
                feedbackMode={feedbackMode}
                monoTheme={monoTheme}
                onToggleMono={() => setMonoTheme((v) => !v)}
                userEmail={user?.email ?? ""}
                userImage={user?.imageUrl}
                isAdmin={isAdmin}
                onSignOut={signOut}
                width={sidebarWidth}
              />
              <ResizeHandle
                side="right"
                width={sidebarWidth}
                setWidth={setSidebarWidth}
                min={240}
                max={520}
                def={300}
              />
            </>
          ) : (
            <SidebarRail onExpand={() => setSidebarOpen(true)} onNew={onNew} />
          )}
          <main className="main">
            {feedbackMode && (activeId || messages.length > 0) ? (
              <div style={{ display: "flex", justifyContent: "center", padding: "8px 0 0" }}>
                <span className="fb-banner">
                  Feedback mode — tap + under any message
                  <button onClick={() => { setFeedbackMode(false); setEditingIdx(null); }}>
                    Exit
                  </button>
                </span>
              </div>
            ) : null}
            {/* Show the thread as soon as there's a message, even before a
                conversation row exists — otherwise a failed conversation
                create would leave the user staring at the empty state. */}
            {activeId || messages.length > 0 ? (
              <ThreadHeader
                config={config}
                showThreadControls={messages.length > 0}
                hideBubbleControls={hideBubbleControls}
                onToggleHideBubbleControls={() => setHideBubbleControls((v) => !v)}
                allCollapsed={
                  messages.length > 0 && messages.every((_, i) => !!collapsedByIdx[i])
                }
                onToggleCollapseAll={() => {
                  if (messages.length > 0 && messages.every((_, i) => !!collapsedByIdx[i])) {
                    setCollapsedByIdx({});
                    return;
                  }
                  const next: Record<number, boolean> = {};
                  for (let i = 0; i < messages.length; i++) next[i] = true;
                  setCollapsedByIdx(next);
                }}
              />
            ) : null}
            {activeId || messages.length > 0 ? (
              <Thread
                config={config}
                messages={messages}
                typing={typing}
                typingLabel={typingLabel}
                streaming={streaming}
                feedbackMode={feedbackMode}
                feedbackByIdx={feedbackByIdx}
                editingIdx={editingIdx}
                onToggleFeedback={onToggleFeedback}
                onSaveFeedback={onSaveFeedback}
                onRemoveFeedback={onRemoveFeedback}
                onOpenTrace={isAdmin ? focusTrace : undefined}
                onOpenPolicy={isAdmin ? focusPolicy : undefined}
                onOpenState={isAdmin ? focusState : undefined}
                stateTurnIds={stateTurnIds}
                allowFeedback={isAdmin}
                collapsedByIdx={collapsedByIdx}
                setCollapsedByIdx={setCollapsedByIdx}
                hideBubbleControls={hideBubbleControls}
              />
            ) : (
              <EmptyState config={config} onSuggest={send} onUpload={() => openDrawer("upload")} compact={canvasOpen} />
            )}
            {feedbackError && (
              <div className="fb-error-toast" role="alert">
                <span>{feedbackError}</span>
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => setFeedbackError(null)}
                >
                  <Ic.Close size={14} />
                </button>
              </div>
            )}
            <Composer
              actionChips={config.actionChips}
              value={input}
              setValue={setInput}
              onSend={send}
              inputRef={inputRef}
              onExpertChat={() => openDrawer("expert")}
              onUpload={() => openDrawer("upload")}
              onMicToggle={toggleMic}
              isRecording={isRecording}
              isTranscribing={isTranscribing}
              autoSpeak={autoSpeak}
              onToggleAutoSpeak={() => setAutoSpeak((v) => !v)}
              isSpeaking={isSpeaking}
              onStopSpeaking={stopSpeaking}
              showThreadControls={messages.length > 0}
              onOpenThreadFullscreen={() => setThreadFullscreen(true)}
              selectedModel={selectedModel}
              onSelectModel={(model) => {
                setSelectedModel(model);
                try {
                  sessionStorage.setItem(CHAT_MODEL_PREF_KEY, model);
                } catch {
                  /* ignore */
                }
              }}
              onOpenV2Modal={() => openV2Modal(v2Training)}
            />
            {threadFullscreen && messages.length > 0 ? (
              <BubbleFullscreen
                productName={config.productName}
                messages={messages}
                startIndex={0}
                feedbackMode={feedbackMode}
                feedbackByIdx={feedbackByIdx}
                onSubmitFeedbackAt={isAdmin ? onSaveFeedback : undefined}
                onClose={() => setThreadFullscreen(false)}
              />
            ) : null}
          </main>

          {/* Right rail: Workflow launcher; admins also get Model Setup.
              Docked at the right edge when no drawer is open; when a drawer IS
              open it floats at the drawer's left edge and tracks its width. */}
          <RightRail
            panelOpen={openDrawers.length > 0}
            onTogglePanel={() =>
              openDrawers.length > 0 ? closeAllDrawers() : openDrawer("modelsetup")
            }
            isAdmin={isAdmin}
            canvasOpen={canvasOpen}
            onToggleCanvas={() => setCanvasOpen((v) => !v)}
            floating={openDrawers.length > 0}
            rightOffset={obsWidth ?? obsBounds.def}
          />
          {openDrawers.length === 0 && (
            <MobileNav
              onOpen={openMobileDrawer}
              isAdmin={isAdmin}
              showThreadControls={messages.length > 0}
              allCollapsed={
                messages.length > 0 && messages.every((_, i) => !!collapsedByIdx[i])
              }
              onToggleCollapseAll={() => {
                if (messages.length > 0 && messages.every((_, i) => !!collapsedByIdx[i])) {
                  setCollapsedByIdx({});
                  return;
                }
                const next: Record<number, boolean> = {};
                for (let i = 0; i < messages.length; i++) next[i] = true;
                setCollapsedByIdx(next);
              }}
              hideBubbleControls={hideBubbleControls}
              onToggleHideBubbleControls={() => setHideBubbleControls((v) => !v)}
              onOpenThreadFullscreen={() => setThreadFullscreen(true)}
              selectedModel={selectedModel}
              onSelectModel={(model) => {
                setSelectedModel(model);
                try {
                  sessionStorage.setItem(CHAT_MODEL_PREF_KEY, model);
                } catch {
                  /* ignore */
                }
              }}
              onOpenV2Modal={() => openV2Modal(v2Training)}
            />
          )}
          {openDrawers.length > 0 && (
            <ResizeHandle
              side="left"
              width={obsWidth ?? obsBounds.def}
              setWidth={setObsWidth}
              min={obsBounds.min}
              max={obsBounds.max}
              def={obsBounds.def}
            />
          )}
          <RightDrawer
            open={openDrawers}
            active={activeDrawer}
            setActive={setActiveDrawer}
            onClose={closeDrawer}
            isAdmin={isAdmin}
            turns={turns}
            onClearTurns={() => setTurns([])}
            traceFocus={traceFocus}
            width={obsWidth ?? undefined}
            onDismiss={closeAllDrawers}
            chatsContent={
              <ChatsPane
                convos={regularConvos}
                activeId={activeId}
                onSelect={(id) => { onSelect(id); closeDrawer("chats"); }}
                onNew={() => { onNew(); closeDrawer("chats"); }}
                onDelete={onDelete}
                onDeleteMany={onDeleteMany}
                onRename={onRename}
                query={query}
                setQuery={setQuery}
              />
            }
            accountContent={
              <AccountPane
                userEmail={user?.email ?? ""}
                userImage={user?.imageUrl}
                isAdmin={isAdmin}
                feedbackMode={feedbackMode}
                monoTheme={monoTheme}
                onToggleMono={() => setMonoTheme((v) => !v)}
                onToggleFeedbackMode={() => { setFeedbackMode((m) => !m); closeDrawer("account"); }}
                onSignOut={signOut}
              />
            }
            modelSetupContent={<div className="drawer-pane" ref={setModelSetupSlot} />}
            simulationContent={<div className="drawer-pane" ref={setSimulationSlot} />}
            tabBarControls={
              simRunControls ? (
                <SimControlsPill
                  controls={simRunControls}
                  collapsed={simControlsCollapsed}
                  onToggleCollapsed={() => setSimControlsCollapsed((v) => !v)}
                />
              ) : null
            }
            activeConversationId={activeId}
          />
          {/* Same pill, floated when the drawer is closed mid-run. */}
          {simRunControls && openDrawers.length === 0 && (
            <SimControlsPill
              controls={simRunControls}
              collapsed={simControlsCollapsed}
              onToggleCollapsed={() => setSimControlsCollapsed((v) => !v)}
              floating
            />
          )}
          {v2Training && (
            <TrainingPill floating onClick={() => openV2Modal(true)} />
          )}
          {v2ModalOpen && (
            <MoveToV2Modal
              apiTopic={config.apiTopic}
              initialTraining={v2ModalTraining}
              onClose={() => setV2ModalOpen(false)}
              onTrainingStarted={() => setV2Training(true)}
              onTrainingStopped={() => setV2Training(false)}
            />
          )}
          {/* SetupBar is mounted here (page level), not inside the drawer, so its
              popped-out floating window survives the drawer closing. It portals
              its docked view into the drawer's Model Setup slot when open. */}
          {isAdmin && <SetupBar turns={turns} slot={modelSetupSlot} onTopDockChange={setTopDockH} policyFocus={policyFocus} stateFocus={stateFocus} policyCanvasSelect={policyCanvasSelect} />}
          {/* SimulationPanel is mounted here (page level) for the same reason:
              closing the drawer must not tear down a live run or clear Pause/Stop. */}
          {isAdmin && (
            <SimulationPanel
              controller={{
                begin: beginSimulation,
                send,
                renameCurrent: (title) => {
                  const id = activeIdRef.current;
                  if (id) void onRename(id, title);
                },
              }}
              onRunControls={onSimRunControls}
              runs={simulationRuns}
              activeRunId={activeId}
              onSelectRun={onSelect}
              onDeleteRun={onDelete}
              slot={simulationSlot}
            />
          )}

          {/* Bottom canvas drawer. Its launcher lives in the right rail, under
              the Model Setup (drawer) icon — see RightRail. */}
          <BottomCanvasDrawer
            seedDoc={workflowSeed}
            open={canvasOpen}
            onClose={() => setCanvasOpen(false)}
            height={canvasHeight}
            setHeight={setCanvasHeight}
            doc={canvasDoc}
            onDocChange={setCanvasDoc}
            onSave={saveWorkflow}
            saving={workflowSaving}
            saved={workflowSaved}
            fireSignal={workflowFireSignal}
            onStageClick={onWorkflowStageClick}
          />
        </div>
      </div>
    </div>
  );
}

function StudioLoading({ studioPath }: { studioPath: string }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-white">
      <SiteLogo size={120} href={studioPath} />
    </div>
  );
}

function StudioSplash({ ready, studioPath }: { ready: boolean; studioPath: string }) {
  const [phase, setPhase] = useState<"hold" | "fading" | "gone">("hold");
  const [minElapsed, setMinElapsed] = useState(false);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), 3000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (phase !== "hold" || !ready || !minElapsed) return;
    setPhase("fading");
    const t = setTimeout(() => setPhase("gone"), 700);
    return () => clearTimeout(t);
  }, [phase, ready, minElapsed]);

  if (phase === "gone") return null;

  return (
    <div
      className={
        "fixed inset-0 z-[200] flex items-center justify-center transition-opacity duration-700 " +
        (phase === "fading" ? "pointer-events-none opacity-0" : "opacity-100")
      }
      style={{ backgroundColor: "#ffffff" }}
    >
      <div
        className={
          "transition-opacity duration-700 " + (entered ? "opacity-100" : "opacity-0")
        }
      >
        <SiteLogo size={120} href={studioPath} />
      </div>
    </div>
  );
}

function StudioGate({ config }: { config: StudioChatConfig }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <StudioLoading studioPath={config.studioPath} />;
  }

  if (!user) {
    return <AuthModal />;
  }

  return <StudioApp config={config} />;
}

export function StudioPage({ config }: { config: StudioChatConfig }) {
  return (
    <AuthProvider>
      <div className="flex flex-col" style={{ height: "100dvh" }}>
        <StudioGate config={config} />
      </div>
    </AuthProvider>
  );
}

export function createStudioPage(config: StudioChatConfig): React.FC {
  return function StudioPageDefault() {
    return <StudioPage config={config} />;
  };
}
