import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OllamaError, OllamaTranslator, TranslationError, defaultOutputPath, main, runTranslate } from "../src/index.js";
import { translateCharacter, convertNumericUnits, type TextTranslator } from "../src/service.js";

type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

class RecordingTranslator implements TextTranslator {
  batches: string[][] = [];
  constructor(readonly replacement: string = "Traduction") {}

  async translate(texts: string[]): Promise<string[]> {
    this.batches.push(texts);
    return texts.map(() => this.replacement);
  }
}

test("translates JSON arrays and root strings", async () => {
  const translator = new RecordingTranslator();

  const translatedArray = await translateCharacter([["first text"]], {
    phrases: {}, terms: {}, translator,
  });
  const translatedString = await translateCharacter("root text", {
    phrases: {}, terms: {}, translator,
  });

  assert.deepEqual(translatedArray, [["Traduction"]]);
  assert.equal(translatedString, "Traduction");
});

test("translates unknown string fields without changing JSON shape", async () => {
  const translator = new RecordingTranslator();
  const source = {
    character_name: "Damaia Dread",
    extra_metadata: { story: "An unknown text field.", labels: ["A free-form label."] },
    gender: "female",
    proficiency: "P",
    index: "character-1",
  };

  const result = await translateCharacter(source, {
    phrases: {}, terms: {}, translator,
  }) as Record<string, unknown>;

  assert.equal(result["character_name"], "Damaia Dread");
  assert.deepEqual(result["extra_metadata"], {
    story: "Traduction",
    labels: ["Traduction"],
  });
  assert.equal(result["gender"], "Traduction");
  assert.equal(result["proficiency"], "P");
  assert.equal(result["index"], "character-1");
});

test("translates text fields and array items only", async () => {
  const translator = new RecordingTranslator();
  const source = {
    name: "Character Name",
    class_type: { name: "Rogue", index: "rogue" },
    race: { alignment: "Elves value freedom.", index: "elf" },
    proficiencies: [{ name: "Skill: Stealth", desc: ["desc text"] }],
    gender: "female",
    age: 115,
  };

  const result = await translateCharacter(source, {
    phrases: {}, terms: {}, translator,
  }) as Record<string, any>;

  assert.equal(result["name"], "Character Name");
  assert.equal(result["class_type"]["name"], "Traduction");
  assert.equal(result["class_type"]["index"], "rogue");
  assert.equal(result["race"]["alignment"], "Traduction");
  assert.deepEqual(result["proficiencies"][0]["desc"], ["Traduction"]);
  assert.equal(result["gender"], "Traduction");
  assert.equal(result["age"], 115);
  assert.equal(translator.batches.length, 1);
});

test("exact phrase and glossary take precedence", async () => {
  const translator = new RecordingTranslator("J'utilise __DNDTERM0000__.");
  const source = { desc: ["Use Sneak Attack."] };

  const result = await translateCharacter(source, {
    phrases: {},
    terms: { "Sneak Attack": "Attaque sournoise" },
    translator,
  }) as Record<string, any>;

  assert.deepEqual(result["desc"], ["J'utilise Attaque sournoise."]);
  assert.deepEqual(translator.batches, [["Use __DNDTERM0000__."]]);

  const phraseTranslator = new RecordingTranslator();
  const phraseResult = await translateCharacter({ desc: "Special phrase" }, {
    phrases: { "Special phrase": "Phrase consacrée" },
    terms: {}, translator: phraseTranslator,
  }) as Record<string, any>;
  assert.equal(phraseResult["desc"], "Phrase consacrée");
  assert.deepEqual(phraseTranslator.batches, []);
});

test("exact glossary term is translated without calling the model", async () => {
  const translator = new RecordingTranslator();

  const result = await translateCharacter(
    { desc: ["Bullseye Lantern", "bullseye lantern"] },
    {
      phrases: {},
      terms: { "Bullseye Lantern": "Lanterne à foyer" },
      translator,
    },
  ) as Record<string, any>;

  assert.deepEqual(result["desc"], ["Lanterne à foyer", "Lanterne à foyer"]);
  assert.deepEqual(translator.batches, []);
});

