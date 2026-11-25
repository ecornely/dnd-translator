/** Apply local terminology rules and translate text fields in a character JSON. */

import { OllamaError, TranslationError } from "./errors.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonPath = (string | number)[];

export interface TextTranslator {
  translate(texts: string[], terms: Record<string, string>): Promise<string[]>;
}

export type Warn = (message: string) => void;

const FEET_PATTERN = /(?<![\w.])(\d+)\s?ft\.?(?!\w)/gi;
const POUNDS_PATTERN = /(?<![\w.])(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\.?(?!\w)/gi;
/** Unités déclarées dans meta.units (dnd-dom-extract) : impériales natives DDB. */
const POUNDS_UNIT_PATTERN = /lbs?|pounds?/i;
const DISTANCE_UNIT_PATTERN = /ft\b|feet/i;
const LB_TO_KG_FACTOR = 0.45359237;

const NON_TRANSLATABLE_FIELDS = new Set([
  "age",
  "characterName",
  "character_name",
  "id",
  "index",
  "playerName",
  "player_name",
  "prepared",
  "proficiency",
  "quantity",
  "url",
  "value",
  "spellcasting_ability",
  "component",
  "weight",
]);

const FRENCH_INDICATORS = new Set([
  "au",
  "aux",
  "avec",
  "cette",
  "ces",
  "comme",
  "dans",
  "de",
  "des",
  "du",
  "elle",
  "elles",
  "en",
  "entre",
  "et",
  "il",
  "ils",
  "la",
  "le",
  "les",
  "leur",
  "leurs",
  "mais",
  "nous",
  "ou",
  "où",
  "par",
  "pas",
  "peut",
  "peuvent",
  "plus",
  "pour",
  "que",
  "qui",
  "sa",
  "sans",
  "se",
  "ses",
  "son",
  "sont",
  "sur",
  "toute",
  "toutes",
  "tout",
  "tous",
  "très",
  "un",
  "une",
  "vous",
]);

const ENGLISH_INDICATORS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "by",
  "can",
  "could",
  "for",
  "from",
  "he",
  "her",
  "his",
  "in",
  "into",
  "is",
  "it",
  "its",
  "let",
  "more",
  "not",
  "of",
  "on",
  "or",
  "our",
  "she",
  "that",
  "the",
  "their",
  "them",
  "they",
  "this",
  "those",
  "to",
  "was",
  "were",
  "we",
  "when",
  "where",
  "which",
  "who",
  "with",
  "you",
  "your",
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function isTranslatable(path: JsonPath, field: string): boolean {
  if (NON_TRANSLATABLE_FIELDS.has(field)) {
    return false;
  }
  // meta.units : codes d'unités réécrits par convertNumericUnits.
  if (path.length === 3 && path[0] === "meta" && path[1] === "units") {
    return false;
  }
  if (path.length === 1 && path[0] === "name") {
    return false;
  }
  if (
    path.length >= 2 &&
    path[path.length - 2] === "identity" &&
    path[path.length - 1] === "name"
  ) {
    return false;
  }
  return true;
}

function matchesIgnorePattern(
  path: JsonPath,
  pattern: string[],
  pathIndex: number,
  patternIndex: number,
): boolean {
  if (patternIndex === pattern.length) {
    return true;
  }
  if (pathIndex === path.length) {
    return false;
  }

  const actual = path[pathIndex];
  if (typeof actual === "number" && matchesIgnorePattern(path, pattern, pathIndex + 1, patternIndex)) {
    return true;
  }
  const expected = pattern[patternIndex];
  return (
    (expected === "*" || expected === String(actual)) &&
    matchesIgnorePattern(path, pattern, pathIndex + 1, patternIndex + 1)
  );
}

function isIgnored(path: JsonPath, ignoredPaths: string[]): boolean {
  return ignoredPaths.some(
    (ignoredPath) =>
      matchesIgnorePattern(path, ignoredPath.split("."), 0, 0),
  );
}

function formatDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function convertMeasurementsToMetric(text: string): string {
  const converted = text.replace(FEET_PATTERN, (_match, feet: string) => {
    const feetValue = Number(feet);
    const meters = feetValue * 0.3;
    const cells = feetValue / 5;
    const cellLabel = cells === 1 ? "cell" : "cells";
    return `${formatDecimal(meters)} m. (${formatDecimal(cells)} ${cellLabel})`;
  });

  return converted.replace(POUNDS_PATTERN, (_match, pounds: string) => {
    const poundsValue = Number(pounds);
    const kilograms = poundsValue * 0.45359237;
    return `${formatDecimal(kilograms)} kg`;
  });
}

function convertUnitsInValues(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return convertMeasurementsToMetric(value);
  }
  if (Array.isArray(value)) {
    return value.map(convertUnitsInValues);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, convertUnitsInValues(child)]),
    );
  }
  return value;
}

