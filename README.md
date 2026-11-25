# dnd-translator

Portage Node du module `translator` de la pipeline v1
([`../pdf-pipeline/dnd-beyond-extract/src/main/python/translator/`](../../pdf-pipeline/dnd-beyond-extract/src/main/python/translator/)).
Traduit les valeurs textuelles de n'importe quelle structure JSON (fiches de
personnage D&D 5e) en français, via Ollama **local** — aucun envoi distant.

Le comportement est identique à la version Python :

- conversion des unités avant traduction : `30 ft.` → `9 m. (6 cells)`,
  `10 lbs` → `4.5 kg` ; pour la structure maison de `dnd-dom-extract`, les
  poids numériques nus (`carryingCapacity`, `pushDragLift`,
  `equipment[].weight`, et `appearance.weight` — DnD Beyond n'accepte que
  des livres) sont aussi convertis (lb → kg, ×0.45359237) et `meta.units`
  est réécrit (`ft.` → `m`, `lb.` → `kg`) — l'afficheur lit l'unité dans
  les données ;
- glossaire de termes D&D protégés et phrases exactes versionnés dans
  `rules.json` (copié de v1 ; vérifier le modèle et les phrases après copie) ;
- texte déjà français détecté et laissé tel quel (heuristique locale) ;
- textes longs découpés (phrases, puis mots), retours à la ligne préservés ;
- traduction par lots avec IDs UUID et sortie structurée JSON schema côté
  Ollama ; un lot en échec est réessayé élément par élément ;
- sous-arbres exclus via `ignore_paths` ; champs techniques non traduits.

## Setup

```sh
nvm use          # .nvmrc
npm install
ollama pull qwen2.5:7b-instruct
```

Comme en v1, pour figer le modèle : `ollama cp qwen2.5:7b-instruct
dnd-translator:1.0` puis mettre à jour `rules.json`.

## Usage

```sh
npm run translate -- character.json
npm run translate -- character.json -o other.fr.json
./dist/cli.js character.json   # après npm run build
```

Le vocabulaire s'améliore en éditant `rules.json` à la main (phrases exactes
dans `phrases`, termes dans `terms`) :
`teach` de la version Python n'est pas porté.

Options : `--rules <fichier>` (défaut : `rules.json` à la racine du projet),
`--model`, `--ollama-url`, `--debug`.

L'API programmatique est exportée depuis `src/index.ts` :
`translateCharacter()` (service pur, traducteur injectable, utilisé par les
tests) et `OllamaTranslator` (client `/api/chat` avec format structuré).

## Development

```sh
npm test    # tests portés de v1 + tsc --noEmit
npm run build
```

## Différences résiduelles avec v1 (Python)

- Le JSON de sortie est resérialisé par `JSON.stringify` (ordre des clés
  préservé, mais pas le formatage d'origine).
- La détection « déjà en français » utilise une heuristique proche mais pas
  bit-à-bit identique au `casefold` de Python.
- La construction de la sortie structurée et le client HTTP sont natifs
  (`fetch` + `AbortSignal.timeout`), sans équivalent exact des erreurs
  `urllib` d'origine.
