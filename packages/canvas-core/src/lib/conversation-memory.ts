export const CONVERSATION_SUMMARY_FIELD_NAME = "summary";
export const NEW_EVENTS_FIELD_NAME = "new_events";
export const LEGACY_NEW_CONVERSATIONS_FIELD_NAME = "new_conversations";
export const DEFAULT_CONVERSATION_MEMORY_LIMIT = 4000;

export interface ConversationMemoryEvent {
  action: string;
  observation: string;
  reward: string;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeEventText(value: unknown): string {
  return typeof value === "string"
    ? collapseWhitespace(value)
    : collapseWhitespace(String(value ?? ""));
}

function normalizeConversationMemoryEvent(
  raw: unknown
): ConversationMemoryEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  return {
    action: normalizeEventText(record.action),
    observation: normalizeEventText(record.observation),
    reward: normalizeEventText(record.reward),
  };
}

function parseLegacyConversationMemoryTurns(raw: string): ConversationMemoryEvent[] {
  const turns = raw
    .split("||")
    .map((turn) => collapseWhitespace(turn))
    .filter(Boolean);
  const events: ConversationMemoryEvent[] = [];

  for (const turn of turns) {
    if (/^USER:/i.test(turn)) {
      events.push({
        action: "",
        observation: collapseWhitespace(turn.replace(/^USER:/i, "")),
        reward: "",
      });
      continue;
    }

    if (/^ASSISTANT:/i.test(turn)) {
      const action = collapseWhitespace(turn.replace(/^ASSISTANT:/i, ""));
      const latestEvent = events[events.length - 1];

      if (latestEvent && !latestEvent.action) {
        latestEvent.action = action;
      } else {
        events.push({
          action,
          observation: "",
          reward: "",
        });
      }
    }
  }

  return events;
}

export function formatConversationMemoryTurn(
  role: string,
  content: string
): string {
  const normalizedRole = collapseWhitespace(role).toUpperCase();
  const normalizedContent = collapseWhitespace(content);

  if (!normalizedRole || !normalizedContent) {
    return "";
  }

  return `${normalizedRole}: ${normalizedContent}`;
}

export function appendConversationMemoryTurn(
  existing: string,
  role: string,
  content: string
): string {
  const nextTurn = formatConversationMemoryTurn(role, content);
  const normalizedExisting = collapseWhitespace(existing);

  if (!nextTurn) {
    return normalizedExisting;
  }

  return normalizedExisting ? `${normalizedExisting} || ${nextTurn}` : nextTurn;
}

export function parseConversationMemoryEvents(raw: unknown): ConversationMemoryEvent[] {
  let parsed: unknown = raw;

  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed) {
      return [];
    }

    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return parseLegacyConversationMemoryTurns(trimmed);
    }
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((entry) => normalizeConversationMemoryEvent(entry))
    .filter((entry): entry is ConversationMemoryEvent => entry !== null);
}

export function serializeConversationMemoryEvents(
  events: ConversationMemoryEvent[]
): string {
  return JSON.stringify(
    events.map((event) => ({
      action: normalizeEventText(event.action),
      observation: normalizeEventText(event.observation),
      reward: normalizeEventText(event.reward),
    }))
  );
}

export function hasConversationMemoryFieldNames(fieldNames: string[]): boolean {
  const normalized = new Set(
    fieldNames.map((name) => name.trim().toLowerCase()).filter(Boolean)
  );

  return (
    normalized.has(CONVERSATION_SUMMARY_FIELD_NAME) &&
    (normalized.has(NEW_EVENTS_FIELD_NAME) ||
      normalized.has(LEGACY_NEW_CONVERSATIONS_FIELD_NAME))
  );
}

export function resolveConversationMemoryFieldName(
  fieldNames: string[]
): string | null {
  const normalizedNames = fieldNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  const eventField =
    normalizedNames.find((name) => name.toLowerCase() === NEW_EVENTS_FIELD_NAME) ?? null;
  if (eventField) {
    return eventField;
  }

  return (
    normalizedNames.find(
      (name) => name.toLowerCase() === LEGACY_NEW_CONVERSATIONS_FIELD_NAME
    ) ?? null
  );
}

export function buildConversationMemoryObservationEvent(args: {
  observation: string;
  reward?: string;
}): ConversationMemoryEvent | null {
  const observation = normalizeEventText(args.observation);
  const reward = normalizeEventText(args.reward);

  if (!observation && !reward) {
    return null;
  }

  return {
    action: "",
    observation,
    reward,
  };
}

export function buildConversationMemoryEnvironmentEvent(args: {
  observation: string;
  reward?: string;
}): ConversationMemoryEvent | null {
  const observation = normalizeEventText(args.observation);
  const reward = normalizeEventText(args.reward);

  if (!observation && !reward) {
    return null;
  }

  return {
    observation,
    reward,
    action: "",
  };
}

export function buildConversationMemoryActionEvent(
  action: string
): ConversationMemoryEvent | null {
  const normalizedAction = normalizeEventText(action);
  if (!normalizedAction) {
    return null;
  }

  return {
    action: normalizedAction,
    observation: "",
    reward: "",
  };
}

export function appendConversationMemoryObservationEvent(
  existing: string,
  observation: string,
  reward = ""
): string {
  const event = buildConversationMemoryObservationEvent({ observation, reward });
  if (!event) {
    return existing.trim();
  }

  const events = parseConversationMemoryEvents(existing);
  events.push(event);
  return serializeConversationMemoryEvents(events);
}

export function appendConversationMemoryEnvironmentEvent(
  existing: string,
  observation: string,
  reward = ""
): string {
  const event = buildConversationMemoryEnvironmentEvent({ observation, reward });
  if (!event) {
    return existing.trim();
  }

  const events = parseConversationMemoryEvents(existing);
  events.push(event);
  return serializeConversationMemoryEvents(events);
}

export function appendConversationMemoryAction(
  existing: string,
  action: string
): string {
  const eventAction = normalizeEventText(action);
  if (!eventAction) {
    return existing.trim();
  }

  const events = parseConversationMemoryEvents(existing);
  const latestEvent = events[events.length - 1];

  if (latestEvent && !latestEvent.action) {
    latestEvent.action = eventAction;
  } else {
    events.push({
      action: eventAction,
      observation: "",
      reward: "",
    });
  }

  return serializeConversationMemoryEvents(events);
}

export function buildConversationMemorySummaryInput(
  summary: string,
  rawEvents: string
): string {
  const normalizedSummary = collapseWhitespace(summary);
  const events = parseConversationMemoryEvents(rawEvents);
  const eventsText = events.length > 0 ? JSON.stringify(events) : "";
  return [normalizedSummary, eventsText].filter(Boolean).join(" || ");
}