test("exact rules match trimmed case insensitive text", async () => {
  const translator = new RecordingTranslator();

  const result = await translateCharacter(
    { desc: ["  fIrE bOlT  ", " use Sneak Attack "] },
    {
      phrases: { "  USE SNEAK ATTACK ": "Phrase consacrée" },
      terms: { "  Fire Bolt  ": "Éclair de feu" },
      translator,
    },
  ) as Record<string, any>;

  assert.deepEqual(result["desc"], ["Éclair de feu", "Phrase consacrée"]);
  assert.deepEqual(translator.batches, []);
});

test("exact rule translates trimmed gender field", async () => {
  const translator = new RecordingTranslator();

  const result = await translateCharacter({ gender: "Female " }, {
    phrases: {}, terms: { Female: "Femme" }, translator,
  }) as Record<string, any>;

  assert.equal(result["gender"], "Femme");
  assert.deepEqual(translator.batches, []);
});

test("inline glossary terms are trimmed before matching", async () => {
  const translator = new RecordingTranslator("Utilise __DNDTERM0000__.");

  const result = await translateCharacter(
    { desc: "Use Sneak Attack." },
    {
      phrases: {},
      terms: { "  Sneak Attack  ": "Attaque sournoise" },
      translator,
    },
  ) as Record<string, any>;

  assert.equal(result["desc"], "Utilise Attaque sournoise.");
  assert.deepEqual(translator.batches, [["Use __DNDTERM0000__."]]);
});

test("converts feet in all JSON values before translation", async () => {
  const translator = new RecordingTranslator();
  const source = {
    speed: "30 ft. (Walking)",
    description: "Reach 5ft; range 10 FT.",
    skills: [{ name: "30 ft." }],
    other_unit: "30 feet",
  };

  const result = await translateCharacter(source, {
    phrases: {}, terms: {}, translator,
    ignoredPaths: ["skills.name"],
  }) as Record<string, any>;

  assert.equal(result["speed"], "Traduction");
  assert.equal(result["description"], "Traduction");
  assert.equal(result["skills"][0]["name"], "9 m. (6 cells)");
  assert.equal(result["other_unit"], "Traduction");
  assert.deepEqual(translator.batches, [
    ["9 m. (6 cells) (Walking)", "Reach 1.5 m. (1 cell); range 3 m. (2 cells)", "30 feet"],
  ]);
  assert.equal(source["speed"], "30 ft. (Walking)");
});

test("converts pounds to metric before translation", async () => {
  const translator = new RecordingTranslator();
  const source = {
    weight: "10 lbs",
    description: "1 lb; 2 pounds; 2.5 lbs",
    items: [{ weight: "20 lb." }],
  };

  const result = await translateCharacter(source, {
    phrases: {}, terms: {}, translator,
  }) as Record<string, any>;

  // Le champ de mesure weight est figé après conversion (NON_TRANSLATABLE).
  assert.deepEqual(result, {
    weight: "4.5 kg",
    description: "Traduction",
    items: [{ weight: "9.1 kg" }],
  });
  assert.deepEqual(translator.batches, [["0.5 kg; 0.9 kg; 1.1 kg"]]);
  assert.equal(source["weight"], "10 lbs");
});

test("converts numeric weights (nouvelle structure meta.units) et réécrit les unités", async () => {
  const translator = new RecordingTranslator();
  const source = {
    meta: { units: { distance: "ft.", weight: "lb." } },
    carryingCapacity: 240,
    pushDragLift: 480,
    equipment: [{ name: "Backpack", quantity: 1, weight: 5 }],
    // Champ du joueur saisi en livres (DnD Beyond n'accepte que des lbs)
    appearance: { height: "6 ft. 2 in.", weight: "92" },
    // Chaînes : déjà couvertes par la conversion regex
    speed: "30 ft.",
  };

  const result = await translateCharacter(source, {
    phrases: {}, terms: {}, translator,
  }) as Record<string, any>;

  assert.equal(result["carryingCapacity"], 108.9); // 240 × 0.45359237
  assert.equal(result["pushDragLift"], 217.7);
  assert.equal(result["equipment"][0]["weight"], 2.3);
  assert.equal(result["appearance"]["height"], "Traduction");
  assert.equal(result["appearance"]["weight"], "41.7 kg");
  assert.equal(result["speed"], "Traduction");
  assert.deepEqual(result["meta"]["units"], { distance: "m", weight: "kg" });
  assert.deepEqual(translator.batches, [["Backpack", "1.8 m. (1.2 cells) 2 in.", "9 m. (6 cells)"]]);
  // Le source n'est pas muté
  assert.equal(source["carryingCapacity"], 240);
  assert.deepEqual(source["meta"]["units"], { distance: "ft.", weight: "lb." });
});

