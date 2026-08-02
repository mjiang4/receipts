import { env } from "cloudflare:workers";

export type ReceiptsRuntimeEnv = {
  GRANOLA_API_KEY?: string;
  GRANOLA_DEFAULT_FOLDER_ID?: string;
  GRANOLA_DEFAULT_FOLDER_NAME?: string;
  GRANOLA_DEFAULT_NOTE_LIMIT?: string;
  INWORLD_API_KEY?: string;
  INWORLD_VOICE_ID?: string;
  TENSTORRENT_API_KEY?: string;
  TENSTORRENT_BASE_URL?: string;
  TENSTORRENT_MODEL?: string;
};

export function getRuntimeEnv() {
  return env as unknown as ReceiptsRuntimeEnv;
}

export function hasTenstorrentConfiguration() {
  const runtime = getRuntimeEnv();
  return Boolean(
    runtime.TENSTORRENT_BASE_URL?.trim() &&
      runtime.TENSTORRENT_MODEL?.trim() &&
      runtime.TENSTORRENT_API_KEY?.trim(),
  );
}
