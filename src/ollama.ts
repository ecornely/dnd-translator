/** Small Ollama client using only Node built-ins. */

import { OllamaError } from "./errors.js";
import type { TextTranslator } from "./service.js";

export interface OllamaTranslatorOptions {
  timeoutSeconds?: number;
  fetchImpl?: typeof fetch;
  uuid?: () => string;
}

function formatInputs(requests: Array<{ id: string; text: string }>): string {
  return JSON.stringify(requests, null, 2);
}

function preview(value: unknown): string {
  return String(value).slice(0, 1000);
}

export class OllamaTranslator implements TextTranslator {
  readonly model: string;
  readonly baseUrl: string;
  private readonly timeoutSeconds: number;
  private readonly doFetch: typeof fetch;
  private readonly uuid: () => string;

  constructor(
    model: string,
    baseUrl: string = "http://localhost:11434",
    options: OllamaTranslatorOptions = {},
  ) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      throw new Error("Ollama must use a local HTTP URL (localhost or loopback IP)");
    }
    const hostname = parsedUrl.hostname;
    if (
      parsedUrl.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)
    ) {
      throw new Error("Ollama must use a local HTTP URL (localhost or loopback IP)");
    }
    if (!model.trim()) {
      throw new Error("The Ollama model name must not be empty");
    }

    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutSeconds = options.timeoutSeconds ?? 300;
    this.doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.uuid = options.uuid ?? globalThis.crypto.randomUUID.bind(globalThis.crypto);
  }

  async translate(texts: string[], terms: Record<string, string>): Promise<string[]> {
    if (!texts.length) {
      return [];
    }

    const requestIds = texts.map(() => this.uuid());
    const requests = texts.map((text, index) => ({
      id: requestIds[index],
      text,
    }));
    const schema = {
      type: "object",
      properties: {
        translations: {
          type: "object",
          properties: Object.fromEntries(
            requestIds.map((requestId) => [requestId, { type: "string" }]),
          ),
          required: requestIds,
          additionalProperties: false,
        },
      },
      required: ["translations"],
      additionalProperties: false,
    };
    const payload = {
      model: this.model,
      stream: false,
      format: schema,
      options: { temperature: 0 },
      messages: [
        {
          role: "system",
          content:
            "Translate the supplied text strings into French for Dungeons & " +
            "Dragons content. Some strings may already be French: " +
            "leave those unchanged. Preserve proper names, numbers, game " +
            "statistics, and every token enclosed in double underscores " +
            "exactly. Use these French translations consistently whenever " +
            "the corresponding English terms occur: " +
            `${JSON.stringify(terms)}. The input entries ` +
            "have unique IDs. Return one translation for the entire text " +
            "of each entry as a string value under that same ID. Return " +
            "every ID exactly once, do not split or combine entries, and " +
            "do not return an array of translations for a single entry.",
        },
        {
          role: "user",
          content: JSON.stringify(requests),
        },
      ],
    };

    let body: unknown;
    try {
      const response = await this.doFetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutSeconds * 1000),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new OllamaError(
          `Ollama returned HTTP ${response.status}: ${detail || response.statusText}`,
        );
      }
      body = await response.json();
    } catch (error) {
      if (error instanceof OllamaError) {
        throw error;
      }
      if (error instanceof SyntaxError) {
        throw new OllamaError("Ollama returned an invalid JSON response");
      }
      throw new OllamaError(
        `Could not reach local Ollama at ${this.baseUrl}. ` +
          "Start Ollama and make sure the configured model is installed.",
      );
    }

    const message = (body as { message?: { content?: string } } | null)?.message;
    const content = message?.content;
    if (typeof content !== "string") {
      throw new OllamaError(
        "Ollama returned an invalid translation response. " +
          `Response content: '${preview(message ? JSON.stringify(message) : JSON.stringify(body))}'`,
      );
    }

    let result: unknown;
    try {
      result = JSON.parse(content);
    } catch {
      throw new OllamaError(
        "Ollama returned an invalid translation response. " +
          `Response content: '${preview(content)}'`,
      );
    }
    const translations = (result as { translations?: unknown } | null)?.translations;
    if (translations === null || typeof translations !== "object" || Array.isArray(translations)) {
      throw new OllamaError(
        "Ollama returned an invalid translation response: " +
          `'translations' must be an object keyed by request UUID, got ` +
          `${translations === null ? "null" : Array.isArray(translations) ? "array" : typeof translations}. ` +
          `Input batch: ${formatInputs(requests)}. Response content: '${preview(content)}'`,
      );
    }
    const translationsByKey = translations as Record<string, unknown>;

    const expectedIds = new Set(requestIds);
    const actualIds = new Set(Object.keys(translationsByKey));
    const missingIds = [...expectedIds].filter((id) => !actualIds.has(id));
    const unexpectedIds = [...actualIds].filter((id) => !expectedIds.has(id));
    if (missingIds.length || unexpectedIds.length) {
      throw new OllamaError(
        "Ollama returned translations with mismatched request UUIDs: " +
          `missing [${missingIds.sort()}], unexpected [${unexpectedIds.sort()}]. ` +
          `Input batch: ${formatInputs(requests)}. ` +
          `Response content: '${preview(content)}'`,
      );
    }
    const invalidItems = requestIds
      .filter((requestId) => typeof translationsByKey[requestId] !== "string")
      .map((requestId) => `${requestId} (${typeof translationsByKey[requestId]})`);
    if (invalidItems.length) {
      throw new OllamaError(
        "Ollama returned non-string translations for request UUIDs " +
          `${invalidItems.join(", ")}. ` +
          `Input batch: ${formatInputs(requests)}. ` +
          `Response content: '${preview(content)}'`,
      );
    }
    return requestIds.map((requestId) => translationsByKey[requestId] as string);
  }
}