test("conversion numérique idempotente : unités déjà métriques ou absentes", async () => {
  const translator = new RecordingTranslator();
  const metric = await translateCharacter(
    { meta: { units: { distance: "m", weight: "kg" } }, carryingCapacity: 108.9 },
    { phrases: {}, terms: {}, translator },
  ) as Record<string, any>;
  assert.equal(metric["carryingCapacity"], 108.9); // pas re-multiplié

  // Ni meta ni champs numériques : forme préservée clé pour clé
  const withoutMeta = await translateCharacter(
    { name: "X", notes: "text" },
    { phrases: {}, terms: {}, translator },
  ) as Record<string, any>;
  assert.deepEqual(Object.keys(withoutMeta).sort(), ["name", "notes"]);
});

test("poids du joueur déjà converti ou texte libre : inchangé, idempotent", () => {
  // Valeur déjà convertie ou champ libre : jamais de seconde conversion.
  for (const units of [{ distance: "m", weight: "kg" }, { distance: "ft.", weight: "lb." }]) {
    for (const source of ["91.6 kg", "grande carrure"]) {
      const input = {
        meta: { units: { ...units } },
        appearance: { weight: source },
      };
      const out = convertNumericUnits(JSON.parse(JSON.stringify(input))) as Record<string, any>;
      assert.equal(out["appearance"]["weight"], source, `poids ${source} ne doit pas être converti`);
    }
  }
  // meta.units impériales : le nombre nu est converti une seule fois…
  const imperial = convertNumericUnits({
    meta: { units: { distance: "ft.", weight: "lb." } },
    appearance: { weight: "92" },
  }) as Record<string, any>;
  assert.equal(imperial["appearance"]["weight"], "41.7 kg");
  // … puis plus rien à convertir au passage suivant (unités réécrites).
  const again = convertNumericUnits(imperial) as Record<string, any>;
  assert.equal(again["appearance"]["weight"], "41.7 kg");
});

test("repeated strings are translated once and batches are limited", async () => {
  const translator = new RecordingTranslator();
  const result = await translateCharacter(
    { desc: ["first", "second", "first"] },
    { phrases: {}, terms: {}, translator, batchSize: 1 },
  ) as Record<string, any>;

  assert.deepEqual(result["desc"], ["Traduction", "Traduction", "Traduction"]);
  assert.deepEqual(translator.batches, [["first"], ["second"]]);
});

test("failed batch retries each chunk separately", async () => {
  class BatchFailingTranslator implements TextTranslator {
    batches: string[][] = [];
    async translate(texts: string[]): Promise<string[]> {
      this.batches.push(texts);
      if (texts.length > 1) {
        throw new OllamaError("unexpected translation count");
      }
      return texts.map((text) => `FR: ${text}`);
    }
  }

  const translator = new BatchFailingTranslator();
  const warnings: string[] = [];
  const result = await translateCharacter(
    { desc: ["First text", "Second text"] },
    {
      phrases: {}, terms: {}, translator, batchSize: 2,
      warn: (message) => warnings.push(message),
    },
  ) as Record<string, any>;

  assert.deepEqual(result["desc"], ["FR: First text", "FR: Second text"]);
  assert.deepEqual(translator.batches, [
    ["First text", "Second text"],
    ["First text"],
    ["Second text"],
  ]);
  assert.ok(warnings[0].includes("$.desc[0]"));
  assert.ok(warnings[0].includes("$.desc[1]"));
});

