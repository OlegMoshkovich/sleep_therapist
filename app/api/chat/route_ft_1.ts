import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { auth } from "@clerk/nextjs/server";
import { createSupabaseAdminClient } from "../../lib/supabase-admin";
import { clerkIdToUUID } from "../../lib/clerk-uuid";
import { TRIAGE_GUIDELINES_CONTEXT } from "./triage-guidelines-context";

interface HistoryMessage {
  role: string;
  content: string;
}

type CandidateCauseMarker = "NA";
type StateUpdateCandidateCauses = string[] | [CandidateCauseMarker];

interface PatientStateSnapshot {
  gender: string;
  age: string;
  wellnessConcern: string;
  candidateCauses: StateUpdateCandidateCauses;
  emergency: string;
}

interface SplitAssistantReply {
  stateBlock: string;
  patientReply: string;
}

interface AssistantTurnResult {
  stateBlock: string;
  updatedState: PatientStateSnapshot;
  patientReply: string;
}

const OPENAI_MAX_TOKENS = 1024;
const FORCED_TRIAGE_SUMMARY_MODEL = "gpt-5.4";
const MAX_ASSISTANT_TURNS = 10;
const STATE_BLOCK_BEGIN = "BEGIN STATE";
const STATE_BLOCK_END = "END STATE";
const TRIAGE_SUMMARY_PREFIX = "Triage summary";
const UNSURE_FOLLOW_UP_TEXT =
  "Can you describe your symptoms or wellness concern in a bit more detail?";
const OUT_OF_SCOPE_REPLY =
  "This agent supports only male patients aged 30 to 75. Please seek appropriate care from a clinician who can evaluate your situation directly.";
const GENERAL_WELLNESS_FOLLOW_UP =
  "Thanks. What wellness concern or symptoms would you like help with today?";
const SYMPTOM_DETAILS_FOLLOW_UP =
  "Can you tell me when this started and whether anything makes it better or worse?";
const EMERGENCY_FALLBACK_REPLY =
  "Your situation may be urgent. Please seek immediate medical attention or contact local emergency services now.";
const FORCED_TRIAGE_SUMMARY_SYSTEM_PROMPT = `You are a calm, helpful assistant for a wellness app.
Do not claim certainty or a definitive diagnosis.
Return only the requested triage summary.`;

function normalizeModelText(text: string | null | undefined): string {
  return (text ?? "").trim();
}

function resolveOpenAiApiKey(): string {
  const apiKey = process.env.AIRLAB_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Set AIRLAB_OPENAI_API_KEY or OPENAI_API_KEY.");
  }

  return apiKey;
}

function resolveFineTunedModel(modelOverride?: string): string {
  if (modelOverride) {
    return modelOverride;
  }

  const model =
    process.env.AIRLAB_OPENAI_FINE_TUNED_MODEL ??
    process.env.OPENAI_FINE_TUNED_MODEL ??
    process.env.OPENAI_ASSISTANT_MODEL;

  if (!model) {
    throw new Error(
      "Set AIRLAB_OPENAI_FINE_TUNED_MODEL, OPENAI_FINE_TUNED_MODEL, or OPENAI_ASSISTANT_MODEL."
    );
  }

  return model;
}

function normalizeCandidateCausesForStateSnapshot(
  candidateCauses: StateUpdateCandidateCauses | undefined
): StateUpdateCandidateCauses {
  if (!candidateCauses || candidateCauses.length === 0) {
    return [];
  }

  const normalized = candidateCauses
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (normalized.length === 0) {
    return [];
  }

  const [firstValue] = normalized;
  if (normalized.length === 1 && /^na$/i.test(firstValue)) {
    return ["NA"];
  }

  return normalized;
}

function renderCandidateCausesForStateBlock(
  candidateCauses: StateUpdateCandidateCauses
): string {
  if (candidateCauses.length === 0) {
    return "";
  }

  return candidateCauses.join(", ");
}

