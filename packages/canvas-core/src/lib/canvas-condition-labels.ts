const EXPLICIT_LOCAL_VALUE_CONDITION_LABEL_PATTERN =
  /^(?:local|prompt)\s+([a-zA-Z0-9_.-]+)\s+(.+)$/i;

export interface ExplicitLocalValueConditionLabel {
  name: string;
  rest: string;
}

export function parseExplicitLocalValueConditionLabel(
  label: string
): ExplicitLocalValueConditionLabel | null {
  const match = label.trim().match(EXPLICIT_LOCAL_VALUE_CONDITION_LABEL_PATTERN);
  if (!match) {
    return null;
  }

  const name = match[1]?.trim() ?? "";
  const rest = match[2]?.trim() ?? "";
  if (!name || !rest) {
    return null;
  }

  return { name, rest };
}

export function buildExplicitLocalValueConditionLabel(
  name: string,
  rest: string
): string {
  return `local ${name.trim()} ${rest.trim()}`.trim();
}

export function canonicalizeExplicitLocalValueConditionLabel(
  label: string
): string {
  const parsed = parseExplicitLocalValueConditionLabel(label);
  return parsed
    ? buildExplicitLocalValueConditionLabel(parsed.name, parsed.rest)
    : label;
}