test("failed individual retry reports JSON path", async () => {
  class AlwaysFailingTranslator implements TextTranslator {
    async translate(): Promise<string[]> {
      throw new OllamaError("unexpected translation count");
    }
  }

  const warnings: string[] = [];
  await assert.rejects(
    translateCharacter(
      { spells: [{ desc: "Spell description" }] },
      {
        phrases: {}, terms: {}, translator: new AlwaysFailingTranslator(),
        warn: (message) => warnings.push(message),
      },
    ),
    /JSON path\(s\) \$\.spells\[0\]\.desc/,
  );
  assert.ok(warnings.length > 0);
});

test("model must preserve glossary markers", async () => {
  const translator = new RecordingTranslator("Attaque surprise");
  const warnings: string[] = [];
  const result = await translateCharacter(
    { desc: "Use Sneak Attack." },
    {
      phrases: {},
      terms: { "Sneak Attack": "Attaque sournoise" },
      translator,
      warn: (message) => warnings.push(message),
    },
  ) as Record<string, any>;

  assert.equal(result["desc"], "Attaque surprise");
  assert.ok(warnings[0].includes("Attaque sournoise"));
  assert.ok(warnings[0].includes("expected 1 occurrence(s), found 0"));
  assert.ok(warnings[0].includes("Use Sneak Attack."));
  assert.ok(warnings[0].includes("Attaque surprise"));
});

test("model translation is kept when some repeated markers are missing", async () => {
  const translator = new RecordingTranslator("J'utilise __DNDTERM0000__.");
  const warnings: string[] = [];
  const result = await translateCharacter(
    { desc: "Sneak Attack and Sneak Attack" },
    {
      phrases: {},
      terms: { "Sneak Attack": "Attaque sournoise" },
      translator,
      warn: (message) => warnings.push(message),
    },
  ) as Record<string, any>;

  assert.equal(result["desc"], "J'utilise Attaque sournoise.");
  assert.ok(warnings[0].includes("expected 2 occurrence(s), found 1"));
});

test("all preserved markers are replaced without warning", async () => {
  const translator = new RecordingTranslator("Use __DNDTERM0000__.");
  const warnings: string[] = [];
  const result = await translateCharacter(
    { desc: "Use Sneak Attack." },
    {
      phrases: {},
      terms: { "Sneak Attack": "Attaque sournoise" },
      translator,
      warn: (message) => warnings.push(message),
    },
  ) as Record<string, any>;

  assert.equal(result["desc"], "Use Attaque sournoise.");
  assert.deepEqual(warnings, []);
});

test("source data is not mutated", async () => {
  const source = { desc: "English text" };
  await translateCharacter(source, {
    phrases: {}, terms: {}, translator: new RecordingTranslator(),
  });
  assert.deepEqual(source, { desc: "English text" });
});

test("ignored paths are not submitted or modified", async () => {
  const translator = new RecordingTranslator();
  const source = {
    proficiencies: [
      { name: "Skill: Stealth", desc: ["Proficiency description"] },
      "perception",
    ],
    class_type: {
      name: "Rogue",
      features: [{ name: "Sneak Attack" }],
    },
    spells_by_level: {
      "0": [{ name: "Spell name", desc: "Spell description" }],
    },
  };

  const result = await translateCharacter(source, {
    phrases: {}, terms: {}, translator,
    ignoredPaths: [
      "proficiencies",
      "class_type.features.*.name",
      "spells_by_level.*.*.desc",
    ],
  }) as Record<string, any>;

  assert.deepEqual(result["proficiencies"], source["proficiencies"]);
  assert.deepEqual(result["class_type"]["features"], source["class_type"]["features"]);
  assert.deepEqual(
    result["spells_by_level"]["0"][0]["desc"],
    source["spells_by_level"]["0"][0]["desc"],
  );
  assert.equal(result["spells_by_level"]["0"][0]["name"], "Traduction");
  assert.equal(result["class_type"]["name"], "Traduction");
  assert.deepEqual(translator.batches, [["Rogue", "Spell name"]]);
});

