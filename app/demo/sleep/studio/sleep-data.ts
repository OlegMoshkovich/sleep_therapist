/* sleep-data.ts — content for the Sleep Studio experience.
   The state schema, prompts, datasets, and guideline topics mirror the real
   Sleep assistant configuration (see app/demo/sleep/input/page.tsx). The node
   graphs are high-fidelity visual mocks adapted to the sleep domain. */

export type NodeType =
  | "start"
  | "iff"
  | "prompt"
  | "transform"
  | "tool"
  | "display"
  | "endn";

export interface FlowNode {
  id: string;
  type: NodeType;
  nt?: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowEdge {
  from: string | [number, number];
  to: string | [number, number];
  fromSide?: "t" | "b" | "l" | "r";
  toSide?: "t" | "b" | "l" | "r";
  label?: string;
}

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

/* ── Tool palettes (focused editor) ── */
export const STATE_TOOLS: ToolPill[] = [
  { cls: "ctrl", label: "+ Control Structure" },
  { cls: "act", label: "+ Action" },
  { cls: "end", label: "+ End" },
  { cls: "exp", label: "+ Expand" },
  { sep: true },
  { cls: "muted", label: "Delete Selected" },
];
export const POLICY_TOOLS: ToolPill[] = [
  { cls: "ctrl", label: "+ Control Structure" },
  { cls: "act", label: "+ Action" },
  { cls: "end", label: "+ End" },
  { cls: "exp", label: "+ Expand" },
  { cls: "async", label: "+ Read Async Job" },
  { cls: "async", label: "+ Await Async Job" },
  { cls: "patch", label: "+ Apply Patch" },
  { cls: "err", label: "+ Raise Error" },
  { sep: true },
  { cls: "muted", label: "Delete Selected" },
];

/* ── State extraction canvas (Sleep) ──
   The actual extraction flow: a START system prompt feeds a single PROMPT node
   holding the state rules. Mirrors the live state-tracking prompt rather than a
   branchy mock. */
export const STATE_NODES: FlowNode[] = [
  {
    id: "start",
    type: "start",
    nt: "Start",
    text:
      "You are a careful state-tracking assistant for a sleep app.\nUpdate only the patient state using the previous known state plus the latest user message.\nReturn exactly one JSON object and nothing else.",
    x: 355,
    y: 20,
    w: 250,
    h: 130,
  },
  {
    id: "rules",
    type: "prompt",
    nt: "Prompt",
    text:
      "State rules:\n- If a field is unknown, leave it empty after the colon.\n- Gender should be \"male\", \"female\", \"other\", or blank.\n- Age should be digits only, or blank.\n- Wellness concern should only include symptoms. It should be blank for general conversation, otherwise a concise summary of symptoms.\n- Update wellness concern only if new additional concerns are shared. Otherwise, no need to add patient's responses here.\n- Candidate causes must be blank for general conversation. Candidate causes must be marked as \"NA\" when the gender is known and not male, or when the age is known and is either under 30 or over 75. Otherwise, if a wellness concern exists, use a comma-separated list of labels chosen only from the provided cause catalog. Refine the list incrementally, ruling out causes as new patient responses indicate.\n- Emergency must be \"true\" only when the situation appears urgent or dangerous, otherwise blank.\n- Return only the state block. Do not add an assistant message before or after END STATE.",
    x: 320,
    y: 240,
    w: 320,
    h: 600,
  },
];
export const STATE_EDGES: FlowEdge[] = [
  { from: "start", to: "rules" },
];
export const STATE_GROUP: FlowGroup | null = null;

/* ── Policy / prompt composition canvas (Sleep) ── */
export const POLICY_NODES: FlowNode[] = [
  { id: "s", type: "start", nt: "Start", text: "You are a calm, helpful sleep assistant. You will be given the current conversation inputs plus an already-updated sleeper state. Use the updated state to decide the next assistant step.", x: 300, y: 10, w: 250, h: 110 },
  { id: "i", type: "iff", nt: "If", text: "the emergency flag in the state is set to true", x: 305, y: 165, w: 215, h: 70 },
  { id: "pcont", type: "prompt", nt: "Prompt", text: "continue the conversation", x: 120, y: 305, w: 175, h: 58 },
  { id: "tc1", type: "tool", nt: "Tool Call", text: "lookup_guideline", x: 560, y: 255, w: 150, h: 54 },
  { id: "pjson", type: "prompt", nt: "Prompt", text: "Advise the sleeper to seek urgent medical help and stop routine coaching.", x: 360, y: 330, w: 205, h: 84 },
  { id: "pt", type: "transform", nt: "Prompt_transform", text: "Return only the matched guideline recommendations, formatted as a short numbered list.", x: 615, y: 335, w: 205, h: 92 },
  { id: "tc2", type: "tool", nt: "Tool Call", text: "save_sleep_log", x: 380, y: 470, w: 150, h: 54 },
  { id: "prate", type: "prompt", nt: "Prompt", text: "Ask the sleeper to rate last night's sleep quality from 0 to 1.", x: 615, y: 490, w: 205, h: 84 },
  { id: "disp", type: "display", nt: "Display", text: "show previous output", x: 600, y: 600, w: 165, h: 48 },
  { id: "end", type: "endn", text: "End", x: 405, y: 686, w: 70, h: 40 },
];
export const POLICY_EDGES: FlowEdge[] = [
  { from: "s", to: "i" },
  { from: "i", fromSide: "l", to: "pcont", toSide: "t", label: "false" },
  { from: "i", fromSide: "r", to: "tc1", toSide: "t", label: "true" },
  { from: "tc1", to: "pt" },
  { from: "tc1", fromSide: "b", to: "pjson", toSide: "t" },
  { from: "pjson", to: "tc2" },
  { from: "pt", to: "prate" },
  { from: "prate", to: "disp" },
  { from: "disp", fromSide: "b", to: "end", toSide: "r" },
  { from: "tc2", to: "end" },
  { from: "pcont", fromSide: "b", to: "end", toSide: "l" },
];

/* ── State schema (mirrors the BEGIN STATE / END STATE block) ── */
export const STATE_TYPES = ["string", "integer", "boolean", "string[]", "number", "json"];
export type SchemaField = [name: string, type: string, initial: string];
export const STATE_FIELDS: SchemaField[] = [
  ["age", "integer", "null"],
  ["gender", "string", "null"],
  ["emergency", "boolean", "false"],
  ["sleep_concern", "string", "null"],
  ["turn_count", "integer", "0"],
  // sleep-intake domains (mirror the Sleep Intake policy canvas)
  ["complaint_history", "string", "null"],
  ["bedtime_weeknight", "string", "null"],
  ["bedtime_weekend", "string", "null"],
  ["sleep_onset_latency", "string", "null"],
  ["wake_time", "string", "null"],
  ["out_of_bed_time", "string", "null"],
  ["night_awakenings", "string", "null"],
  ["nocturia", "string", "null"],
  ["wake_causes", "string[]", "[]"],
  ["returns_to_sleep", "string", "null"],
  ["daytime_function", "string", "null"],
  ["naps", "string", "null"],
  ["caffeine", "string", "null"],
  ["alcohol", "string", "null"],
  ["other_evening_intake", "string", "null"],
  ["exercise", "string", "null"],
  ["sleep_environment", "string", "null"],
  ["mood_anxiety", "string", "null"],
  ["psychiatric_history", "string", "null"],
  ["medical_history", "string", "null"],
  ["current_medications", "string[]", "[]"],
  ["sleep_medications_tried", "string", "null"],
  ["sleep_quality_rating", "integer", "null"],
  ["sleep_stress_rating", "integer", "null"],
];

export const STATE_PROMPT = `You are a careful state-tracking assistant for a sleep app.
Update only the patient state using the previous known state plus the latest user message.
Return exactly one JSON object and nothing else.

State rules:
- If a field is unknown, leave it empty.
- Gender should be "male", "female", "other", or blank.
- Age should be digits only, or blank.
- Wellness concern should only include symptoms; blank for general conversation, otherwise a concise summary of symptoms.
- Update wellness concern only if new additional concerns are shared.
- Candidate causes must be blank for general conversation, "NA" when gender is known and not male or age is under 30 or over 75, otherwise a comma-separated list of labels from the provided cause catalog, refined incrementally.
- Emergency must be true only when the situation appears urgent or dangerous, otherwise false.

Return exactly a JSON object of this form and nothing else:
{
  "gender": string,
  "age": integer,
  "wellness_concern": string,
  "candidate_causes": string[],
  "emergency": boolean
}`;

/* ── Datasets (Knowledge) ── */
export const DATASET_TYPES = ["string", "number", "boolean", "string[]", "URL", "json", "date"];
export interface DatasetSpec {
  name: string;
  cols: [string, string][];
  notes: string;
  records: number;
}
export const DATASETS: DatasetSpec[] = [
  {
    name: "Sleep logs",
    cols: [
      ["date", "date"],
      ["bedtime", "string"],
      ["wake_time", "string"],
      ["hours_slept", "number"],
      ["awakenings", "number"],
      ["quality", "number"],
      ["notes", "string"],
    ],
    notes: "Nightly self-reported sleep records used to ground coaching advice.",
    records: 0,
  },
  {
    name: "Guidelines",
    cols: [
      ["topic", "string"],
      ["source", "string"],
      ["recommendation", "string"],
    ],
    notes: "Source types are {AASM, NHS, peer-reviewed}.",
    records: 12,
  },
];

/* ── Guideline topics (Domain Knowledge) ── */
export interface GuidelineTopic {
  topic: string;
  content: string;
  problem: string;
  recommendation: string;
}
export const GUIDELINES: GuidelineTopic[] = [
  {
    topic: "Sleep hygiene",
    content:
      "Sleep hygiene is the set of daily habits and environmental conditions that support consistent, high-quality sleep. The cornerstone is a regular sleep–wake schedule that keeps the circadian clock entrained, reinforced by a wind-down routine, limited evening light, and a cool, dark, quiet bedroom. It is foundational rather than curative: it rarely resolves entrenched insomnia on its own, but it removes the everyday friction that undermines every other intervention.",
    problem: "Irregular bed and wake times disrupt the circadian rhythm.",
    recommendation: "Keep a consistent schedule, even on weekends; wind down screen-free 30–60 min before bed.",
  },
  {
    topic: "Caffeine & stimulants",
    content:
      "Caffeine is an adenosine-receptor antagonist that blocks the brain's accumulating sleep-pressure signal. Its half-life is roughly 5–6 hours, so a mid-afternoon dose can still carry meaningful levels into the night, lengthening sleep onset and reducing slow-wave (deep) sleep. Sensitivity varies widely with genetics, tolerance, and age, and other stimulants (nicotine, some medications, pre-workout supplements) act similarly.",
    problem: "Caffeine has a ~5–6 hour half-life, so late-day intake delays sleep onset and reduces deep sleep.",
    recommendation: "Avoid caffeine within 8 hours of bedtime; flag heavy or late intake in the sleeper notes.",
  },
  {
    topic: "Insomnia — stimulus control (CBT-I)",
    content:
      "Stimulus control is a core component of CBT-I that re-establishes the bed and bedroom as cues for sleep rather than for frustrated wakefulness. The sleeper uses the bed only for sleep and intimacy, gets up when unable to sleep, and keeps a fixed wake time regardless of how the night went. Over one to two weeks this weakens the learned bed–arousal association that perpetuates chronic insomnia.",
    problem: "Lying awake in bed builds a learned association between the bed and wakefulness.",
    recommendation: "Reserve the bed for sleep; leave it after ~20 minutes awake and return only when sleepy.",
  },
  {
    topic: "Insomnia — sleep restriction (CBT-I)",
    content:
      "Sleep restriction therapy deliberately limits time in bed to approximately the time actually spent asleep, raising homeostatic sleep pressure so that sleep becomes deeper and more consolidated. As sleep efficiency improves (typically above 85–90%), time in bed is extended in small increments. It is one of the most effective CBT-I components but causes short-term sleepiness, so it should be applied carefully and avoided where excessive daytime sleepiness is dangerous.",
    problem: "Spending long hours in bed to 'catch up' fragments sleep and weakens sleep drive.",
    recommendation: "Match time in bed to actual sleep time to build sleep pressure, then extend gradually as efficiency improves.",
  },
  {
    topic: "Light & circadian timing",
    content:
      "The circadian system is set primarily by light reaching the retina, which signals the suprachiasmatic clock that governs sleep timing, alertness, and melatonin release. Bright light in the morning advances the clock and strengthens the day–night signal, while light late in the evening delays it and pushes sleep later. Anchoring light exposure is often more powerful than any single sleep-hygiene habit for people whose sleep timing has drifted.",
    problem: "A drifting body clock makes it hard to fall asleep and wake at consistent times.",
    recommendation: "Get bright light (ideally outdoors) within an hour of waking, and keep evenings dim to anchor the clock.",
  },
  {
    topic: "Screens & blue light",
    content:
      "Short-wavelength (blue) light from phones, tablets, and laptops is especially effective at suppressing melatonin and signalling daytime to the circadian clock. Beyond the light itself, engaging content keeps the mind cognitively aroused at exactly the point it should be settling. The combination delays sleep onset and is one of the most common modifiable causes of late, fragmented sleep.",
    problem: "Bright screens in the hour before bed suppress melatonin and delay sleep onset.",
    recommendation: "Stop screens 30–60 min before bed, or dim displays and enable night mode if use is unavoidable.",
  },
  {
    topic: "Alcohol",
    content:
      "Alcohol is a sedative that shortens sleep onset, which is why it is often mistaken for a sleep aid. As it is metabolized over the night it produces rebound arousal, lighter and more fragmented second-half sleep, suppressed REM, and worsened snoring and apnea. The net effect is reduced restorative sleep even when total time asleep looks normal.",
    problem: "Alcohol sedates at first but fragments second-half sleep and suppresses REM.",
    recommendation: "Avoid alcohol within 3–4 hours of bedtime; note quantity and timing when sleep is disrupted.",
  },
  {
    topic: "Napping",
    content:
      "Daytime naps discharge some of the homeostatic sleep pressure that builds across waking hours. A short nap (10–20 minutes) early in the afternoon can restore alertness with little grogginess, but long or late naps eat into the sleep drive needed to fall asleep at night. For people with insomnia, napping is usually discouraged so that pressure is preserved for the night.",
    problem: "Long or late naps reduce night-time sleep drive and push back sleep onset.",
    recommendation: "Keep naps under 20–30 minutes and before mid-afternoon to protect the night's sleep.",
  },
  {
    topic: "Exercise & activity",
    content:
      "Regular physical activity deepens slow-wave sleep, shortens sleep onset, and improves overall sleep quality over time, while also reducing the anxiety and low mood that feed insomnia. The main caveat is timing: vigorous exercise raises core temperature, heart rate, and arousal, which can delay sleep if done too close to bedtime. Morning or daytime activity also reinforces the circadian day–night signal.",
    problem: "Inactivity weakens sleep drive, while vigorous exercise too close to bed can delay sleep onset.",
    recommendation: "Encourage regular daytime activity; finish vigorous exercise at least 2–3 hours before bed.",
  },
  {
    topic: "Bedroom environment",
    content:
      "Initiating sleep requires a drop in core body temperature, so a cooler room (~18°C / 65°F) supports both falling and staying asleep. Darkness preserves melatonin and prevents circadian disruption, while quiet — or steady masking sound — limits the brief arousals that fragment sleep without fully waking the sleeper. Small environmental fixes (blackout curtains, earplugs, removing a ticking clock) often yield outsized gains.",
    problem: "A warm, bright, or noisy room raises arousal and interrupts sleep.",
    recommendation: "Keep the bedroom cool (~18°C / 65°F), dark, and quiet; address light and noise sources.",
  },
  {
    topic: "Racing mind & worry",
    content:
      "Cognitive arousal — rumination, planning, problem-solving, and clock-watching — is a leading driver of difficulty falling and staying asleep, and it intensifies as anxiety about not sleeping grows. CBT-I addresses it with techniques that move worry out of the bed: a scheduled worry or planning period earlier in the evening, writing concerns down to offload them, and cognitive reframing of catastrophic thoughts about sleep loss.",
    problem: "Rumination and clock-watching at night drive arousal and prolong wakefulness.",
    recommendation: "Schedule a 'worry window' earlier in the evening and keep a notepad to offload thoughts before bed.",
  },
  {
    topic: "Sleep apnea screening",
    content:
      "Obstructive sleep apnea involves repeated collapse of the upper airway during sleep, producing loud snoring, witnessed breathing pauses, gasping or choking arousals, and unrefreshing sleep with prominent daytime sleepiness. It is a medical condition with cardiovascular and metabolic consequences and is not resolved by sleep-hygiene coaching. When these red flags are present the assistant should escalate to a clinician rather than continue routine coaching.",
    problem: "Loud snoring, witnessed breathing pauses, gasping, and heavy daytime sleepiness can signal obstructive sleep apnea.",
    recommendation: "Treat as a clinical red flag: recommend evaluation by a clinician rather than coaching alone.",
  },
];

/* ── Chat copy (Sleep persona) ── */
export const SUGGESTIONS: { icon: string; label: string }[] = [
  { icon: "Memo", label: "Summarise my sleep log" },
  { icon: "Book", label: "Find guidance on insomnia" },
  { icon: "Edit", label: "Draft a wind-down routine" },
];
export const ACTION_CHIPS: { icon: string; label: string; prefill?: string }[] = [
  { icon: "Upload", label: "Upload sleep data" },
  {
    icon: "User",
    label: "Chat with the expert",
    prefill: "I'd like to chat with a sleep expert about ",
  },
];

const OPENERS = [
  "Glad you reached out. Before we dig in — are you after a quick tip, a look at your recent nights, or a routine you can actually stick to?",
  "Happy to help with your sleep. I can review your logs, summarise what's working, and flag anything that might be holding you back. Want to start broad or focus on last night?",
  "Let's work through it together. Tell me a bit about your nights lately and I'll map out where the friction is, then we can fix one thing at a time.",
];
const FOLLOWUPS = [
  "Noted. Here's how I'd approach it: stabilise your wake time first, since a steady morning anchor does more for sleep than almost anything else.",
  "That's a useful detail. I'd separate what's a habit you can change from what might need a clinician — the habits are usually where the quick wins are.",
  "Makes sense. I can sketch a short wind-down routine and keep a running note of what we try, so it's easy to see what actually helps.",
  "Right. Let me lay out the most likely factors, then point to the ones worth watching so you know what to treat carefully.",
];

let replyIdx = 0;
export function genReply(isFirst: boolean, rand = Math.random()): string {
  if (isFirst) return OPENERS[Math.floor(rand * OPENERS.length)];
  const r = FOLLOWUPS[replyIdx % FOLLOWUPS.length];
  replyIdx++;
  return r;
}

export const truncate = (s: string, n = 28) =>
  s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
