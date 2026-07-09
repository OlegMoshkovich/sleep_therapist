import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";

const TTS_MODEL = process.env.AIRLAB_OPENAI_TTS_MODEL ?? "tts-1";
const TTS_VOICE = process.env.AIRLAB_OPENAI_TTS_VOICE ?? "onyx";
// Guardrail: keep any single utterance small enough to feel responsive.
const MAX_INPUT_CHARS = 4000;

type SpeakBody = {
  text?: string;
  voice?: string;
  format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
};

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

  let body: SpeakBody;
  try {
    body = (await request.json()) as SpeakBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const text = (body.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "'text' is required." }, { status: 400 });
  }
  const input = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;

  const voice = normalizeVoice(body.voice ?? TTS_VOICE);
  const format = body.format ?? "mp3";

  try {
    const client = new OpenAI({ apiKey });
    const speech = await client.audio.speech.create({
      model: TTS_MODEL,
      voice,
      input,
      response_format: format,
    });
    // OpenAI returns a Response-like object; use .arrayBuffer() for full-buffered mp3.
    const buffer = Buffer.from(await speech.arrayBuffer());
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": mimeFor(format),
        "Cache-Control": "no-store",
        "Content-Length": String(buffer.byteLength),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Text-to-speech failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

const ALLOWED_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
]);

function normalizeVoice(voice: string): OpenAI.Audio.SpeechCreateParams["voice"] {
  const v = voice.toLowerCase().trim();
  return (ALLOWED_VOICES.has(v)
    ? v
    : "onyx") as OpenAI.Audio.SpeechCreateParams["voice"];
}

function mimeFor(format: string): string {
  switch (format) {
    case "opus":
      return "audio/ogg";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "wav":
      return "audio/wav";
    case "pcm":
      return "audio/pcm";
    case "mp3":
    default:
      return "audio/mpeg";
  }
}