test("ignore path matches fields inside arrays without index wildcard", async () => {
  const translator = new RecordingTranslator();
  const source = {
    skills: [
      { name: "Acrobatics", description: "Skill description" },
      { name: "Perception", description: "Another description" },
    ],
  };

  const result = await translateCharacter(source, {
    phrases: {}, terms: {}, translator,
    ignoredPaths: ["skills.name"],
  }) as Record<string, any>;

  assert.deepEqual(
    result["skills"].map((skill: Record<string, string>) => skill["name"]),
    ["Acrobatics", "Perception"],
  );
  assert.deepEqual(
    result["skills"].map((skill: Record<string, string>) => skill["description"]),
    ["Traduction", "Traduction"],
  );
  assert.deepEqual(translator.batches, [["Skill description", "Another description"]]);
});

test("confidently French text is skipped", async () => {
  const translator = new RecordingTranslator();
  const french =
    "La voleuse se déplace dans les ruelles avec ses compagnons. " +
    "Elle peut ouvrir les portes sans faire de bruit et leur montre " +
    "toutes les cachettes.";

  const result = await translateCharacter(
    { desc: french },
    { phrases: {}, terms: {}, translator },
  ) as Record<string, any>;

  assert.equal(result["desc"], french);
  assert.deepEqual(translator.batches, []);
});

test("English text is not skipped as French", async () => {
  const translator = new RecordingTranslator();
  const english =
    "This set of tools includes a small file and a set of lock picks. " +
    "Proficiency with these tools lets you add your proficiency bonus " +
    "to any ability checks you make to disarm traps or open locks.";

  const result = await translateCharacter(
    { desc: english },
    { phrases: {}, terms: {}, translator },
  ) as Record<string, any>;

  assert.equal(result["desc"], "Traduction");
  assert.deepEqual(translator.batches, [[english]]);
});

test("long text is split and original spacing is preserved", async () => {
  const translator = new RecordingTranslator();
  const english =
    "This is the first sentence that needs translation.  " +
    "This is the second sentence that needs translation. " +
    "This is the third sentence that needs translation.";

  const result = await translateCharacter(
    { desc: english },
    {
      phrases: {}, terms: {}, translator, maxChunkChars: 70,
    },
  ) as Record<string, any>;

  assert.equal(
    result["desc"],
    "Traduction  Traduction Traduction",
  );
  assert.equal(translator.batches[0].length, 3);
  assert.ok(translator.batches[0].every((chunk) => chunk.length <= 70));
});

test("newline separated text is translated line by line", async () => {
  const translator = new RecordingTranslator();
  const english = "First line.\n\nSecond line.\r\nThird line.";

  const result = await translateCharacter(
    { desc: english },
    {
      phrases: {}, terms: {}, translator, maxChunkChars: 100,
    },
  ) as Record<string, any>;

  assert.equal(result["desc"], "Traduction\n\nTraduction\r\nTraduction");
  assert.deepEqual(
    translator.batches.flat(),
    ["First line.", "Second line.", "Third line."],
  );
});

test("long newline separated lines are chunked independently", async () => {
  class EchoTranslator implements TextTranslator {
    texts: string[] = [];
    async translate(texts: string[]): Promise<string[]> {
      this.texts.push(...texts);
      return texts;
    }
  }

  const translator = new EchoTranslator();
  const firstLine = "First sentence is long enough to need a chunk. Second sentence follows.";
  const secondLine = "This is a separate line and should remain separate.";
  const original = `${firstLine}\n${secondLine}`;

  const result = await translateCharacter(
    { desc: original },
    {
      phrases: {}, terms: {}, translator, maxChunkChars: 40,
    },
  ) as Record<string, any>;

  assert.equal(result["desc"], original);
  assert.ok(translator.texts.length > 2);
  assert.ok(translator.texts.every((chunk) => chunk.length <= 40));
  assert.ok(translator.texts.every((chunk) => !chunk.includes("\n")));
});

test("glossary terms are restored after chunk translation", async () => {
  class EchoTranslator implements TextTranslator {
    chunks: string[] = [];
    async translate(texts: string[]): Promise<string[]> {
      this.chunks.push(...texts);
      return texts;
    }
  }

  const translator = new EchoTranslator();
  const original =
    "This rule applies. Your proficiency bonus is added to the result. " +
    "The character can then continue.";

  const result = await translateCharacter(
    { desc: original },
    {
      phrases: {},
      terms: { "proficiency bonus": "bonus de maîtrise" },
      translator, maxChunkChars: 40,
    },
  ) as Record<string, any>;

  assert.ok(result["desc"].includes("bonus de maîtrise"));
  assert.ok(!result["desc"].includes("__DNDTERM"));
  assert.ok(translator.chunks.length > 1);
});

