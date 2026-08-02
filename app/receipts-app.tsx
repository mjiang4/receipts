"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  appendFinalizedTranscript,
  flushIdleSentenceBatch,
  splitFinalizedSentences,
} from "@/lib/transcript-batching";
import {
  DEFAULT_GRANOLA_FOLDER_NAME,
  DEFAULT_GRANOLA_NOTE_LIMIT,
} from "@/lib/granola-defaults";

type AgentState =
  | "idle"
  | "listening"
  | "thinking"
  | "found"
  | "speaking";

type ProviderStatus = {
  inworld: boolean;
  granola: boolean;
  tenstorrent: boolean;
  mode: "live" | "rehearsal";
  voiceId: string;
  databaseReady: boolean;
  knowledgeSources: number;
  evidenceChunks: number;
};

type ReceiptEvidence = {
  id: string;
  sourceId: string;
  provider: "granola" | "demo";
  title: string;
  date: string;
  url: string;
  quote: string;
  speaker?: string | null;
  summary?: string | null;
};

type Receipt = {
  id: string;
  action: "speak" | "conflict";
  claim: string;
  correction: string | null;
  confidence: number;
  reason: string;
  evidence: ReceiptEvidence[];
  mode: string;
  createdAt: number;
};

type GranolaNote = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at?: string;
};

type EvaluationResult = {
  id: string;
  label: string;
  claim: string;
  expected: "speak" | "silent" | "conflict";
  actual: "speak" | "silent" | "conflict";
  note: string;
  passed: boolean;
};

type EvaluationSuite = {
  passed: number;
  total: number;
  results: EvaluationResult[];
};

type CheckRequest = {
  claim: string;
  manual: boolean;
  demoOnly: boolean;
};

