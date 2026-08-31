import type { AppConfig } from "../config.js";

export interface StreamDelta { text: string; atMs: number }
export type StreamFn = (prompt: string, signal: AbortSignal) => AsyncIterable<StreamDelta>;

type FetchLike = typeof fetch;

function textFromEvent(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const value = event as Record<string, unknown>;
  if (typeof value.type !== "string" || !value.type.includes("output_text")) return null;
  if (typeof value.delta === "string") return value.delta;
  if (typeof value.text === "string") return value.text;
  return null;
}

export function createArkStream(config: AppConfig, transport: FetchLike = fetch): StreamFn {
  return async function* (prompt: string, signal: AbortSignal): AsyncIterable<StreamDelta> {
    if (!config.arkApiKey || !config.arkModel) throw new Error("Ark generation is not configured");
    const response = await transport(config.arkBaseUrl + "/responses", {
      method: "POST",
      signal,
      headers: {
        Authorization: "Bearer " + config.arkApiKey,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: config.arkModel, input: prompt, stream: true, thinking: { type: "disabled" } }),
    });
    if (!response.ok || !response.body) throw new Error("Ark stream failed: " + response.status);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          let event: unknown;
          try { event = JSON.parse(data); } catch { throw new Error("Malformed Ark SSE event"); }
          const text = textFromEvent(event);
          if (text !== null) yield { text, atMs: Date.now() };
        }
      }
      if (pending.trim()) throw new Error("Malformed Ark SSE event");
    } finally {
      reader.releaseLock();
    }
  };
}