test("validation errors require one string per chunk", async () => {
  class WrongCountTranslator implements TextTranslator {
    async translate(texts: string[]): Promise<string[]> {
      return texts.slice(1);
    }
  }
  await assert.rejects(
    translateCharacter("text", {
      phrases: {}, terms: {}, translator: new WrongCountTranslator(),
    }),
    TranslationError,
  );
});

test("rejects non local service URLs", () => {
  assert.throws(
    () => new OllamaTranslator("model", "https://example.com"),
    /local HTTP URL/,
  );
  assert.throws(
    () => new OllamaTranslator("  "),
    /model name must not be empty/,
  );
});

test("parses structured response", async () => {
  const requestIds = [
    "00000000-0000-0000-0000-000000000001",
    "00000000-0000-0000-0000-000000000002",
  ];
  const requests: Array<Record<string, unknown>> = [];
  let call = 0;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
      json: async () => ({
        message: {
          content: JSON.stringify({
            translations: {
              [requestIds[1]]: "Salut",
              [requestIds[0]]: "Bonjour",
            },
          }),
        },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const translator = new OllamaTranslator("model", "http://localhost:11434", {
    fetchImpl,
    uuid: () => requestIds[call++],
  });
  const result = await translator.translate(["Hello", "Hi"], {});

  assert.deepEqual(result, ["Bonjour", "Salut"]);
  const payload = requests[0] as Record<string, any>;
  assert.equal(
    payload["messages"][1]["content"],
    JSON.stringify([
      { id: requestIds[0], text: "Hello" },
      { id: requestIds[1], text: "Hi" },
    ]),
  );
  assert.deepEqual(
    payload["format"]["properties"]["translations"]["required"],
    requestIds,
  );
});

test("missing request UUID error includes input batch", async () => {
  let call = 0;
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "",
    json: async () => ({ message: { content: '{"translations": {}}' } }),
  }) as unknown as Response) as unknown as typeof fetch;

  const translator = new OllamaTranslator("model", "http://localhost:11434", {
    fetchImpl,
    uuid: () => "00000000-0000-0000-0000-000000000001",
  });

  await assert.rejects(
    translator.translate(["Hello"], {}),
    (error: unknown) => {
      assert.ok(error instanceof OllamaError);
      const message = String(error);
      assert.ok(message.includes("00000000-0000-0000-0000-000000000001"));
      assert.ok(message.includes('"text": "Hello"'));
      assert.ok(message.includes('{"translations": {}}'));
      return true;
    },
  );
});

test("default output inserts fr before extension", () => {
  assert.equal(
    defaultOutputPath("elowen.expanded.json"),
    "elowen.expanded.fr.json",
  );
});

test("runTranslate writes a separate output file", async () => {
  const root = mkdtempSync(join(tmpdir(), "dnd-translator-"));
  const source = join(root, "character.json");
  writeFileSync(source, '{"desc": "English text"}', "utf8");
  writeFileSync(
    join(root, "rules.json"),
    JSON.stringify({ model: "local-model", terms: {}, phrases: {} }),
    "utf8",
  );
  const fakeEngine = new RecordingTranslator("Texte français");

  await runTranslate(
    source,
    join(root, "character.fr.json"),
    join(root, "rules.json"),
    () => fakeEngine,
  );

  assert.ok(existsSync(source));
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, "character.fr.json"), "utf8")),
    { desc: "Texte français" },
  );
});

test("missing source file returns 1 and debug prints the stack", async () => {
  const root = mkdtempSync(join(tmpdir(), "dnd-translator-"));
  const result = await main(
    [join(root, "missing.json"), "--debug"],
  );
  assert.equal(result, 1);
});

test("main rejects a missing source argument", async () => {
  const result = await main([]);
  assert.equal(result, 1);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}
console.log(`${tests.length - failed}/${tests.length} tests passed`);
process.exit(failed ? 1 : 0);