function parseCandidateCausesText(value: string): StateUpdateCandidateCauses {
  const normalized = value.trim();

  if (!normalized) {
    return [];
  }

  return normalizeCandidateCausesForStateSnapshot(
    normalized
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  );
}

function emptyPatientStateSnapshot(): PatientStateSnapshot {
  return {
    gender: "",
    age: "",
    wellnessConcern: "",
    candidateCauses: [],
    emergency: "",
  };
}

function renderStateBlock(state: PatientStateSnapshot): string {
  return [
    STATE_BLOCK_BEGIN,
    `Gender: ${state.gender}`,
    `Age: ${state.age}`,
    `Wellness concern: ${state.wellnessConcern}`,
    `Candidate causes: ${renderCandidateCausesForStateBlock(state.candidateCauses)}`,
    `Emergency: ${state.emergency}`,
    STATE_BLOCK_END,
  ].join("\n");
}

function parseStateBlock(text: string): PatientStateSnapshot {
  const match = text.match(/BEGIN STATE\s*([\s\S]*?)\s*END STATE/i);

  if (!match) {
    return emptyPatientStateSnapshot();
  }

  const block = match[1];
  return {
    gender: block.match(/^[ \t]*Gender:[ \t]*(.*)$/im)?.[1]?.trim() ?? "",
    age: block.match(/^[ \t]*Age:[ \t]*(.*)$/im)?.[1]?.trim() ?? "",
    wellnessConcern:
      block.match(/^[ \t]*Wellness concern:[ \t]*(.*)$/im)?.[1]?.trim() ?? "",
    candidateCauses: parseCandidateCausesText(
      block.match(/^[ \t]*Candidate causes:[ \t]*(.*)$/im)?.[1]?.trim() ?? ""
    ),
    emergency: block.match(/^[ \t]*Emergency:[ \t]*(.*)$/im)?.[1]?.trim() ?? "",
  };
}

function splitStatefulAssistantReply(text: string): SplitAssistantReply | null {
  const normalized = normalizeModelText(text);
  const match = normalized.match(/BEGIN STATE\s*[\s\S]*?\s*END STATE/i);

  if (!match || match.index === undefined) {
    return null;
  }

  const stateBlock = match[0].trim();
  const patientReply = normalized.slice(match.index + match[0].length).trim();

  return {
    stateBlock,
    patientReply,
  };
}