/**
 * Conversion numérique des poids : la structure maison de dnd-dom-extract
 * porte ces valeurs en nombres nus, unité déclarée dans meta.units (« lb. »
 * natif DDB) — invisible pour la conversion regex des chaînes. On convertit
 * ces champs et on rééscrit meta.units (ft → m, lb → kg), consommé tel quel
 * par dnd-print-sheets. Idempotent : des unités déjà métriques ne touchent
 * rien, et les champs libres du joueur (appearance.height/weight) restent
 * hors de portée.
 */
export function convertNumericUnits(character: JsonValue): JsonValue {
  if (character === null || typeof character !== "object" || Array.isArray(character)) {
    return character;
  }
  const root = character as { [key: string]: JsonValue };
  const meta = (root["meta"] ?? null) as { [key: string]: JsonValue } | null;
  const units = (meta?.["units"] ?? null) as { [key: string]: JsonValue } | null;
  const weightUnit = typeof units?.["weight"] === "string" ? (units["weight"] as string) : null;
  const distanceUnit = typeof units?.["distance"] === "string" ? (units["distance"] as string) : null;

  if (weightUnit === null || POUNDS_UNIT_PATTERN.test(weightUnit)) {
    const scaleWeight = (value: JsonValue): JsonValue =>
      typeof value === "number" ? Math.round(value * LB_TO_KG_FACTOR * 10) / 10 : value;
    // DnD Beyond n'accepte que des livres dans le champ poids : le nombre
    // nu saisi par le joueur (appearance.weight) est impérial lui aussi.
    // Conversion en chaîne avec unité (idempotent : une valeur déjà
    // unitée — "91.6 kg" ou gérée par le regex — n'est plus un nombre nu).
    const appearance = (root["appearance"] ?? null) as { [key: string]: JsonValue } | null;
    const absoluteNumber = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
    if (appearance !== null) {
      const weight = appearance["weight"];
      if (typeof weight === "number") {
        appearance["weight"] = `${formatDecimal(weight * LB_TO_KG_FACTOR)} kg`;
      } else if (typeof weight === "string") {
        const trimmed = weight.trim();
        if (absoluteNumber.test(trimmed.replace(",", "."))) {
          appearance["weight"] = `${formatDecimal(Number(trimmed.replace(",", ".")) * LB_TO_KG_FACTOR)} kg`;
        }
      }
    }
    for (const key of ["carryingCapacity", "pushDragLift"]) {
      if (typeof root[key] === "number") {
        root[key] = scaleWeight(root[key]);
      }
    }
    if (Array.isArray(root["equipment"])) {
      root["equipment"] = (root["equipment"] as JsonValue[]).map((item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
        return Object.fromEntries(
          Object.entries(item as { [key: string]: JsonValue }).map(([key, child]) =>
            key === "weight" ? [key, scaleWeight(child)] : [key, child],
          ),
        );
      });
    }
    if (units) units["weight"] = "kg";
  }
  if (distanceUnit === null || DISTANCE_UNIT_PATTERN.test(distanceUnit)) {
    if (units) units["distance"] = "m";
  }
  return character;
}

interface TextEntry {
  path: JsonPath;
  text: string;
}