type SpeechResultEvent = Event & {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

type BrowserRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

const DEFAULT_STATUS: ProviderStatus = {
  inworld: false,
  granola: false,
  tenstorrent: false,
  mode: "rehearsal",
  voiceId: "Dennis",
  databaseReady: false,
  knowledgeSources: 0,
  evidenceChunks: 0,
};

const STATE_COPY: Record<AgentState, string> = {
  idle: "Standing by",
  listening: "Listening closely",
  thinking: "Checking the record",
  found: "Receipt found",
  speaking: "Jumping in",
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const remaining = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remaining}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function normalizeForDedupe(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const stride = 0x8000;
  for (let index = 0; index < bytes.length; index += stride) {
    binary += String.fromCharCode(...bytes.subarray(index, index + stride));
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function resampleTo16k(input: Float32Array, sourceRate: number) {
  if (sourceRate === 16000) return input;
  const ratio = sourceRate / 16000;
  const output = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let total = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      total += input[sourceIndex];
    }
    output[index] = total / Math.max(1, end - start);
  }
  return output;
}

function floatToPcm16(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function Mascot({ state, compact = false }: { state: AgentState; compact?: boolean }) {
  return (
    <span
      className={cx("mascot", `mascot--${state}`, compact && "mascot--compact")}
      aria-hidden="true"
    >
      <span className="mascot__paper">
        <span className="mascot__eyes">
          <i />
          <i />
        </span>
        <span className="mascot__mouth" />
        <span className="mascot__line mascot__line--one" />
        <span className="mascot__line mascot__line--two" />
      </span>
      <span className="mascot__aura" />
    </span>
  );
}

function ReceiptCard({ receipt, featured = false }: { receipt: Receipt; featured?: boolean }) {
  const evidence = receipt.evidence[0];
  if (!evidence) return null;
  const isConflict = receipt.action === "conflict";
  const canOpen = evidence.provider === "granola" && /^https?:/.test(evidence.url);

  return (
    <article className={cx("receipt-card", featured && "receipt-card--featured", isConflict && "receipt-card--conflict")}>
      <div className="receipt-card__topline">
        <span className="receipt-card__stamp">
          {isConflict ? "Records conflict" : "Receipt found"}
        </span>
        <span className="receipt-card__confidence">
          {Math.round(receipt.confidence * 100)}% match
        </span>
      </div>
      {receipt.correction && <p className="receipt-card__correction">{receipt.correction}</p>}
      {isConflict && (
        <p className="receipt-card__correction">
          I found two relevant records that assign this differently, so I’m staying out of it.
        </p>
      )}
      <blockquote>“{evidence.quote}”</blockquote>
      <div className="receipt-card__source">
        <span className="receipt-card__source-mark">G</span>
        <span>
          <strong>{evidence.title}</strong>
          <small>
            {formatDate(evidence.date)}
            {evidence.provider === "demo" ? " · Synthetic demo" : " · Granola"}
          </small>
        </span>
        {canOpen && (
          <a href={evidence.url} target="_blank" rel="noreferrer" aria-label={`Open ${evidence.title} in Granola`}>
            ↗
          </a>
        )}
      </div>
      {receipt.evidence.length > 1 && (
        <div className="receipt-card__more">
          + {receipt.evidence.length - 1} other relevant record
        </div>
      )}
      <span className="receipt-card__tear" aria-hidden="true" />
    </article>
  );
}

export function ReceiptsApp() {
  const [joined, setJoined] = useState(false);
  const [permissionState, setPermissionState] = useState<"ready" | "requesting" | "blocked">("ready");
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [status, setStatus] = useState<ProviderStatus>(DEFAULT_STATUS);
  const [elapsed, setElapsed] = useState(0);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [caption, setCaption] = useState("");
  const [captionFinal, setCaptionFinal] = useState(false);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [drawer, setDrawer] = useState<"sources" | "evaluation" | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationSuite | null>(null);
  const [granolaNotes, setGranolaNotes] = useState<GranolaNote[]>([]);
  const [granolaLoading, setGranolaLoading] = useState(false);
  const [granolaMessage, setGranolaMessage] = useState("");
  const [granolaFolderName, setGranolaFolderName] = useState(
    DEFAULT_GRANOLA_FOLDER_NAME,
  );
  const [granolaNoteLimit, setGranolaNoteLimit] = useState(
    DEFAULT_GRANOLA_NOTE_LIMIT,
  );
  const [granolaErrorCode, setGranolaErrorCode] = useState<string | null>(null);
  const [granolaSyncState, setGranolaSyncState] = useState<
    "idle" | "loading" | "ready" | "empty" | "error"
  >("idle");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sttSocketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const ttsContextRef = useRef<AudioContext | null>(null);
  const recognitionRef = useRef<BrowserRecognition | null>(null);
  const fallbackRecognitionStartedRef = useRef(false);
  const suppressMicRef = useRef(false);
  const pcmFrameRef = useRef<number[]>([]);
  const utterancesRef = useRef<string[]>([]);
  const sentenceHistoryRef = useRef<string[]>([]);
  const pendingSentencesRef = useRef<string[]>([]);
  const sentenceBatchTimerRef = useRef<number | null>(null);
  const lastFinalRef = useRef({ fingerprint: "", capturedAt: 0 });
  const busyRef = useRef(false);
  const checkQueueRef = useRef<CheckRequest[]>([]);
  const sessionIdRef = useRef(crypto.randomUUID());
  const dedupeRef = useRef(new Map<string, number>());
  const checkClaimRef = useRef<(claim: string, manual?: boolean, demoOnly?: boolean) => void>(() => {});
  const ttsNextTimeRef = useRef(0);
  const granolaSyncInFlightRef = useRef(false);
  const defaultGranolaSyncAttemptedRef = useRef(false);

  const featuredReceipt = receipts[0] ?? null;
  const providersConfigured =
    status.inworld && status.granola && status.tenstorrent;

  const providerLabel = useMemo(() => {
    if (providersConfigured && !status.databaseReady) {
      return "Database unavailable";
    }
    if (providersConfigured && granolaLoading) {
      return `Loading ${granolaFolderName}`;
    }
    if (providersConfigured && granolaSyncState === "error") {
      return status.evidenceChunks > 0
        ? "Live · using last synced notes"
        : "Granola folder needs attention";
    }
    if (providersConfigured && granolaSyncState === "empty") {
      return `${granolaFolderName} is empty`;
    }
    if (status.mode === "live") return "Live · checking every 2–3 sentences";
    if (providersConfigured && status.evidenceChunks === 0) {
      return `Ready · loading ${granolaFolderName}`;
    }
    if (status.inworld || status.granola || status.tenstorrent) {
      return "Setup incomplete";
    }
    return "Demo mode";
  }, [
    granolaFolderName,
    granolaLoading,
    granolaSyncState,
    providersConfigured,
    status,
  ]);
  const granolaRefreshLabel =
    granolaErrorCode === "granola_default_folder_not_found" ||
    granolaErrorCode === "granola_default_folder_ambiguous" ||
    granolaErrorCode === "granola_default_folder_id_not_found"
      ? "Retry after fixing folder"
      : `Refresh latest ${granolaNoteLimit}`;

  useEffect(() => {
    Promise.all([
      fetch("/api/status").then((response) => response.json()),
      fetch("/api/evaluate").then((response) => response.json()),
    ])
      .then(([nextStatus, nextEvaluation]) => {
        setStatus({ ...DEFAULT_STATUS, ...nextStatus });
        setEvaluation(nextEvaluation);
      })
      .catch(() => {
        setStatus(DEFAULT_STATUS);
      });
  }, []);

  useEffect(() => {
    if (!joined) return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [joined]);

  const enqueueQueuedCheck = useCallback((request: CheckRequest) => {
    const fingerprint = normalizeForDedupe(request.claim);
    if (
      checkQueueRef.current.some(
        (queued) => normalizeForDedupe(queued.claim) === fingerprint,
      )
    ) {
      return;
    }

    if (checkQueueRef.current.length >= 8) {
      if (!request.manual) return;
      checkQueueRef.current.pop();
    }
    if (request.manual) checkQueueRef.current.unshift(request);
    else checkQueueRef.current.push(request);
  }, []);

  const drainQueuedCheck = useCallback(() => {
    if (busyRef.current || suppressMicRef.current) return;
    const next = checkQueueRef.current.shift();
    if (next) {
      checkClaimRef.current(next.claim, next.manual, next.demoOnly);
    }
  }, []);

  const releaseMicAfterSpeech = useCallback(() => {
    window.setTimeout(() => {
      suppressMicRef.current = false;
      setAgentState("listening");
      drainQueuedCheck();
    }, 650);
  }, [drainQueuedCheck]);

  const speakWithBrowser = useCallback(
    (text: string) => {
      if (!("speechSynthesis" in window)) {
        releaseMicAfterSpeech();
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.03;
      utterance.pitch = 0.94;
      utterance.volume = 1;
      utterance.onend = releaseMicAfterSpeech;
      utterance.onerror = releaseMicAfterSpeech;
      window.speechSynthesis.speak(utterance);
    },
    [releaseMicAfterSpeech],
  );

  const schedulePcmAudio = useCallback((encoded: string) => {
    const bytes = base64ToBytes(encoded);
    let dataOffset = 0;
    let sampleRate = 24000;

    if (
      bytes.length > 44 &&
      String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      sampleRate = view.getUint32(24, true) || 24000;
      for (let index = 12; index + 8 < bytes.length; ) {
        const label = String.fromCharCode(...bytes.subarray(index, index + 4));
        const size = view.getUint32(index + 4, true);
        if (label === "data") {
          dataOffset = index + 8;
          break;
        }
        index += 8 + size + (size % 2);
      }
    }

    const sampleBytes = bytes.subarray(dataOffset);
    const sampleCount = Math.floor(sampleBytes.byteLength / 2);
    if (!sampleCount) return 0;
    const context =
      ttsContextRef.current ?? audioContextRef.current ?? new AudioContext();
    ttsContextRef.current = context;
    void context.resume();
    const buffer = context.createBuffer(1, sampleCount, sampleRate);
    const channel = buffer.getChannelData(0);
    const view = new DataView(
      sampleBytes.buffer,
      sampleBytes.byteOffset,
      sampleCount * 2,
    );
    for (let index = 0; index < sampleCount; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 32768;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const scheduled = Math.max(
      context.currentTime + 0.035,
      ttsNextTimeRef.current,
    );
    source.start(scheduled);
    const end = scheduled + buffer.duration;
    ttsNextTimeRef.current = end;
    return Math.max(0, end - context.currentTime);
  }, []);

  const speakWithInworld = useCallback(
    (text: string, voiceId: string) => {
      let settled = false;
      let heardAudio = false;
      let remainingSeconds = 0;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/inworld/tts`);
      let hardStopTimer = 0;

      const finishAfterProviderFailure = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(fallbackTimer);
        window.clearTimeout(hardStopTimer);
        if (heardAudio) {
          window.setTimeout(
            releaseMicAfterSpeech,
            remainingSeconds * 1000 + 120,
          );
        } else {
          speakWithBrowser(text);
        }
      };

      const fallbackTimer = window.setTimeout(() => {
        if (!heardAudio && !settled) {
          settled = true;
          window.clearTimeout(hardStopTimer);
          socket.close();
          speakWithBrowser(text);
        }
      }, 2500);
      hardStopTimer = window.setTimeout(() => {
        if (settled) return;
        socket.close();
        finishAfterProviderFailure();
      }, 15_000);

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            create: {
              voiceId,
              modelId: "inworld-tts-2",
              audioConfig: {
                audioEncoding: "LINEAR16",
                sampleRateHertz: 24000,
              },
              bufferCharThreshold: 40,
              autoMode: true,
              timestampType: "WORD",
              timestampTransportStrategy: "ASYNC",
            },
            contextId: "receipts",
          }),
        );
        socket.send(
          JSON.stringify({
            send_text: { text, flush_context: {} },
            contextId: "receipts",
          }),
        );
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          const result = message.result;
          if (result?.audioChunk?.audioContent) {
            heardAudio = true;
            remainingSeconds = Math.max(
              remainingSeconds,
              schedulePcmAudio(result.audioChunk.audioContent),
            );
          }
          if (result?.flushCompleted && !settled) {
            settled = true;
            window.clearTimeout(fallbackTimer);
            window.clearTimeout(hardStopTimer);
            window.setTimeout(releaseMicAfterSpeech, remainingSeconds * 1000 + 120);
            socket.send(
              JSON.stringify({ close_context: {}, contextId: "receipts" }),
            );
          }
        } catch {
          // Ignore malformed provider events; silence is safer than retrying speech.
        }
      };
      socket.onerror = () => {
        finishAfterProviderFailure();
      };
      socket.onclose = () => {
        finishAfterProviderFailure();
      };
    },
    [releaseMicAfterSpeech, schedulePcmAudio, speakWithBrowser],
  );

  const speakCorrection = useCallback(
    (text: string) => {
      suppressMicRef.current = true;
      setAgentState("speaking");
      if (status.inworld) speakWithInworld(text, status.voiceId);
      else speakWithBrowser(text);
    },
    [speakWithBrowser, speakWithInworld, status.inworld, status.voiceId],
  );

  const checkClaim = useCallback(
    async (claim: string, manual = false, demoOnly = false) => {
      const trimmed = claim.trim();
      if (!trimmed) {
        drainQueuedCheck();
        return;
      }
      const boundedClaim =
        trimmed.length > 6_000 ? trimmed.slice(-6_000) : trimmed;
      if (busyRef.current || suppressMicRef.current) {
        enqueueQueuedCheck({ claim: boundedClaim, manual, demoOnly });
        return;
      }

      const normalized = normalizeForDedupe(boundedClaim);
      const lastSeen = dedupeRef.current.get(normalized) ?? 0;
      if (!manual && Date.now() - lastSeen < 45_000) {
        drainQueuedCheck();
        return;
      }
      dedupeRef.current.set(normalized, Date.now());
      busyRef.current = true;
      const requestSessionId = sessionIdRef.current;
      setAgentState("thinking");

      try {
        const sentences = splitFinalizedSentences(boundedClaim).slice(-5);
        const response = await fetch("/api/judge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: requestSessionId,
            claim: boundedClaim,
            sentences: sentences.length ? sentences : [boundedClaim],
            utterances: utterancesRef.current
              .slice(-5)
              .map((utterance) => utterance.slice(-2_000)),
            manual,
            demoOnly,
          }),
        });
        const decision = await response.json();
        if (!response.ok) {
          throw new Error(decision.error ?? "Fact-checker unavailable");
        }
        if (requestSessionId !== sessionIdRef.current) return;

        if (decision.action === "speak" || decision.action === "conflict") {
          const receipt: Receipt = {
            ...decision,
            id: crypto.randomUUID(),
            createdAt: Date.now(),
          };
          setReceipts((current) => [receipt, ...current].slice(0, 5));
          setAgentState("found");
          if (decision.action === "speak" && decision.correction) {
            suppressMicRef.current = true;
            window.setTimeout(() => speakCorrection(decision.correction), 180);
          } else {
            window.setTimeout(() => setAgentState("listening"), 1600);
          }
        } else {
          setAgentState("listening");
        }
      } catch {
        setAgentState("listening");
      } finally {
        busyRef.current = false;
        drainQueuedCheck();
      }
    },
    [
      drainQueuedCheck,
      enqueueQueuedCheck,
      speakCorrection,
    ],
  );
  useEffect(() => {
    checkClaimRef.current = checkClaim;
  }, [checkClaim]);

  const handleFinalTranscript = useCallback((text: string) => {
    const cleaned = text.trim();
    if (!cleaned || suppressMicRef.current) return;
    const fingerprint = normalizeForDedupe(cleaned);
    const capturedAt = Date.now();
    if (
      fingerprint === lastFinalRef.current.fingerprint &&
      capturedAt - lastFinalRef.current.capturedAt < 2_000
    ) {
      return;
    }
    lastFinalRef.current = { fingerprint, capturedAt };

    if (sentenceBatchTimerRef.current !== null) {
      window.clearTimeout(sentenceBatchTimerRef.current);
      sentenceBatchTimerRef.current = null;
    }
    utterancesRef.current = [...utterancesRef.current, cleaned].slice(-5);
    const finalizedSentences = splitFinalizedSentences(cleaned);
    sentenceHistoryRef.current = [
      ...sentenceHistoryRef.current,
      ...finalizedSentences,
    ].slice(-8);
    setCaption(cleaned);
    setCaptionFinal(true);
    void fetch("/api/transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sessionIdRef.current,
        text: cleaned,
      }),
    }).catch(() => undefined);

    const update = appendFinalizedTranscript(
      pendingSentencesRef.current,
      cleaned,
    );
    pendingSentencesRef.current = update.pending;
    for (const batch of update.batches) {
      checkClaimRef.current(batch.join(" "), false, false);
    }

    if (pendingSentencesRef.current.length >= 2) {
      sentenceBatchTimerRef.current = window.setTimeout(() => {
        const flushed = flushIdleSentenceBatch(pendingSentencesRef.current);
        pendingSentencesRef.current = flushed.pending;
        sentenceBatchTimerRef.current = null;
        if (flushed.batch) {
          checkClaimRef.current(flushed.batch.join(" "), false, false);
        }
      }, 1_500);
    }
  }, []);

  const manuallyCheckRecentSpeech = useCallback(() => {
    if (sentenceBatchTimerRef.current !== null) {
      window.clearTimeout(sentenceBatchTimerRef.current);
      sentenceBatchTimerRef.current = null;
    }
    const pending = pendingSentencesRef.current.slice(0, 3);
    if (pending.length) {
      pendingSentencesRef.current = pendingSentencesRef.current.slice(
        pending.length,
      );
    }
    const recent = pending.length
      ? pending
      : sentenceHistoryRef.current.slice(-3);
    const claim =
      recent.join(" ") || utterancesRef.current.slice(-5).join(" ");
    checkClaim(claim, true, false);
  }, [checkClaim]);

  const startBrowserRecognition = useCallback(() => {
    if (fallbackRecognitionStartedRef.current) return;
    const recognitionConstructor = (
      window as unknown as {
        SpeechRecognition?: new () => BrowserRecognition;
        webkitSpeechRecognition?: new () => BrowserRecognition;
      }
    ).SpeechRecognition ??
      (
        window as unknown as {
          webkitSpeechRecognition?: new () => BrowserRecognition;
        }
      ).webkitSpeechRecognition;
    if (!recognitionConstructor) return;

    const recognition = new recognitionConstructor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript?.trim();
        if (!text || suppressMicRef.current) continue;
        setCaption(text);
        setCaptionFinal(result.isFinal);
        setAgentState("listening");
        if (result.isFinal) handleFinalTranscript(text);
      }
    };
    recognition.onerror = () => undefined;
    recognition.onend = () => {
      if (joined && micOn && !suppressMicRef.current) {
        try {
          recognition.start();
        } catch {
          // Browser recognition can reject an immediate restart.
        }
      }
    };
    recognitionRef.current = recognition;
    fallbackRecognitionStartedRef.current = true;
    try {
      recognition.start();
    } catch {
      fallbackRecognitionStartedRef.current = false;
    }
  }, [handleFinalTranscript, joined, micOn]);

  const openSttSocket = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/inworld/stt`);
    sttSocketRef.current = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      socket.send(
        JSON.stringify({
          transcribeConfig: {
            modelId: "inworld/inworld-stt-1",
            audioEncoding: "LINEAR16",
            sampleRateHertz: 16000,
            numberOfChannels: 1,
            language: "en-US",
            endOfTurnConfidenceThreshold: 0.72,
            inworldSttV1Config: {
              minEndOfTurnSilenceWhenConfident: 520,
              vadThreshold: 0.5,
            },
          },
        }),
      );
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        const result = message.result;
        if (result?.speechStarted && !suppressMicRef.current) {
          setAgentState("listening");
          setCaptionFinal(false);
        }
        if (result?.transcription?.transcript && !suppressMicRef.current) {
          const text = result.transcription.transcript.trim();
          setCaption(text);
          setCaptionFinal(Boolean(result.transcription.isFinal));
          if (result.transcription.isFinal) handleFinalTranscript(text);
        }
      } catch {
        // Ignore malformed provider events and keep the meeting alive.
      }
    };
    socket.onerror = () => {
      if (!opened) startBrowserRecognition();
    };
    socket.onclose = () => {
      if (joined && !suppressMicRef.current) startBrowserRecognition();
    };
  }, [handleFinalTranscript, joined, startBrowserRecognition]);

  const startAudioPipeline = useCallback(async (stream: MediaStream) => {
    try {
      const context = new AudioContext();
      audioContextRef.current = context;
      await context.audioWorklet.addModule("/pcm-worklet.js");
      const source = context.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(context, "pcm-worklet");
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);
      processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (suppressMicRef.current || !micOn) return;
        const socket = sttSocketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const resampled = resampleTo16k(event.data, context.sampleRate);
        const pending = pcmFrameRef.current;
        for (let index = 0; index < resampled.length; index += 1) {
          pending.push(resampled[index]);
        }
        while (pending.length >= 1600) {
          const frame = new Float32Array(pending.splice(0, 1600));
          const pcm = floatToPcm16(frame);
          socket.send(
            JSON.stringify({
              audioChunk: {
                content: bytesToBase64(new Uint8Array(pcm.buffer)),
              },
            }),
          );
        }
      };
    } catch {
      startBrowserRecognition();
    }
  }, [micOn, startBrowserRecognition]);

  const joinMeeting = useCallback(async () => {
    setPermissionState("requesting");
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
          video: false,
        });
        setCameraOn(false);
      }
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setJoined(true);
      setPermissionState("ready");
      setAgentState("listening");
      openSttSocket();
      await startAudioPipeline(stream);
    } catch {
      setPermissionState("blocked");
    }
  }, [openSttSocket, startAudioPipeline]);

  useEffect(() => {
    if (joined && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [joined]);

  const toggleMic = useCallback(() => {
    const next = !micOn;
    setMicOn(next);
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = next;
    });
    if (!next) {
      suppressMicRef.current = true;
      recognitionRef.current?.stop();
      fallbackRecognitionStartedRef.current = false;
    } else {
      suppressMicRef.current = false;
      setAgentState("listening");
      if (!status.inworld) startBrowserRecognition();
      drainQueuedCheck();
    }
  }, [drainQueuedCheck, micOn, startBrowserRecognition, status.inworld]);

  const toggleCamera = useCallback(() => {
    const next = !cameraOn;
    setCameraOn(next);
    streamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = next;
    });
  }, [cameraOn]);

  const leaveMeeting = useCallback(() => {
    try {
      sttSocketRef.current?.send(JSON.stringify({ closeStream: {} }));
    } catch {
      // The socket may already be closed.
    }
    sttSocketRef.current?.close();
    recognitionRef.current?.stop();
    audioContextRef.current?.close().catch(() => undefined);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (sentenceBatchTimerRef.current !== null) {
      window.clearTimeout(sentenceBatchTimerRef.current);
      sentenceBatchTimerRef.current = null;
    }
    suppressMicRef.current = false;
    pendingSentencesRef.current = [];
    sentenceHistoryRef.current = [];
    utterancesRef.current = [];
    checkQueueRef.current = [];
    dedupeRef.current.clear();
    lastFinalRef.current = { fingerprint: "", capturedAt: 0 };
    setJoined(false);
    setAgentState("idle");
    setCaption("");
    setElapsed(0);
    fallbackRecognitionStartedRef.current = false;
    sessionIdRef.current = crypto.randomUUID();
  }, []);

  const syncDefaultGranola = useCallback(async () => {
    if (granolaSyncInFlightRef.current) return;
    granolaSyncInFlightRef.current = true;
    setGranolaLoading(true);
    setGranolaSyncState("loading");
    setGranolaErrorCode(null);
    setGranolaMessage(
      `Loading the latest notes from “${granolaFolderName}”…`,
    );
    try {
      const response = await fetch("/api/granola/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useDefaultFolder: true }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setGranolaErrorCode(
          typeof payload.code === "string" ? payload.code : "granola_sync_failed",
        );
        throw new Error(payload.error ?? "Unable to load the default Granola folder");
      }

      const folderName = payload.folder?.name || DEFAULT_GRANOLA_FOLDER_NAME;
      const noteLimit =
        Number.isSafeInteger(payload.limit) && payload.limit > 0
          ? payload.limit
          : DEFAULT_GRANOLA_NOTE_LIMIT;
      const notes: GranolaNote[] = payload.notes ?? [];
      setGranolaFolderName(folderName);
      setGranolaNoteLimit(noteLimit);
      setGranolaNotes(notes);
      if (notes.length) {
        setGranolaSyncState("ready");
        setGranolaMessage(
          notes.length === noteLimit
            ? `The latest ${notes.length} notes from “${folderName}” are ready for fact-checking.`
            : `All ${notes.length} completed note${notes.length === 1 ? "" : "s"} from “${folderName}” are ready for fact-checking.`,
        );
      } else {
        setGranolaSyncState("empty");
        setGranolaMessage(
          `No completed notes yet. Add a meeting with a generated transcript to “${folderName}”, then refresh.`,
        );
      }

      try {
        const statusResponse = await fetch("/api/status");
        if (statusResponse.ok) {
          const nextStatus = await statusResponse.json();
          setStatus({ ...DEFAULT_STATUS, ...nextStatus });
        }
      } catch {
        // The corpus is ready even if this optional badge refresh fails.
      }
    } catch (error) {
      setGranolaSyncState("error");
      setGranolaMessage(
        error instanceof Error ? error.message : "Unable to load Granola",
      );
    } finally {
      granolaSyncInFlightRef.current = false;
      setGranolaLoading(false);
    }
  }, [granolaFolderName]);

  useEffect(() => {
    if (
      defaultGranolaSyncAttemptedRef.current ||
      !status.granola ||
      !status.databaseReady
    ) {
      return;
    }
    defaultGranolaSyncAttemptedRef.current = true;
    void syncDefaultGranola();
  }, [status.databaseReady, status.granola, syncDefaultGranola]);

  const loadGranola = useCallback(() => {
    setDrawer("sources");
    if (granolaSyncState === "idle" || granolaSyncState === "error") {
      void syncDefaultGranola();
    }
  }, [granolaSyncState, syncDefaultGranola]);

  return (
    <main className={cx("app-shell", joined && "app-shell--meeting")}>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Receipts home">
          <span className="brand__mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Receipts</span>
          <sup>β</sup>
        </a>
        <div className="topbar__center">
          {joined ? (
            <>
              <strong>Weekly product sync</strong>
              <span>{formatDuration(elapsed)}</span>
            </>
          ) : (
            <span className="privacy-note"><i /> Private by default</span>
          )}
        </div>
        <div className="topbar__actions">
          <button className="text-button" onClick={loadGranola}>
            Sources <span>{status.knowledgeSources || "·"}</span>
          </button>
          <button className="text-button" onClick={() => setDrawer("evaluation")}>
            Eval <span>{evaluation ? `${evaluation.passed}/${evaluation.total}` : "·"}</span>
          </button>
        </div>
      </header>

      {!joined ? (
        <section className="prejoin" id="top">
          <div className="prejoin__copy">
            <span className="eyebrow"><i /> Your live fact-checker</span>
            <h1>Your meetings,<br />with a <em>memory.</em></h1>
            <p>
              Receipts listens for the facts that matter, checks the company record,
              and speaks up when something doesn’t add up.
            </p>
            <div className="prejoin__actions">
              <button className="primary-button" onClick={joinMeeting} disabled={permissionState === "requesting"}>
                {permissionState === "requesting" ? "Opening the room…" : "Enter the demo room"}
                <span>→</span>
              </button>
              <button className="secondary-button" onClick={() => setDrawer("evaluation")}>
                See test cases
              </button>
            </div>
            {permissionState === "blocked" && (
              <p className="permission-error">
                Microphone access is required. Allow it in your browser, then try again.
              </p>
            )}
            <div className="provider-row">
              <span className={cx(status.inworld && "is-ready")}><i /> Inworld voice</span>
              <span className={cx(status.tenstorrent && "is-ready")}><i /> Tenstorrent fact-checker</span>
              <span className={cx(status.granola && "is-ready")}><i /> Granola memory</span>
            </div>
          </div>

          <div className="prejoin__stage">
            <div className="preview-window">
              <div className="preview-window__chrome">
                <span><i /><i /><i /></span>
                <small>receipts.room / weekly-sync</small>
                <b>{providerLabel}</b>
              </div>
              <div className="preview-window__call">
                <div className="preview-person">
                  <span className="preview-person__avatar">J</span>
                  <span className="name-tag">You <i /></span>
                </div>
                <div className="preview-receipt">
                  <div className="preview-receipt__header">
                    <Mascot state="found" compact />
                    <span><small>RECEIPT FOUND</small><strong>Launch date</strong></span>
                  </div>
                  <p>“We’re locking the public launch for Friday, August 7.”</p>
                  <span>Product standup · Jul 28</span>
                </div>
                <div className="preview-listening">
                  <Mascot state="listening" compact />
                  <span><strong>Receipts is listening</strong><small>Checking every 2–3 sentences</small></span>
                  <i /><i /><i /><i />
                </div>
              </div>
            </div>
            <div className="floating-quote floating-quote--one">“Friday, not Monday.”</div>
            <div className="floating-quote floating-quote--two">source attached ↗</div>
          </div>
        </section>
      ) : (
        <section className="meeting-room">
          <div className="call-stage">
            <div className="call-stage__status">
              <span className={cx("live-pill", status.mode === "live" && "live-pill--connected")}>
                <i /> {providerLabel}
              </span>
              <span className="secure-pill">
                {!micOn
                  ? "Mic paused"
                  : agentState === "speaking"
                    ? "Receipts is speaking"
                    : "Checks every 2–3 sentences"}
              </span>
            </div>

            <div className="participant-tile">
              <video ref={videoRef} autoPlay muted playsInline className={cx(!cameraOn && "is-hidden")} />
              {!cameraOn && <div className="camera-placeholder"><span>J</span></div>}
              <div className="participant-tile__shade" />
              <span className="participant-label">Jerry <i className={cx(!micOn && "is-muted")} /></span>
              {caption && (
                <div className={cx("live-caption", captionFinal && "live-caption--final")}>
                  {caption}
                </div>
              )}
            </div>

            <aside className={cx("judge-dock", `judge-dock--${agentState}`)}>
              <div className="judge-dock__identity">
                <Mascot state={agentState} />
                <span>
                  <small>RECEIPTS</small>
                  <strong>{STATE_COPY[agentState]}</strong>
                </span>
              </div>
              <div className="sound-bars" aria-hidden="true">
                {Array.from({ length: 18 }, (_, index) => <i key={index} />)}
              </div>
              <p>
                {agentState === "speaking"
                  ? featuredReceipt?.correction
                  : agentState === "thinking"
                    ? "Checking the latest sentence batch against your synced sources…"
                    : "I check every 2–3 sentences and interrupt when a source directly contradicts the conversation."}
              </p>
            </aside>

            {featuredReceipt && (
              <div className="receipt-overlay">
                <ReceiptCard receipt={featuredReceipt} featured />
              </div>
            )}

            <div className="control-dock" role="toolbar" aria-label="Meeting controls">
              <button className={cx("round-control", !micOn && "is-off")} onClick={toggleMic} aria-label={micOn ? "Mute microphone" : "Unmute microphone"}>
                <span>{micOn ? "●" : "×"}</span><small>Mic</small>
              </button>
              <button className={cx("round-control", !cameraOn && "is-off")} onClick={toggleCamera} aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}>
                <span>▰</span><small>Camera</small>
              </button>
              <button className="check-control" onClick={manuallyCheckRecentSpeech}>
                <Mascot state="listening" compact />
                <span><strong>Check that</strong><small>Last few moments</small></span>
              </button>
              <button className="round-control" onClick={loadGranola} aria-label="Open sources">
                <span>≡</span><small>Sources</small>
              </button>
              <button className="round-control round-control--end" onClick={leaveMeeting} aria-label="Leave meeting">
                <span>×</span><small>Leave</small>
              </button>
            </div>
          </div>
        </section>
      )}

      {drawer && (
        <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setDrawer(null)}>
          <aside className="drawer" aria-label={drawer === "sources" ? "Knowledge sources" : "Evaluation suite"}>
            <div className="drawer__header">
              <span className="eyebrow"><i /> {drawer === "sources" ? "Company memory" : "Fact-check evaluation"}</span>
              <button onClick={() => setDrawer(null)} aria-label="Close panel">×</button>
            </div>

            {drawer === "sources" ? (
              <div className="drawer__body sources-panel">
                <h2>“{granolaFolderName}” syncs when Receipts opens.</h2>
                <p>Receipts loads the {granolaNoteLimit} most recent completed notes at startup and whenever you refresh.</p>
                <div className="source-summary">
                  <span className="source-summary__mark">G</span>
                  <span>
                    <strong>Granola · {granolaFolderName}</strong>
                    <small>
                      {granolaLoading
                        ? "Loading latest notes"
                        : granolaNotes.length
                          ? `${granolaNotes.length} recent note${granolaNotes.length === 1 ? "" : "s"} ready`
                          : granolaSyncState === "error"
                            ? "Folder needs attention"
                            : granolaSyncState === "empty"
                              ? "No completed notes"
                          : status.granola
                            ? "Waiting for completed notes"
                            : "API key needed"}
                    </small>
                  </span>
                  <i className={cx(granolaSyncState === "ready" && "is-ready")} />
                </div>
                {granolaLoading && <div className="panel-loading"><i /><i /><i /> Working on it</div>}
                {granolaMessage && <div className="panel-message">{granolaMessage}</div>}
                <div className="note-picker">
                  {granolaNotes.map((note) => (
                    <div className="note-picker__item" key={note.id}>
                      <i aria-hidden="true">✓</i>
                      <span><strong>{note.title || "Untitled meeting"}</strong><small>{formatDate(note.created_at)}</small></span>
                    </div>
                  ))}
                </div>
                <button className="primary-button primary-button--panel" disabled={granolaLoading || !status.granola} onClick={syncDefaultGranola}>
                  {granolaRefreshLabel} <span>→</span>
                </button>
                <div className="index-stat">
                  <strong>{status.knowledgeSources}</strong><span>source notes</span>
                  <strong>{status.evidenceChunks}</strong><span>searchable moments</span>
                </div>
              </div>
            ) : (
              <div className="drawer__body evaluation-panel">
                <div className="eval-score">
                  <span>{evaluation?.passed ?? "–"}<small>/{evaluation?.total ?? "–"}</small></span>
                  <div><strong>Fact checks passing</strong><p>Every 2–3 sentence batch is checked; interruptions still require direct evidence.</p></div>
                </div>
                <div className="eval-list">
                  {evaluation?.results.map((result, index) => (
                    <article key={result.id}>
                      <span className={cx("eval-result", result.passed && "is-passing")}>{result.passed ? "✓" : "!"}</span>
                      <div>
                        <small>0{index + 1} · EXPECT {result.expected.toUpperCase()}</small>
                        <strong>{result.label}</strong>
                        <p>“{result.claim}”</p>
                        <em>{result.note}</em>
                      </div>
                      <button onClick={() => {
                        setDrawer(null);
                        if (!joined) void joinMeeting().then(() => window.setTimeout(() => checkClaimRef.current(result.claim, true, true), 700));
                        else checkClaimRef.current(result.claim, true, true);
                      }}>Run</button>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
