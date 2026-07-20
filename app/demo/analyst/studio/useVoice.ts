"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── Browser SpeechRecognition (Web Speech API) ambient types ────────────
// Not all TypeScript DOM lib versions expose SpeechRecognition, and Safari
// / older Chrome ship the webkit-prefixed variant. Declare the minimum
// shape we depend on so the hook stays type-safe without a full polyfill.
interface SRResultAlternative {
  transcript: string;
  confidence: number;
}
interface SRResult {
  0: SRResultAlternative;
  isFinal: boolean;
  length: number;
}
interface SRResultList {
  length: number;
  [index: number]: SRResult;
}
interface SREvent extends Event {
  resultIndex: number;
  results: SRResultList;
}
interface SRErrorEvent extends Event {
  error?: string;
  message?: string;
}
interface SRInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives?: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SRCtor = new () => SRInstance;

function getSpeechRecognitionCtor(): SRCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SRCtor;
    webkitSpeechRecognition?: SRCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True when the current browser can stream interim transcripts client-side. */
export function isLiveSpeechSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

/**
 * Records audio from the user's microphone and posts it to
 * `POST /api/voice/transcribe` (OpenAI Whisper). `onTranscript` fires with the
 * final text once recording stops and the server returns a transcription.
 *
 * When the browser supports `SpeechRecognition` (Chrome/Edge/Safari), a
 * parallel Web Speech session streams interim transcripts through
 * `onInterim(text)` while the user is speaking, so the caller can update the
 * input field live. Whisper still runs on stop and — if it succeeds — its
 * transcript wins over the browser's (higher accuracy); if Whisper fails, we
 * fall back to whatever the browser recognized so the message isn't lost.
 *
 * The hook holds its own MediaRecorder + MediaStream and releases the mic
 * (calls `MediaStreamTrack.stop()` on every track) as soon as recording stops
 * or the component unmounts.
 */