function collectText(
  value: JsonValue,
  path: JsonPath,
  ignoredPaths: string[],
  entries: TextEntry[],
): void {
  if (isIgnored(path, ignoredPaths)) {
    return;
  }

  if (typeof value === "string") {
    if (path.length === 0) {
      entries.push({ path, text: value });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child = value[index];
      const childPath: JsonPath = [...path, index];
      if (typeof child === "string") {
        const field =
          [...path].reverse().find((part) => typeof part === "string") ?? null;
        if (
          (field === null || isTranslatable(path, field)) &&
          !isIgnored(childPath, ignoredPaths)
        ) {
          entries.push({ path: childPath, text: child });
        } else {
          collectText(child, childPath, ignoredPaths, entries);
        }
      } else {
        collectText(child, childPath, ignoredPaths, entries);
      }
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath: JsonPath = [...path, key];
      if (
        typeof child === "string" &&
        isTranslatable(childPath, key) &&
        !isIgnored(childPath, ignoredPaths)
      ) {
        entries.push({ path: childPath, text: child });
      } else {
        collectText(child, childPath, ignoredPaths, entries);
      }
    }
  }
}

interface MaskedTerm {
  translation: string;
  count: number;
}

interface MaskedText {
  masked: string;
  placeholders: Map<string, MaskedTerm>;
}

function maskTerms(text: string, terms: Record<string, string>): MaskedText {
  const normalizedTerms: Record<string, string> = {};
  for (const [term, translation] of Object.entries(terms)) {
    const stripped = term.trim();
    if (stripped) {
      normalizedTerms[stripped] = translation;
    }
  }
  const orderedTerms = Object.keys(normalizedTerms).sort(
    (a, b) => b.length - a.length,
  );

  const placeholders = new Map<string, MaskedTerm>();
  let masked = text;
  orderedTerms.forEach((term, termIndex) => {
    const placeholder = `__DNDTERM${String(termIndex).padStart(4, "0")}__`;
    const pattern = new RegExp(`(?<!\\w)${escapeRegExp(term)}(?!\\w)`, "gi");
    const substitutions = countMatches(masked, pattern);
    if (substitutions) {
      masked = masked.replace(pattern, placeholder);
      placeholders.set(placeholder, {
        translation: normalizedTerms[term],
        count: substitutions,
      });
    }
  });
  return { masked, placeholders };
}

function exactTermTranslation(
  text: string,
  terms: Record<string, string>,
): string | null {
  const folded = text.trim().toLowerCase();
  for (const [term, translation] of Object.entries(terms)) {
    if (folded === term.trim().toLowerCase()) {
      return translation;
    }
  }
  return null;
}

function restoreTerms(
  text: string,
  placeholders: Map<string, MaskedTerm>,
  originalText: string,
  warn: Warn,
): string {
  let result = text;
  for (const [placeholder, { translation, count }] of placeholders) {
    const actualCount = result.split(placeholder).length - 1;
    if (actualCount !== count) {
      warn(
        `The AI changed or omitted a protected D&D term '${translation}' ` +
          `(expected ${count} occurrence(s), found ${actualCount}). Keeping the AI translation ` +
          `where the marker is missing. Source text: '${originalText.slice(0, 500)}'; ` +
          `AI response: '${result.slice(0, 500)}'`,
      );
    }
    result = result.split(placeholder).join(translation);
  }
  return result;
}

function isLikelyFrench(text: string): boolean {
  const words = text.toLowerCase().match(/[^\W\d_]+/gu) ?? [];
  if (words.length < 12) {
    return false;
  }

  const countIn = (set: Set<string>) =>
    words.reduce((acc, word) => acc + (set.has(word) ? 1 : 0), 0);
  const frenchCount = countIn(FRENCH_INDICATORS);
  const englishCount = countIn(ENGLISH_INDICATORS);
  return frenchCount >= 4 && frenchCount >= (englishCount + 2) * 2;
}

function splitKeepEnds(text: string): Array<{ line: string; ending: string }> {
  const parts: Array<{ line: string; ending: string }> = [];
  let index = 0;
  const lineEnding = /\r\n|\r|\n/g;
  let match: RegExpExecArray | null;
  while ((match = lineEnding.exec(text)) !== null) {
    parts.push({ line: text.slice(index, match.index), ending: match[0] });
    index = match.index + match[0].length;
  }
  parts.push({ line: text.slice(index), ending: "" });
  return parts;
}

