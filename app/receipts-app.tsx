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
  incorrectSpan?: string | null;
  correctFact?: string | null;
  evidenceExcerpt?: string | null;
  mode: string;
  createdAt: number;
};

type GranolaNote = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at?: string;
  synced: boolean;
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
      <blockquote>“{receipt.evidenceExcerpt || evidence.quote}”</blockquote>
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
  const [drawer, setDrawer] = useState<"sources" | null>(null);
  const [granolaNotes, setGranolaNotes] = useState<GranolaNote[]>([]);
  const [granolaLoading, setGranolaLoading] = useState(false);
  const [granolaMessage, setGranolaMessage] = useState("");
  const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sttSocketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
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

  const featuredReceipt = receipts[0] ?? null;
  const providersConfigured =
    status.inworld && status.granola && status.tenstorrent;

  const providerLabel = useMemo(() => {
    if (status.mode === "live") return "Live · checking every 2–3 sentences";
    if (providersConfigured && !status.databaseReady) {
      return "Database unavailable";
    }
    if (providersConfigured && status.evidenceChunks === 0) {
      return "Ready · sync Granola notes";
    }
    if (status.inworld || status.granola || status.tenstorrent) {
      return "Setup incomplete";
    }
    return "Demo mode";
  }, [providersConfigured, status]);

  useEffect(() => {
    fetch("/api/status")
      .then((response) => response.json())
      .then((nextStatus) => setStatus({ ...DEFAULT_STATUS, ...nextStatus }))
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

  const speakWithInworld = useCallback(
    async (text: string) => {
      let audioUrl: string | null = null;
      let settled = false;
      try {
        const response = await fetch("/api/voice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!response.ok || response.headers.get("X-Receipts-Voice") !== "inworld") {
          throw new Error("Inworld voice unavailable");
        }
        audioUrl = URL.createObjectURL(await response.blob());
        const audio = new Audio(audioUrl);
        const finish = () => {
          if (settled) return;
          settled = true;
          URL.revokeObjectURL(audioUrl!);
          releaseMicAfterSpeech();
        };
        audio.onended = finish;
        audio.onerror = () => {
          if (settled) return;
          settled = true;
          URL.revokeObjectURL(audioUrl!);
          speakWithBrowser(text);
        };
        await audio.play();
      } catch {
        if (settled) return;
        settled = true;
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        speakWithBrowser(text);
      }
    },
    [releaseMicAfterSpeech, speakWithBrowser],
  );

  const speakCorrection = useCallback(
    (text: string) => {
      suppressMicRef.current = true;
      setAgentState("speaking");
      void speakWithInworld(text);
    },
    [speakWithInworld],
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

  const loadGranola = useCallback(async () => {
    setDrawer("sources");
    setGranolaLoading(true);
    setGranolaMessage("");
    try {
      const response = await fetch("/api/granola");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to load Granola");
      setGranolaNotes(payload.notes ?? []);
      if (!payload.configured) {
        setGranolaMessage("Add a Granola API key to sync a private demo corpus.");
      }
    } catch (error) {
      setGranolaMessage(error instanceof Error ? error.message : "Unable to load Granola");
    } finally {
      setGranolaLoading(false);
    }
  }, []);

  const syncGranola = useCallback(async () => {
    if (!selectedNotes.size) return;
    setGranolaLoading(true);
    setGranolaMessage("Syncing selected notes…");
    try {
      const response = await fetch("/api/granola/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noteIds: [...selectedNotes] }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Sync failed");
      setGranolaMessage(
        `${payload.synced_count ?? selectedNotes.size} notes are ready for fact-checking.`,
      );
      const syncedIds = new Set<string>(
        (payload.synced ?? []).map((note: { id: string }) => note.id),
      );
      setGranolaNotes((current) =>
        current.map((note) =>
          syncedIds.has(note.id) ? { ...note, synced: true } : note,
        ),
      );
      fetch("/api/status")
        .then((result) => result.json())
        .then((nextStatus) => setStatus({ ...DEFAULT_STATUS, ...nextStatus }))
        .catch(() => undefined);
      setSelectedNotes(new Set());
    } catch (error) {
      setGranolaMessage(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setGranolaLoading(false);
    }
  }, [selectedNotes]);

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
          <aside className="drawer" aria-label="Knowledge sources">
            <div className="drawer__header">
              <span className="eyebrow"><i /> Company memory</span>
              <button onClick={() => setDrawer(null)} aria-label="Close panel">×</button>
            </div>

            <div className="drawer__body sources-panel">
                <h2>Choose what Receipts can fact-check against.</h2>
                <p>Only selected notes are copied into Receipts’ private searchable index.</p>
                <div className="source-summary">
                  <span className="source-summary__mark">G</span>
                  <span><strong>Granola</strong><small>{status.granola ? "Credentials configured" : "API key needed"}</small></span>
                  <i className={cx(status.granola && "is-ready")} />
                </div>
                {granolaLoading && <div className="panel-loading"><i /><i /><i /> Working on it</div>}
                {granolaMessage && <div className="panel-message">{granolaMessage}</div>}
                <div className="note-picker">
                  {granolaNotes.map((note) => (
                    <label key={note.id} className={cx(note.synced && "is-synced")}>
                      <input
                        type="checkbox"
                        checked={selectedNotes.has(note.id)}
                        onChange={() => {
                          setSelectedNotes((current) => {
                            const next = new Set(current);
                            if (next.has(note.id)) next.delete(note.id);
                            else next.add(note.id);
                            return next;
                          });
                        }}
                      />
                      <span>
                        <strong>{note.title || "Untitled meeting"}</strong>
                        <small>{formatDate(note.created_at)}</small>
                      </span>
                      {note.synced && <em>Synced</em>}
                    </label>
                  ))}
                </div>
                <button className="primary-button primary-button--panel" disabled={!selectedNotes.size || granolaLoading} onClick={syncGranola}>
                  Sync {selectedNotes.size || "selected"} note{selectedNotes.size === 1 ? "" : "s"} <span>→</span>
                </button>
                <div className="index-stat">
                  <strong>{status.knowledgeSources}</strong><span>source notes</span>
                  <strong>{status.evidenceChunks}</strong><span>searchable moments</span>
                </div>
              </div>
          </aside>
        </div>
      )}
    </main>
  );
}
