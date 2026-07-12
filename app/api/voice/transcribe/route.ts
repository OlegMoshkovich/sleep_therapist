import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";

const WHISPER_MODEL = process.env.AIRLAB_OPENAI_WHISPER_MODEL ?? "whisper-1";
// Pin the transcription language so Whisper never auto-detects a different one
// (ambiguous/accented audio was occasionally being transcribed as Arabic, which
// then made the assistant reply in Arabic). Overridable per-request or via env.
const DEFAULT_WHISPER_LANGUAGE =
  process.env.AIRLAB_OPENAI_WHISPER_LANGUAGE ?? "en";

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.AIRLAB_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OpenAI API key is not configured on the server." },
      { status: 500 }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data body." }, { status: 400 });
  }

  const audio = form.get("audio");
  if (!(audio instanceof Blob)) {
    return NextResponse.json({ error: "Missing 'audio' file field." }, { status: 400 });
  }
  if (audio.size === 0) {
    return NextResponse.json({ error: "Empty audio blob." }, { status: 400 });
  }
  // Whisper limit is ~25MB; be defensive.
  if (audio.size > 25 * 1024 * 1024) {
    return NextResponse.json(
      { error: "Audio exceeds 25MB Whisper limit." },
      { status: 413 }
    );
  }

  const filename =
    audio instanceof File && audio.name ? audio.name : `voice.${extensionFor(audio.type)}`;
  const file = new File([audio], filename, { type: audio.type || "audio/webm" });

  // Optional per-request override (ISO-639-1, e.g. "en"); falls back to the
  // pinned default so we never let Whisper guess the language.
  const langField = form.get("language");
  const language =
    typeof langField === "string" && langField.trim()
      ? langField.trim().toLowerCase()
      : DEFAULT_WHISPER_LANGUAGE;

  try {
    const client = new OpenAI({ apiKey });
    const result = await client.audio.transcriptions.create({
      file,
      model: WHISPER_MODEL,
      response_format: "json",
      language,
    });
    const text = typeof result === "object" && result && "text" in result ? String((result as { text?: unknown }).text ?? "") : "";
    return NextResponse.json({ text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function extensionFor(mime: string): string {
  if (!mime) return "webm";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "webm";
}
