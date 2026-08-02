import { getRuntimeEnv } from "@/lib/runtime-env";

const INWORLD_TTS_URL = "https://api.inworld.ai/tts/v1/voice";
const MAX_SPOKEN_CHARACTERS = 1_000;
const TIMEOUT_MS = 15_000;

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Voice request must be valid JSON." }, { status: 400 });
  }

  const text =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).text
      : null;
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > MAX_SPOKEN_CHARACTERS
  ) {
    return Response.json({ error: "Voice text is invalid." }, { status: 400 });
  }

  const runtime = getRuntimeEnv();
  const apiKey = runtime.INWORLD_API_KEY?.trim();
  if (!apiKey) {
    return Response.json({ error: "Inworld voice is not configured." }, { status: 503 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(INWORLD_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: text.trim(),
        voiceId: runtime.INWORLD_VOICE_ID?.trim() || "Dennis",
        modelId: "inworld-tts-2",
        audioConfig: {
          audioEncoding: "LINEAR16",
          sampleRateHertz: 22050,
        },
        language: "en-US",
        deliveryMode: "BALANCED",
        applyTextNormalization: "ON",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return Response.json(
        { error: `Inworld voice returned ${response.status}.` },
        { status: 502 },
      );
    }

    const result = (await response.json()) as { audioContent?: unknown };
    if (typeof result.audioContent !== "string" || !result.audioContent) {
      return Response.json(
        { error: "Inworld returned no voice audio." },
        { status: 502 },
      );
    }

    const binary = atob(result.audioContent);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Response(bytes, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "audio/wav",
        "X-Receipts-Voice": "inworld",
      },
    });
  } catch {
    return Response.json(
      { error: "Inworld voice is temporarily unavailable." },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
