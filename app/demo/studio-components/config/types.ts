/** Shared types for the Sleep / Council / Analyst studio "Model Setup" experience. */

import type { FlowEdge, FlowNode, NodeType } from "../flow-types";

export type { FlowEdge, FlowNode, NodeType };

export interface FlowGroup {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export interface ToolPill {
  cls?: string;
  label?: string;
  sep?: boolean;
}

export type SchemaField = [name: string, type: string, initial: string];

export interface GuidelineTopic {
  topic: string;
  content: string;
  problem: string;
  recommendation: string;
}

/** The ~11 lines of wording/wiring that actually differ between studios. */
export type StudioSetupConfig = {
  /** e.g. "/api/admin/setup/law" */
  setupEndpoint: string;
  /** e.g. "Council" | "Therapist" | "Analyst" */
  productName: string;
  /** e.g. "/demo/law/studio" — the studio chat route the config page links back to. */
  studioPath: string;
  /** Lowercase role noun used in seed prompts, e.g. "council" | "sleep assistant" | "analyst". */
  assistantNoun: string;
  /** Noun for the person the assistant is coaching, e.g. "client" | "sleeper". */
  coachNoun: string;
  /** Noun for the intake subject, e.g. "patient" | "user". */
  subjectNoun: string;
};

/** The per-studio seed content from each studio's own `sleep-data.ts`. */
export type StudioSetupData = {
  GUIDELINES: GuidelineTopic[];
  POLICY_EDGES: FlowEdge[];
  POLICY_NODES: FlowNode[];
  POLICY_TOOLS: ToolPill[];
  STATE_EDGES: FlowEdge[];
  STATE_FIELDS: SchemaField[];
  STATE_GROUP: FlowGroup | null;
  STATE_NODES: FlowNode[];
  STATE_PROMPT: string;
  STATE_TOOLS: ToolPill[];
  STATE_TYPES: string[];
};
