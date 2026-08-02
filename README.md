# Receipts

Receipts is a voice-first meeting participant that checks every 2–3 finalized
sentences against a selected company-memory corpus and interrupts with a short
source-backed correction when the evidence directly contradicts the speaker.

## Product loop

1. The browser captures microphone audio and sends 16 kHz PCM frames through a
   same-origin WebSocket relay to Inworld streaming STT.
2. Finalized speech is stored in D1 and collected into non-overlapping batches
   of 2–3 sentences.
3. Receipts retrieves a small set of relevant excerpts from synced Granola
   notes.
4. Every batch is sent to Tenstorrent-hosted Qwen3-32B for evidence comparison;
   a server-side safety gate validates each speak/silent/conflict result.
5. High-confidence contradictions trigger Inworld streaming TTS and a receipt
   card with the exact quote, meeting, date, and Granola link.

The microphone relay pauses while Receipts speaks, then resumes after a short
cooldown so generated speech cannot enter its own transcript.

The production deployment is intended to remain owner-only. D1 stores the
synced Granola excerpts, finalized text utterances, and source-backed
receipts; raw microphone audio is streamed through the voice provider and is
not written to application storage.

By default, Receipts resolves the Granola folder named `Demo notes` when the
app opens, paginates the folder, sorts completed notes by creation time, and
activates its 10 most recent notes for fact-checking. Repeated loads fetch
transcripts only for notes that are new or have changed. Override the folder
name, a specific folder ID, or the note limit with `GRANOLA_DEFAULT_FOLDER_NAME`,
`GRANOLA_DEFAULT_FOLDER_ID`, and `GRANOLA_DEFAULT_NOTE_LIMIT`.

## Configuration

Copy `.env.example` to a local ignored env file and provide server-only values:

```text
GRANOLA_API_KEY
GRANOLA_DEFAULT_FOLDER_NAME
GRANOLA_DEFAULT_FOLDER_ID
GRANOLA_DEFAULT_NOTE_LIMIT
INWORLD_API_KEY
INWORLD_VOICE_ID
TENSTORRENT_BASE_URL
TENSTORRENT_API_KEY
TENSTORRENT_MODEL
```

`INWORLD_API_KEY` is the Base64 credential payload without the `Basic ` prefix.
`TENSTORRENT_BASE_URL` may be either the server root or its `/v1` URL; Receipts
normalizes the chat-completions path. Never use `NEXT_PUBLIC_*` for provider
credentials.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run db:generate
npm run dev
```

The app has an explicitly labeled rehearsal mode with synthetic evidence. It is
useful for UI demos and the visible evaluation suite; it never represents
synthetic records as Granola data.

## Verification

```bash
npm test
npm run lint
```

The evaluation suite covers material contradictions, supported claims,
opinions, questions, vague statements, and conflicting records.
