export function extractFirstJsonObject(text: string): string | null {
  const normalized = text.trim();
  const startIndex = normalized.indexOf("{");

  if (startIndex === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < normalized.length; index += 1) {
    const char = normalized[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return normalized.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

export function parseJsonObject<T>(text: string): T | null {
  const objectText = extractFirstJsonObject(text);
  if (!objectText) {
    return null;
  }

  try {
    return JSON.parse(objectText) as T;
  } catch {
    return null;
  }
}
