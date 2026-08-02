/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  DB: unknown;
  INWORLD_API_KEY?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type RelayWebSocket = WebSocket & { accept(): void };

type WebSocketResponse = Response & {
  webSocket?: RelayWebSocket;
};

type WebSocketResponseInit = ResponseInit & {
  webSocket: RelayWebSocket;
};

const INWORLD_WEBSOCKET_ENDPOINTS: Record<string, string> = {
  "/api/inworld/stt": "https://api.inworld.ai/stt/v1/transcribe:streamBidirectional",
  "/api/inworld/tts": "https://api.inworld.ai/tts/v1/voice:streamBidirectional",
};
const MAX_CLIENT_MESSAGE_BYTES = 256 * 1024;
const MAX_CLIENT_SESSION_BYTES = 256 * 1024 * 1024;

function messageByteLength(data: unknown): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return MAX_CLIENT_MESSAGE_BYTES + 1;
}

function closeSocket(socket: RelayWebSocket, code: number, reason: string): void {
  if (socket.readyState >= 2) return;

  try {
    socket.close(code, reason);
  } catch {
    try {
      socket.close();
    } catch {
      // The socket is already unusable; there is nothing left to clean up.
    }
  }
}

function relayWebSockets(client: RelayWebSocket, upstream: RelayWebSocket): void {
  let finished = false;
  let clientBytes = 0;

  const fail = () => {
    if (finished) return;
    finished = true;
    closeSocket(client, 1011, "Relay error");
    closeSocket(upstream, 1011, "Relay error");
  };

  const forward = (destination: RelayWebSocket, event: MessageEvent) => {
    if (finished || destination.readyState !== 1) return;

    try {
      destination.send(event.data);
    } catch {
      fail();
    }
  };

  const forwardClientMessage = (event: MessageEvent) => {
    const bytes = messageByteLength(event.data);
    clientBytes += bytes;
    if (
      bytes > MAX_CLIENT_MESSAGE_BYTES ||
      clientBytes > MAX_CLIENT_SESSION_BYTES
    ) {
      fail();
      return;
    }
    forward(upstream, event);
  };

  const finishFrom = (destination: RelayWebSocket) => {
    if (finished) return;
    finished = true;
    closeSocket(destination, 1000, "Peer closed");
  };

  client.addEventListener("message", forwardClientMessage);
  upstream.addEventListener("message", (event) => forward(client, event));
  client.addEventListener("close", () => finishFrom(upstream));
  upstream.addEventListener("close", () => finishFrom(client));
  client.addEventListener("error", fail);
  upstream.addEventListener("error", fail);

  client.accept();
  upstream.accept();
}

async function handleInworldUpgrade(
  request: Request,
  env: Env,
  upstreamUrl: string,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", {
      status: 426,
      headers: { Upgrade: "websocket" },
    });
  }

  const requestUrl = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (!origin || origin !== requestUrl.origin) {
    return new Response("Forbidden", { status: 403 });
  }

  const apiKey = env.INWORLD_API_KEY?.trim();
  if (!apiKey) {
    return new Response("Inworld voice service is unavailable", { status: 503 });
  }

  let upstreamResponse: WebSocketResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Authorization: `Basic ${apiKey}`,
        Upgrade: "websocket",
      },
      redirect: "manual",
    }) as WebSocketResponse;
  } catch {
    return new Response("Inworld voice service is unavailable", { status: 502 });
  }

  const upstream = upstreamResponse.webSocket;
  if (!upstream) {
    return new Response("Inworld voice service is unavailable", { status: 502 });
  }

  const WebSocketPairConstructor = (globalThis as typeof globalThis & {
    WebSocketPair: new () => { 0: RelayWebSocket; 1: RelayWebSocket };
  }).WebSocketPair;
  const pair = new WebSocketPairConstructor();
  const browser = pair[0];
  const worker = pair[1];

  relayWebSockets(worker, upstream);

  return new Response(null, {
    status: 101,
    webSocket: browser,
  } as WebSocketResponseInit);
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const inworldEndpoint = INWORLD_WEBSOCKET_ENDPOINTS[url.pathname];
    if (inworldEndpoint) {
      return handleInworldUpgrade(request, env, inworldEndpoint);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