function parseAgeNumber(value: string): number | null {
  const match = value.match(/\d{1,3}/);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[0], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isEmergencyState(value: string): boolean {
  return /^(true|yes|y|urgent|emergency)$/i.test(value.trim());
}

function isUnsupportedPopulation(state: PatientStateSnapshot): boolean {
  const normalizedGender = state.gender.trim().toLowerCase();
  if (normalizedGender && normalizedGender !== "male") {
    return true;
  }

  const parsedAge = parseAgeNumber(state.age);
  if (parsedAge !== null && (parsedAge < 30 || parsedAge > 75)) {
    return true;
  }

  return state.candidateCauses.some((cause) => /^na$/i.test(cause.trim()));
}

function buildMissingDemographicsReply(state: PatientStateSnapshot): string | null {
  const missingAge = state.age.trim().length === 0;
  const missingGender = state.gender.trim().length === 0;

  if (missingAge && missingGender) {
    return "What are your age and gender?";
  }

  if (missingAge) {
    return "What is your age?";
  }

  if (missingGender) {
    return "What is your gender?";
  }

  return null;
}

function buildFallbackPatientReply(state: PatientStateSnapshot): string {
  if (isEmergencyState(state.emergency)) {
    return EMERGENCY_FALLBACK_REPLY;
  }

  if (isUnsupportedPopulation(state)) {
    return OUT_OF_SCOPE_REPLY;
  }

  const concern = state.wellnessConcern.trim();
  if (!concern) {
    return GENERAL_WELLNESS_FOLLOW_UP;
  }

  if (/^unsure$/i.test(concern)) {
    return UNSURE_FOLLOW_UP_TEXT;
  }

  const missingDemographicsReply = buildMissingDemographicsReply(state);
  if (missingDemographicsReply) {
    return missingDemographicsReply;
  }

  return SYMPTOM_DETAILS_FOLLOW_UP;
}

function stripStateBlock(text: string): string {
  const splitReply = splitStatefulAssistantReply(text);

  if (!splitReply) {
    return normalizeModelText(text);
  }

  return splitReply.patientReply;
}

function formatHistoryForFineTunedPrompt(history: HistoryMessage[]): string {
  return history
    .map((message, index) => {
      const content =
        message.role === "assistant" ? stripStateBlock(message.content) : message.content.trim();
      return `${index + 1}. ${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n");
}

function historyWithoutLatestUserMessage(
  history: HistoryMessage[],
  latestUserMessage: string
): HistoryMessage[] {
  if (history.length === 0) {
    return history;
  }

  const lastMessage = history[history.length - 1];
  if (lastMessage.role !== "user") {
    return history;
  }

  if (normalizeModelText(lastMessage.content) !== normalizeModelText(latestUserMessage)) {
    return history;
  }

  return history.slice(0, -1);
}

function hasStateSnapshotData(state: PatientStateSnapshot): boolean {
  return (
    state.gender.trim().length > 0 ||
    state.age.trim().length > 0 ||
    state.wellnessConcern.trim().length > 0 ||
    state.candidateCauses.length > 0 ||
    state.emergency.trim().length > 0
  );
}

function getLatestKnownState(history: HistoryMessage[]): PatientStateSnapshot {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];

    if (message.role !== "assistant") {
      continue;
    }

    const parsedState = parseStateBlock(message.content);
    if (!hasStateSnapshotData(parsedState)) {
      continue;
    }

    return parsedState;
  }

  return emptyPatientStateSnapshot();
}

function buildFineTunedUserPrompt(
  history: HistoryMessage[],
  latestUserMessage: string,
  knownState: PatientStateSnapshot
): string {
  return [
    "Conversation history:",
    formatHistoryForFineTunedPrompt(historyWithoutLatestUserMessage(history, latestUserMessage)),
    "",
    "Previous known state:",
    renderStateBlock(knownState),
    "",
    "Latest user message:",
    latestUserMessage,
  ].join("\n");
}

function buildForcedTriageSummaryPrompt(
  history: HistoryMessage[],
  latestUserMessage: string,
  updatedState: PatientStateSnapshot
): string {
  return [
    TRIAGE_GUIDELINES_CONTEXT,
    "Conversation history:",
    formatHistoryForFineTunedPrompt(historyWithoutLatestUserMessage(history, latestUserMessage)),
    "",
    "Updated patient state:",
    renderStateBlock(updatedState),
    "",
    "Latest user message:",
    latestUserMessage,
    "",
    "Write a concise summary in exactly this format and do not ask any follow-up questions, and do not invite the user to continue:",
    "Triage summary",
    "Advice: ...",
    "Recommendation: ...",
    "Escalation: ...",
    "",
    "Return only the summary.",
  ].join("\n");
}

function countAssistantTurns(history: HistoryMessage[]): number {
  return history.filter((message) => message.role === "assistant").length;
}

function shouldForceTriageSummary(history: HistoryMessage[]): boolean {
  return countAssistantTurns(history) + 1 >= MAX_ASSISTANT_TURNS;
}

function isTriageSummary(text: string): boolean {
  const normalized = normalizeModelText(text);
  return (
    normalized.startsWith(TRIAGE_SUMMARY_PREFIX) &&
    normalized.includes("Advice:") &&
    normalized.includes("Recommendation:") &&
    normalized.includes("Escalation:")
  );
}

async function runChatCompletion(
  openai: OpenAI,
  model: string,
  maxTokens: number,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
): Promise<string> {
  const completion = await openai.chat.completions.create({
    model,
    max_completion_tokens: maxTokens,
    messages,
  });

  return normalizeModelText(completion.choices[0]?.message?.content);
}

async function runFineTunedAssistantTurn(
  openai: OpenAI,
  history: HistoryMessage[],
  latestUserMessage: string,
  knownState: PatientStateSnapshot,
  fineTunedModel: string
): Promise<AssistantTurnResult> {
  const modelReply = await runChatCompletion(openai, fineTunedModel, OPENAI_MAX_TOKENS, [
    { role: "system", content: "" },
    { role: "user", content: buildFineTunedUserPrompt(history, latestUserMessage, knownState) },
  ]);
  const splitReply = splitStatefulAssistantReply(modelReply);

  if (!splitReply) {
    throw new Error("Fine-tuned model response did not include a BEGIN STATE/END STATE block.");
  }

  const updatedState = parseStateBlock(splitReply.stateBlock);
  const patientReply = splitReply.patientReply || buildFallbackPatientReply(updatedState);

  return {
    stateBlock: splitReply.stateBlock,
    updatedState,
    patientReply,
  };
}

async function runForcedTriageSummary(
  openai: OpenAI,
  history: HistoryMessage[],
  latestUserMessage: string,
  updatedState: PatientStateSnapshot
): Promise<string> {
  const summary = await runChatCompletion(openai, FORCED_TRIAGE_SUMMARY_MODEL, OPENAI_MAX_TOKENS, [
    { role: "system", content: FORCED_TRIAGE_SUMMARY_SYSTEM_PROMPT },
    {
      role: "user",
      content: buildForcedTriageSummaryPrompt(history, latestUserMessage, updatedState),
    },
  ]);

  if (!isTriageSummary(summary)) {
    throw new Error("Forced triage summary did not match the required format.");
  }

  return summary;
}

async function saveAssistantReply(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  conversationId: string,
  content: string
) {
  await supabase.from("messages").insert({
    conversation_id: conversationId,
    role: "assistant",
    content,
  });

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}

function buildTextResponse(content: string) {
  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

export async function handleFineTunedChatRequest(
  request: NextRequest,
  modelOverride?: string
) {
  try {
    console.log("[api/chat/route_ft_1] handleFineTunedChatRequest", {
      modelOverride: modelOverride ?? "(none, will resolve from env)",
      referer: request.headers.get("referer") ?? "(none)",
    });
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userUUID = await clerkIdToUUID(userId);
    const supabase = createSupabaseAdminClient();
    const body = await request.json();
    const { conversationId, userMessage } = body;
    const trimmedUserMessage = userMessage?.trim();

    if (!conversationId || !trimmedUserMessage) {
      return NextResponse.json({ error: "Bad request" }, { status: 400 });
    }

    const { data: convo } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("user_id", userUUID)
      .single();

    if (!convo) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: trimmedUserMessage,
    });

    const { data: history } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    const orderedHistory: HistoryMessage[] = (history ?? []).map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const openai = new OpenAI({ apiKey: resolveOpenAiApiKey() });
    const knownState = getLatestKnownState(orderedHistory);
    const assistantTurn = await runFineTunedAssistantTurn(
      openai,
      orderedHistory,
      trimmedUserMessage,
      knownState,
      resolveFineTunedModel(modelOverride)
    );

    const patientReply = shouldForceTriageSummary(orderedHistory)
      ? await runForcedTriageSummary(
          openai,
          orderedHistory,
          trimmedUserMessage,
          assistantTurn.updatedState
        )
      : assistantTurn.patientReply;
    const statefulReply = `${assistantTurn.stateBlock}\n\n${patientReply}`.trim();

    await saveAssistantReply(supabase, conversationId, statefulReply);
    return buildTextResponse(patientReply);
  } catch (err) {
    console.error("Fine-tuned chat route error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  return handleFineTunedChatRequest(request);
}