function splitLongLine(
  text: string,
  maxChunkChars: number,
): Array<[string, string]> {
  if (text.length <= maxChunkChars) {
    return [[text, ""]];
  }

  const chunks: Array<[string, string]> = [];
  let start = 0;
  while (text.length - start > maxChunkChars) {
    const limit = start + maxChunkChars;
    const rest = text.slice(start);
    let boundary: [number, number] | null = null;

    for (const match of rest.matchAll(/(?<=[.!?])\s+/g)) {
      const boundaryStart = start + match.index;
      if (boundaryStart > limit) {
        break;
      }
      boundary = [boundaryStart, boundaryStart + match[0].length];
    }

    if (boundary === null) {
      for (const match of rest.matchAll(/\s+/g)) {
        const boundaryStart = start + match.index;
        if (boundaryStart > limit) {
          break;
        }
        boundary = [boundaryStart, boundaryStart + match[0].length];
      }
    }

    if (boundary === null) {
      const match = /\s+/.exec(text.slice(limit));
      if (match === null) {
        break;
      }
      boundary = [limit + match.index, limit + match.index + match[0].length];
    }

    const [boundaryStart, boundaryEnd] = boundary;
    if (boundaryStart <= start) {
      break;
    }
    chunks.push([text.slice(start, boundaryStart), text.slice(boundaryStart, boundaryEnd)]);
    start = boundaryEnd;
  }

  if (start < text.length) {
    chunks.push([text.slice(start), ""]);
  }
  return chunks;
}

function splitLongText(
  text: string,
  maxChunkChars: number,
): Array<[string, string]> {
  if (text.includes("\n")) {
    const chunks: Array<[string, string]> = [];
    for (const { line, ending } of splitKeepEnds(text)) {
      const lineChunks = splitLongLine(line, maxChunkChars);
      const [finalChunk, separator] = lineChunks[lineChunks.length - 1];
      lineChunks[lineChunks.length - 1] = [finalChunk, separator + ending];
      chunks.push(...lineChunks);
    }
    return chunks;
  }

  return splitLongLine(text, maxChunkChars);
}

function formatJsonPath(path: JsonPath): string {
  let formatted = "$";
  for (const part of path) {
    if (typeof part === "number") {
      formatted += `[${part}]`;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
      formatted += `.${part}`;
    } else {
      formatted += `[${JSON.stringify(part)}]`;
    }
  }
  return formatted;
}

function validateTranslations(
  translations: unknown[],
  batch: string[],
): asserts translations is string[] {
  if (translations.length !== batch.length) {
    throw new TranslationError(
      "The translation engine must return one string per input chunk",
    );
  }
  if (translations.some((translation) => typeof translation !== "string")) {
    throw new TranslationError("The translation engine returned a non-string value");
  }
}

async function translateBatchWithFallback(
  batch: string[],
  terms: Record<string, string>,
  translator: TextTranslator,
  pathsByChunk: Map<string, string[]>,
  warn: Warn,
): Promise<string[]> {
  try {
    const translations = await translator.translate(batch, terms);
    validateTranslations(translations, batch);
    return translations;
  } catch (batchError) {
    if (!(batchError instanceof TranslationError)) {
      throw batchError;
    }
    const batchPaths = batch
      .map(
        (chunk, index) =>
          `${index + 1}: ${pathsByChunk.get(chunk)?.join(", ") ?? ""}`,
      )
      .join("; ");
    warn(
      `Translation batch failed; retrying each input separately. ` +
        `Batch items and JSON paths: ${batchPaths}. Error: ${batchError.message}`,
    );
  }

  const translations: string[] = [];
  for (const chunk of batch) {
    const paths = pathsByChunk.get(chunk)?.join(", ") ?? "";
    try {
      const translation = await translator.translate([chunk], terms);
      validateTranslations(translation, [chunk]);
      translations.push(translation[0]);
    } catch (itemError) {
      const message = itemError instanceof Error ? itemError.message : String(itemError);
      throw new TranslationError(
        `Translation failed for JSON path(s) ${paths}: ${message}`,
      );
    }
  }
  return translations;
}

export interface TranslateOptions {
  phrases: Record<string, string>;
  terms: Record<string, string>;
  translator: TextTranslator;
  batchSize?: number;
  ignoredPaths?: string[];
  skipIfFrench?: boolean;
  maxChunkChars?: number;
  warn?: Warn;
}

