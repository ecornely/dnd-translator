/** Errors shared by the translation pipeline. */

export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationError";
  }
}

export class OllamaError extends TranslationError {}