export function useVoiceRecorder(opts: {
  onTranscript: (text: string) => void;
  /** Fires many times while recording with the running transcript (browser SR). */
  onInterim?: (text: string) => void;
  onError?: (message: string) => void;
  /** Hard cap for a single recording; auto-stops after this many ms. Default 60s. */
  maxDurationMs?: number;
  /** Language for browser SpeechRecognition. Default: browser's `navigator.language`. */
  language?: string;
}) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  // Refs so timers/handlers always see the current callbacks without needing
  // to be recreated on every parent render.
  const onTranscriptRef = useRef(opts.onTranscript);
  const onInterimRef = useRef(opts.onInterim);
  const onErrorRef = useRef(opts.onError);
  useEffect(() => {
    onTranscriptRef.current = opts.onTranscript;
    onInterimRef.current = opts.onInterim;
    onErrorRef.current = opts.onError;
  }, [opts.onTranscript, opts.onInterim, opts.onError]);

  const maxDurationMs = opts.maxDurationMs ?? 60_000;
  const language = opts.language;

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Browser-side live recognition (parallel channel to Whisper).
  const recognitionRef = useRef<SRInstance | null>(null);
  const browserFinalRef = useRef("");
  const browserInterimRef = useRef("");

  const stopBrowserRecognition = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    rec.onstart = null;
    try {
      rec.stop();
    } catch {
      // ignore — some engines throw if already stopped
    }
    recognitionRef.current = null;
  }, []);

  const releaseMic = useCallback(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    stopBrowserRecognition();
  }, [stopBrowserRecognition]);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        // ignore — releaseMic below handles cleanup
      }
    }
    // Stop browser recognition eagerly so any final results flush immediately.
    // (recognitionRef will be nulled out; the audio side finishes independently.)
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }
  }, []);

  const cancel = useCallback(() => {
    // Detach handlers so the pending recording is discarded rather than sent.
    const rec = recorderRef.current;
    if (rec) {
      rec.ondataavailable = null;
      rec.onstop = null;
      if (rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          // ignore
        }
      }
    }
    chunksRef.current = [];
    browserFinalRef.current = "";
    browserInterimRef.current = "";
    releaseMic();
    setIsRecording(false);
    setIsTranscribing(false);
  }, [releaseMic]);

  const startBrowserRecognition = useCallback(() => {
    if (!onInterimRef.current) return; // caller doesn't care about live text
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    try {
      const recognition = new Ctor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang =
        language ??
        (typeof navigator !== "undefined" ? navigator.language : null) ??
        "en-US";
      browserFinalRef.current = "";
      browserInterimRef.current = "";

      recognition.onresult = (event: SREvent) => {
        let addedFinal = "";
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const alt = result[0];
          if (!alt) continue;
          if (result.isFinal) {
            addedFinal += alt.transcript;
          } else {
            interim += alt.transcript;
          }
        }
        if (addedFinal) {
          browserFinalRef.current = joinTranscripts(
            browserFinalRef.current,
            addedFinal.trim()
          );
        }
        browserInterimRef.current = interim.trim();
        const combined = joinTranscripts(
          browserFinalRef.current,
          browserInterimRef.current
        );
        onInterimRef.current?.(combined);
      };

      recognition.onerror = (e: SRErrorEvent) => {
        // Chrome fires "no-speech" if the user was silent — treat as harmless.
        // Other errors we surface once so the caller can hint at the mic state.
        const code = e.error ?? "";
        if (code && code !== "no-speech" && code !== "aborted") {
          onErrorRef.current?.(`Speech recognition: ${code}`);
        }
      };

      recognition.onend = () => {
        // Chrome auto-stops after a period of silence even with continuous=true.
        // If we're still recording, keep it alive so the user can pause naturally.
        if (recognitionRef.current === recognition && recorderRef.current) {
          try {
            recognition.start();
          } catch {
            // ignore — usually means it's still stopping; state will resettle.
          }
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch {
      // Browser blew up starting recognition; live text just won't happen.
      recognitionRef.current = null;
    }
  }, [language]);

  const start = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (recorderRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onErrorRef.current?.("Voice input isn't supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      browserFinalRef.current = "";
      browserInterimRef.current = "";

      // Prefer webm/opus (best cross-browser fit for Whisper), fall back to
      // whatever the browser gives us if it isn't supported (e.g. Safari mp4).
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
      const mime = preferred.find(
        (m) => typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(m)
      );
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        setIsRecording(false);
        const type = recorder.mimeType || mime || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        // Capture whatever the browser managed to hear before we tear it down,
        // so we can fall back to it if Whisper fails or the blob is too short.
        const browserFinal = joinTranscripts(
          browserFinalRef.current,
          browserInterimRef.current
        ).trim();
        releaseMic();

        // Ignore effectively silent taps (< ~300ms of audio) — but if the
        // browser somehow heard something (e.g. user tapped and spoke very
        // briefly), keep that as a fallback.
        const audioTooSmall = blob.size < 2500;

        if (!audioTooSmall) {
          setIsTranscribing(true);
          try {
            const form = new FormData();
            const ext = type.includes("mp4") ? "m4a" : "webm";
            form.append("audio", blob, `voice.${ext}`);
            const res = await fetch("/api/voice/transcribe", {
              method: "POST",
              body: form,
            });
            if (!res.ok) {
              const detail = await safeErrorMessage(res);
              throw new Error(detail || `Transcription failed (HTTP ${res.status})`);
            }
            const { text } = (await res.json()) as { text?: string };
            const trimmed = (text ?? "").trim();
            if (trimmed) {
              onTranscriptRef.current(trimmed);
              return;
            }
          } catch (err) {
            // Fall through to browser fallback below; only surface the error
            // if we also have nothing from the browser to send.
            if (!browserFinal) {
              onErrorRef.current?.(
                err instanceof Error ? err.message : "Voice transcription failed."
              );
              return;
            }
          } finally {
            setIsTranscribing(false);
          }
        }

        // Whisper skipped or empty — use whatever the browser heard, if anything.
        if (browserFinal) onTranscriptRef.current(browserFinal);
      };

      recorder.start();
      setIsRecording(true);

      // Kick off live browser recognition (best-effort — quiet no-op if unsupported).
      startBrowserRecognition();

      // Safety: auto-stop very long recordings so we don't burn the mic
      // (and Whisper credits) if the user forgets to tap again.
      stopTimerRef.current = setTimeout(() => {
        stop();
      }, maxDurationMs);
    } catch (err) {
      releaseMic();
      const message =
        err instanceof Error && /permission|denied|NotAllowed/i.test(err.message)
          ? "Microphone permission was denied."
          : err instanceof Error
            ? err.message
            : "Couldn't start the microphone.";
      onErrorRef.current?.(message);
    }
  }, [maxDurationMs, releaseMic, startBrowserRecognition, stop]);

  const toggle = useCallback(() => {
    if (isRecording) stop();
    else void start();
  }, [isRecording, start, stop]);

  useEffect(() => {
    return () => {
      cancel();
    };
  }, [cancel]);

  return { isRecording, isTranscribing, start, stop, toggle, cancel };
}

/**
 * Fetches synthesized speech from `POST /api/voice/speak` (OpenAI TTS) and
 * plays it in a single <Audio> element that we own. Calling `speak` while
 * another utterance is playing cancels the previous one first.
 */
export function useTTS() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cleanupAudio = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      try {
        a.pause();
      } catch {
        // ignore
      }
      a.removeAttribute("src");
      a.load();
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    cleanupAudio();
    setIsSpeaking(false);
  }, [cleanupAudio]);

  const speak = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      stop();

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/voice/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: clean }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`TTS failed (HTTP ${res.status})`);
        }
        const blob = await res.blob();
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;

        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          setIsSpeaking(false);
          cleanupAudio();
        };
        audio.onerror = () => {
          setIsSpeaking(false);
          cleanupAudio();
        };
        setIsSpeaking(true);
        await audio.play();
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        setIsSpeaking(false);
        cleanupAudio();
      }
    },
    [cleanupAudio, stop]
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      cleanupAudio();
    };
  }, [cleanupAudio]);

  return { speak, stop, isSpeaking };
}

/** Concatenate two transcript fragments with a single space; skip empties. */
function joinTranscripts(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

async function safeErrorMessage(res: Response): Promise<string | null> {
  try {
    const clone = res.clone();
    const data = await clone.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // ignore — fall through
  }
  return null;
}