export async function translateCharacter(
  character: JsonValue,
  options: TranslateOptions,
): Promise<JsonValue> {
  const {
    phrases,
    terms,
    translator,
    ignoredPaths = [],
    skipIfFrench = true,
    maxChunkChars = 400,
    warn = (message: string) => console.warn(message),
  } = options;
  const batchSize = options.batchSize ?? 12;
  if (batchSize < 1) {
    throw new Error("batch_size must be greater than zero");
  }
  if (maxChunkChars < 1) {
    throw new Error("max_chunk_chars must be greater than zero");
  }

  let translatedCharacter = convertUnitsInValues(
    convertNumericUnits(structuredClone(character)),
  ) as JsonValue;
  const entries: TextEntry[] = [];
  collectText(translatedCharacter, [], ignoredPaths, entries);
  const pending = new Map<string, MaskedText>();
  const pathsByText = new Map<string, string[]>();
  const translatedTexts = new Map<string, string>();
  const normalizedPhrases = new Map<string, string>();
  for (const [phrase, translation] of Object.entries(phrases)) {
    const stripped = phrase.trim().toLowerCase();
    if (stripped) {
      normalizedPhrases.set(stripped, translation);
    }
  }
  for (const { path, text } of entries) {
    let paths = pathsByText.get(text);
    if (!paths) {
      paths = [];
      pathsByText.set(text, paths);
    }
    const jsonPath = formatJsonPath(path);
    if (!paths.includes(jsonPath)) {
      paths.push(jsonPath);
    }
    const normalizedText = text.trim().toLowerCase();
    if (normalizedPhrases.has(normalizedText)) {
      translatedTexts.set(text, normalizedPhrases.get(normalizedText)!);
      continue;
    }
    const exactTerm = exactTermTranslation(text, terms);
    if (exactTerm !== null) {
      translatedTexts.set(text, exactTerm);
      continue;
    }
    if (skipIfFrench && isLikelyFrench(text)) {
      translatedTexts.set(text, text);
    } else if (!pending.has(text)) {
      pending.set(text, maskTerms(text, terms));
    }
  }

  const chunksByText = new Map<string, Array<[string, string]>>();
  for (const [text, { masked }] of pending) {
    chunksByText.set(text, splitLongText(masked, maxChunkChars));
  }
  const pathsByChunk = new Map<string, string[]>();
  const chunkInputs: string[] = [];
  const chunkInputSet = new Set<string>();
  for (const [text, chunks] of chunksByText) {
    for (const [chunk] of chunks) {
      if (!chunk || chunkInputSet.has(chunk)) {
        continue;
      }
      chunkInputSet.add(chunk);
      chunkInputs.push(chunk);
      const paths: string[] = [];
      pathsByChunk.set(chunk, paths);
      for (const jsonPath of pathsByText.get(text) ?? []) {
        if (!paths.includes(jsonPath)) {
          paths.push(jsonPath);
        }
      }
    }
  }

  const translatedChunks = new Map<string, string>();
  for (let start = 0; start < chunkInputs.length; start += batchSize) {
    const batch = chunkInputs.slice(start, start + batchSize);
    const translations = await translateBatchWithFallback(
      batch,
      terms,
      translator,
      pathsByChunk,
      warn,
    );
    for (const [index, chunk] of batch.entries()) {
      translatedChunks.set(chunk, translations[index]);
    }
  }

  for (const [original, { placeholders }] of pending) {
    const chunks = chunksByText.get(original)!;
    const translated = chunks
      .map(([chunk, separator]) => (translatedChunks.get(chunk) ?? chunk) + separator)
      .join("");
    translatedTexts.set(
      original,
      restoreTerms(translated, placeholders, original, warn),
    );
  }

  for (const { path, text: original } of entries) {
    if (path.length === 0) {
      translatedCharacter = translatedTexts.get(original)!;
      continue;
    }
    let value: JsonValue = translatedCharacter;
    for (const part of path.slice(0, -1)) {
      value = (value as JsonValue[] | { [key: string]: JsonValue })[part as never];
    }
    (value as Record<string, JsonValue>)[String(path[path.length - 1])] =
      translatedTexts.get(original)!;
  }
  return translatedCharacter;
}
