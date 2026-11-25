#!/usr/bin/env node
/** Command-line interface for translating arbitrary JSON with local Ollama. */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { OllamaTranslator } from "./ollama.js";
import { translateCharacter, type JsonValue, type TextTranslator } from "./service.js";

export const DEFAULT_RULES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "rules.json",
);

export function defaultOutputPath(sourcePath: string): string {
  const base = basename(sourcePath);
  const extension = extname(base);
  const stem = base.slice(0, base.length - extension.length);
  return join(dirname(sourcePath), `${stem}.fr${extension}`);
}

export interface Rules {
  model: string;
  terms: Record<string, string>;
  phrases: Record<string, string>;
  ignore_paths: string[];
  skip_if_french: boolean;
  max_chunk_chars: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRules(path: string): Rules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read rules file ${path}: ${error instanceof Error ? error.message : error}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error("The rules file must contain a JSON object");
  }
  const model = parsed.model;
  const terms = parsed.terms;
  const phrases = parsed.phrases;
  const ignoredPaths = "ignore_paths" in parsed ? parsed.ignore_paths : [];
  const skipIfFrench = "skip_if_french" in parsed ? parsed.skip_if_french : true;
  const maxChunkChars = "max_chunk_chars" in parsed ? parsed.max_chunk_chars : 400;
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("The rules file must define a non-empty model");
  }
  for (const [name, mapping] of [["terms", terms], ["phrases", phrases]] as const) {
    if (
      !isPlainObject(mapping) ||
      Object.entries(mapping).some(
        ([source, target]) =>
          typeof source !== "string" ||
          !source ||
          typeof target !== "string" ||
          !target,
      )
    ) {
      throw new Error(`The rules file must define ${name} as a string-to-string map`);
    }
  }
  if (
    !Array.isArray(ignoredPaths) ||
    ignoredPaths.some(
      (path) =>
        typeof path !== "string" ||
        !path.trim() ||
        path.split(".").some((part) => !part),
    )
  ) {
    throw new Error("The rules file must define ignore_paths as a list of JSON paths");
  }
  if (typeof skipIfFrench !== "boolean") {
    throw new Error("The rules file must define skip_if_french as a boolean");
  }
  if (typeof maxChunkChars !== "number" || !Number.isInteger(maxChunkChars) || maxChunkChars < 1) {
    throw new Error("The rules file must define max_chunk_chars as a positive integer");
  }
  return {
    model,
    terms: terms as Record<string, string>,
    phrases: phrases as Record<string, string>,
    ignore_paths: ignoredPaths as string[],
    skip_if_french: skipIfFrench,
    max_chunk_chars: maxChunkChars,
  };
}

export async function runTranslate(
  sourcePath: string,
  outputPath: string,
  rulesPath: string,
  createTranslator: (model: string, baseUrl: string) => TextTranslator,
  ollamaUrl = "http://localhost:11434",
): Promise<void> {
  const character: JsonValue = JSON.parse(readFileSync(sourcePath, "utf8"));

  if (resolve(outputPath) === resolve(sourcePath)) {
    throw new Error("The output path must not overwrite the source JSON");
  }

  const rules = readRules(rulesPath);
  const translator = createTranslator(rules.model, ollamaUrl);
  const translatedCharacter = await translateCharacter(character, {
    phrases: rules.phrases,
    terms: rules.terms,
    translator,
    ignoredPaths: rules.ignore_paths,
    skipIfFrench: rules.skip_if_french,
    maxChunkChars: rules.max_chunk_chars,
    batchSize: 12,
  });
  const serialized = JSON.stringify(translatedCharacter, null, 2) + "\n";
  writeFileSync(outputPath, serialized, "utf8");
  console.log(`Translated JSON written to ${outputPath}`);
}

export interface CommandLineDeps {
  createTranslator?: (model: string, baseUrl: string) => TextTranslator;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  deps: CommandLineDeps = {},
): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        rules: { type: "string" },
        model: { type: "string" },
        "ollama-url": { type: "string" },
        debug: { type: "boolean", default: false },
      },
    });
    const sourcePath = positionals[0];
    if (!sourcePath || positionals.length !== 1) {
      throw new Error("usage: dnd-translate <source.json> [-o out.json]");
    }
    const outputPath = values.out ?? defaultOutputPath(sourcePath);
    const rulesPath = values.rules ?? DEFAULT_RULES_PATH;
    const ollamaUrl = values["ollama-url"];
    await runTranslate(
      sourcePath,
      outputPath,
      rulesPath,
      (model, baseUrl) => {
        const resolvedModel = values.model ?? model;
        return deps.createTranslator
          ? deps.createTranslator(resolvedModel, baseUrl)
          : new OllamaTranslator(resolvedModel, baseUrl);
      },
      ollamaUrl,
    );
  } catch (error) {
    const debug = argv.includes("--debug");
    if (debug) {
      console.error(error);
    } else {
      console.error(`error: ${error instanceof Error ? error.message : error}`);
    }
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
