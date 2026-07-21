"use client";

import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Empty `[]`, underscore blanks, yes/no, or short placeholder tokens like `[city]`. */
const BLANK_TOKEN =
  /\[(?:\s*|_{2,}|yes\s*\/\s*no|[a-z][a-z0-9_\s/-]{0,24})\]/gi;

/** Bare fill-ins LLMs often emit: `Seller: ______` or `$______`. */
const BARE_BLANK = /\$?_{3,}/g;

export function looksLikeWorksheet(text: string): boolean {
  const blanks = text.match(BLANK_TOKEN) ?? [];
  if (blanks.length >= 3) return true;
  const bare = text.match(BARE_BLANK) ?? [];
  // Two+ underscore runs (common in templates) → treat as a form worksheet.
  if (bare.length >= 2) return true;
  // "Label: ____" lines even when only one blank is present.
  if (/^[^\n:]{1,40}:\s*\$?_{3,}\s*$/m.test(text) && bare.length >= 1) return true;
  if (
    /fill[- ]?in[- ]the[- ]blank|worksheet|intake\s+form|fill\s+out|document\s+index\s+template/i.test(
      text
    ) &&
    (blanks.length >= 1 || bare.length >= 1)
  ) {
    return true;
  }
  return false;
}

export function worksheetSectionCount(text: string): number {
  const normalized = normalizeWorksheetText(text);
  const matches = normalized.match(/^\s*\d{1,2}\.\s+\S/gm);
  return matches?.length ?? 0;
}

/**
 * One-line plain preview for collapsed bubbles. Strips markdown structure so
 * lists / breaks can't force the collapsed shell taller than a single line.
 */
export function collapsedPlainPreview(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~|>]+/g, "")
    .replace(/\$?_{3,}/g, "…")
    .replace(/\[[^\]]*\]/g, "…")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * LLMs often jam the next numbered section onto the same line as a blank.
 * Pull those apart so the form can stack cleanly.
 */
function normalizeWorksheetText(text: string): string {
  let t = text.replace(/\r\n/g, "\n").trim();
  // "…blank] 4. Next section" → break before the number
  t = t.replace(/([^\n])\s+(\d{1,2}\.\s+[A-Za-z*])/g, "$1\n\n$2");
  // "…blank] Exact wording:" / "…blank] If yes," → own line
  t = t.replace(/(\[[^\]]*\])\s+(?=(?:If\s|Exact\s|Date\s|Who\s|What\s|When\s|Where\s|How\s|[A-Z][^.\n]{0,48}:))/g, "$1\n");
  // Collapse 3+ blank lines
  t = t.replace(/\n{3,}/g, "\n\n");
  return t;
}

type BlankKind = "empty" | "line" | "choice" | "token";

function classifyBlank(raw: string): { kind: BlankKind; label: string } {
  // Bare underscore / $____ runs
  if (/^\$?_+$/.test(raw)) return { kind: "line", label: "" };
  const inner = raw.startsWith("[") ? raw.slice(1, -1).trim() : raw.trim();
  if (!inner) return { kind: "empty", label: "" };
  if (/^_+$/.test(inner)) return { kind: "line", label: "" };
  if (/^yes\s*\/\s*no$/i.test(inner)) return { kind: "choice", label: "yes / no" };
  return { kind: "token", label: inner };
}

/** Match bracket blanks or bare underscore fill-ins, in document order. */
const ANY_BLANK =
  /\[(?:\s*|_{2,}|yes\s*\/\s*no|[a-z][a-z0-9_\s/-]{0,24})\]|\$?_{3,}/gi;

function renderInlineWithBlanks(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = new RegExp(ANY_BLANK.source, "gi");
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(
        <span key={`t-${key++}`} className="bubble-form-text">
          {text.slice(last, m.index)}
        </span>
      );
    }
    const { kind, label } = classifyBlank(m[0]);
    nodes.push(
      <span
        key={`b-${key++}`}
        className={
          "bubble-form-blank" +
          (kind === "choice" ? " is-choice" : "") +
          (kind === "line" || kind === "empty" ? " is-line" : "") +
          (kind === "token" ? " is-token" : "")
        }
        aria-label={label ? `Blank: ${label}` : "Blank"}
      >
        {kind === "choice" ? "yes / no" : kind === "token" ? label : "\u00a0"}
      </span>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    nodes.push(
      <span key={`t-${key++}`} className="bubble-form-text">
        {text.slice(last)}
      </span>
    );
  }
  return nodes;
}

function stripMdNoise(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s+/, "")
    .trim();
}

type FormSection = { number?: string; title: string; rows: string[] };

function parseWorksheet(text: string): { intro: string; sections: FormSection[] } {
  const normalized = normalizeWorksheetText(text);
  const lines = normalized.split("\n");
  const introLines: string[] = [];
  const sections: FormSection[] = [];
  let current: FormSection | null = null;

  const sectionStart = /^(\d{1,2})\.\s+(.*)$/;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (!current) introLines.push("");
      continue;
    }
    const sm = line.match(sectionStart);
    if (sm) {
      current = {
        number: sm[1],
        title: stripMdNoise(sm[2]),
        rows: [],
      };
      sections.push(current);
      continue;
    }
    if (current) {
      current.rows.push(stripMdNoise(line));
    } else {
      introLines.push(line);
    }
  }

  // If we never found numbered sections, treat the whole body as one block of rows
  // (still nicer than a jammed paragraph).
  if (sections.length === 0) {
    const body = normalizeWorksheetText(text);
    const introEnd = body.search(/\n\s*\d{1,2}\.\s|\n\s*[-*]\s|\[/);
    const intro =
      introEnd > 0 ? stripMdNoise(body.slice(0, introEnd).trim()) : "";
    const rest = introEnd > 0 ? body.slice(introEnd) : body;
    return {
      intro,
      sections: [
        {
          title: "Worksheet",
          rows: rest
            .split("\n")
            .map((l) => stripMdNoise(l))
            .filter(Boolean),
        },
      ],
    };
  }

  return {
    intro: stripMdNoise(introLines.join("\n").trim()),
    sections,
  };
}

function BubbleWorksheet({ text }: { text: string }) {
  const { intro, sections } = parseWorksheet(text);
  return (
    <div className="bubble-form">
      {intro ? (
        <div className="bubble-form-intro">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{intro}</ReactMarkdown>
        </div>
      ) : null}
      <div className="bubble-form-sections">
        {sections.map((section, si) => (
          <section key={`${section.number ?? "s"}-${si}`} className="bubble-form-section">
            <header className="bubble-form-section-head">
              {section.number ? (
                <span className="bubble-form-num">{section.number}</span>
              ) : null}
              <span className="bubble-form-section-title">{section.title}</span>
            </header>
            {section.rows.length > 0 ? (
              <ul className="bubble-form-rows">
                {section.rows.map((row, ri) => (
                  <li key={ri} className="bubble-form-row">
                    {renderInlineWithBlanks(row)}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * Markdown renderer for chat bubbles — GFM so tables (intake forms, comparison
 * sheets) render as real HTML tables instead of raw `|` pipes. Fill-in-the-blank
 * worksheets are detected and laid out as structured form cards.
 */
export function BubbleMarkdown({ children }: { children: string }) {
  if (looksLikeWorksheet(children)) {
    return <BubbleWorksheet text={children} />;
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        table: ({ children: tableChildren }) => (
          <div className="bubble-md-table-wrap">
            <table>{tableChildren}</table>
          </div>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
