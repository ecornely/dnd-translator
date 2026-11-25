# dnd-translator

Traduit les valeurs textuelles d'un JSON de personnage D&D 5e en français,
via Ollama **local** — aucun envoi distant.

C'est l'une des briques de la pipeline `dom-pipeline` :

```
Tampermonkey (DOM + API) → dnd-dom-extract (JSON) → dnd-translator (JSON traduit) → dnd-print-sheets (fiche HTML à thèmes)
```

Le module fonctionne sur n'importe quelle structure JSON (fiches de
personnage D&D 5e typiques) :

- conversion des unités avant traduction : `30 ft.` → `9 m. (6 cells)`,
  `10 lbs` → `4.5 kg` ; pour la structure maison de `dnd-dom-extract`, les
  poids numériques nus (`carryingCapacity`, `pushDragLift`,
  `equipment[].weight`, et `appearance.weight` — DnD Beyond n'accepte que
  des livres) sont aussi convertis (lb → kg, ×0.45359237) et `meta.units`
  est réécrit (`ft.` → `m`, `lb.` → `kg`) — l'afficheur lit l'unité dans
  les données ;
- glossaire de termes D&D protégés et phrases exactes versionnés dans
  `rules.json` ;
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

Pour figer le modèle : `ollama cp qwen2.5:7b-instruct dnd-translator:1.0`
puis mettre à jour `rules.json`.

## Usage

```sh
npm run translate -- character.json
npm run translate -- character.json -o other.fr.json
./dist/cli.js character.json   # après npm run build
```

Le vocabulaire s'améliore en éditant `rules.json` à la main (phrases exactes
dans `phrases`, termes dans `terms`).

Options : `--rules <fichier>` (défaut : `rules.json` à la racine du projet),
`--model`, `--ollama-url`, `--debug`.

L'API programmatique est exportée depuis `src/index.ts` :
`translateCharacter()` (service pur, traducteur injectable, utilisé par les
tests) et `OllamaTranslator` (client `/api/chat` avec format structuré).

## Development

```sh
npm test    # tsx test/translator.test.ts && tsc --noEmit
npm run build
```

## Limites connues

- Le JSON de sortie est resérialisé par `JSON.stringify` (ordre des clés
  préservé, mais pas le formatage d'origine).
- La détection « déjà en français » est une heuristique, pas une mesure
  exacte.

## Licence

GPL-3.0-or-later — voir [LICENSE](LICENSE).
