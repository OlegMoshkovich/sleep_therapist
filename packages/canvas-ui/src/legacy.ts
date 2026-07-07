import type { CanvasDoc, CanvasGraph } from "./types";

const JSON_PREFIX = "<!-- POLICY_FLOWCHART_JSON:";
const JSON_SUFFIX = " -->";
const GENERATED_HEADER = "## Policy Flowchart (auto-generated)";
const NOTES_HEADER = "## Additional policy notes";

/**
 * Parses a legacy `policy_prompt` markdown payload. Older rows embedded the
 * canvas JSON inside an HTML comment alongside the human-readable
 * pseudocode; new rows use the dedicated `policy_canvases` table.
 *
 * Returns null if the payload contains no embedded canvas data.
 */
export function extractDoc(raw: string): CanvasDoc | null {
  const start = raw.indexOf(JSON_PREFIX);
  if (start === -1) return null;
  const end = raw.indexOf(JSON_SUFFIX, start);
  if (end === -1) return null;

  const jsonText = raw.slice(start + JSON_PREFIX.length, end).trim();
  try {
    const parsed = JSON.parse(jsonText) as
      | CanvasDoc
      | (CanvasGraph & { version?: undefined });
    if (parsed && (parsed as CanvasDoc).version === 2) {
      return parsed as CanvasDoc;
    }
    if (parsed && "nodes" in parsed && "edges" in parsed) {
      const legacy = parsed as CanvasGraph;
      const legacyFreeText = extractLegacyFreeText(raw.slice(0, start));
      const canvasId = "canvas-main";
      return {
        version: 2,
        activeId: canvasId,
        canvases: [
          {
            id: canvasId,
            name: "Main",
            graph: legacy,
            freeText: legacyFreeText,
          },
        ],
      };
    }
  } catch {
    // fall through
  }
  return null;
}

function extractLegacyFreeText(beforeJson: string): string {
  const text = beforeJson.trim();
  const genIdx = text.indexOf(GENERATED_HEADER);
  if (genIdx === -1) return text.trim();
  const notesIdx = text.indexOf(NOTES_HEADER, genIdx);
  if (notesIdx === -1) return "";
  return text.slice(notesIdx + NOTES_HEADER.length).trim();
}
