# Steam categorizer

Organize your Steam library with an Effect v4 CLI. Sync your games, classify them automatically with TypeSafe's Jev model, and keep tags locally.

The CLI does not edit collections in the Steam client. Its runtime dependencies are `effect@4.0.1` and `@effect/platform-node@4.0.1`. TypeScript, `tsx`, Vitest, `@effect/vitest`, Oxlint, and Oxfmt are development tooling.

## Run the CLI

Use Node.js 22.19 or newer. Run these commands from this directory:

```sh
npm ci
npm run build
node dist/cli.js --help
```

For development, use `npm run dev -- <command>` instead of `node dist/cli.js <command>`.

## Try the sample library

Use a separate file so the sample does not replace your own library:

```sh
node dist/cli.js --file .steam-categorizer/demo.json import examples/games.json
node dist/cli.js --file .steam-categorizer/demo.json list
```

## Classify games with Jev

Get a TypeSafe API key from the [TypeSafe console](https://console.typesafe.ai/). In Bash, read the key without adding it to shell history:

```sh
read -r -s -p 'TypeSafe API key: ' TYPESAFE_API_KEY
echo
export TYPESAFE_API_KEY
node dist/cli.js --file .steam-categorizer/demo.json classify
unset TYPESAFE_API_KEY
```

`classify` is an alias for `review`. Both now run without per-game prompts. Omit `--file` to classify your default library.

The CLI calls `jev-latest` once per game, with all category questions in that request. It adds tags whose yes probability is at least 0.8:

`Action`, `Adventure`, `RPG`, `Strategy`, `Simulation`, `Puzzle`, `Platformer`, `Racing`, `Sports`, `Horror`, `Roguelike`, and `Co-op`.

Jev uses its knowledge of each game's name and Steam app ID. The CLI does not fetch store descriptions, so unknown games may receive no tags. These are model predictions, not verified Steam metadata. It never guesses personal labels such as `Completed`, `Dropped`, or `Favorites`.

Each successful classification saves immediately and marks the game reviewed, even if no tags meet the threshold. Existing tags are preserved. Run `classify` again to resume after an interruption or failure, or use `classify --all` to include previously reviewed games. Reclassification adds tags but does not remove existing ones. Use `untag` to remove a wrong prediction.

Use `--search` and `--category` to limit classification, for example `classify --category Unplayed`. Games reviewed manually in older versions are skipped unless you use `--all`.

Classification sends game names and app IDs to TypeSafe and may incur API charges. Steam IDs, playtime, and existing tags are not sent. The API key is not saved. Each request has a 30-second deadline, including response decoding. Failed requests are not retried automatically to avoid duplicate charges; run the command again to resume.

## Sync your Steam library

Get a [Steam Web API key](https://steamcommunity.com/dev/apikey). Use your 17-digit Steam ID, not your account name or vanity URL.

In Bash, read the key without adding it to shell history:

```sh
read -r -s -p 'Steam API key: ' STEAM_API_KEY
echo
export STEAM_API_KEY
node dist/cli.js sync YOUR_17_DIGIT_STEAM_ID
unset STEAM_API_KEY
```

If Steam does not return your games, check your Steam ID, API key, and **Game details** privacy setting. The CLI leaves your saved library unchanged on request failures or unavailable library responses.

Sync includes played free games. Your key stays in memory and is not written to the library file. Requests use HTTPS, retry transient failures twice, and have a 30-second deadline.

## Categorize and find games

Use `list` to find app IDs, then add your own tags:

```sh
node dist/cli.js list --search Portal
node dist/cli.js tag 620 Favorites "Co-op" Completed
node dist/cli.js list --category Favorites
node dist/cli.js untag 620 Completed
node dist/cli.js categories
node dist/cli.js review --category Unplayed
```

Tag names are case-sensitive. Search and category filters are case-insensitive. A game can have several tags. Use `list --json` for machine-readable output, or `list --unreviewed` to see games that have not been classified or reviewed.

Automatic groups come from Steam playtime:

- `Unplayed`: zero recorded minutes.
- `Sampled`: 1 through 119 recorded minutes.
- `Played`: at least 120 recorded minutes.
- `Recently played`: any recorded playtime in the last two weeks.

The CLI never infers completion from playtime. Add `Completed`, `Dropped`, or another tag yourself. `untag` removes custom tags, not automatic groups.

## Import games without an API key

Import a saved `GetOwnedGames` response or an array of objects with `appid`, `name`, and `playtime_forever`. Playtime is an integer number of minutes. `playtime_2weeks` is optional.

```sh
node dist/cli.js import games.json
```

Sync and import replace the game list. They preserve custom tags and review decisions for matching app IDs. Games absent from the new list, including their tags, are removed. Back up your library file before replacing it with a different library.

Use a separate `--file` for each account. Offline imports into an account's existing file keep that file's Steam ID.

## Export or back up your categories

Export to a different file, never to the library file being read:

```sh
node dist/cli.js export --format json > categorized-games.json
node dist/cli.js export --format csv > categorized-games.csv
```

Exports include automatic categories and custom tags. The CSV includes playtime in minutes. Import spreadsheet columns as text if game names or tags could contain formulas.

To back up or restore all decisions, copy the library JSON file directly. The `import` command reads Steam game data, not categorized exports.

By default, commands use `.steam-categorizer/library.json` relative to your current directory. Pass `--file /path/to/library.json` to use a fixed location. Writes use a temporary file and atomic rename. On Unix, saved files have owner-only permissions.

If a command reports a locked library, wait for the writer to finish. After a crash, remove the named `.lock` directory only after confirming that no command is writing that library.

## Check changes

```sh
npm run check
npm run lint
npm run format
npm test
npm run build
```

Use `npm run lint:fix` and `npm run format:fix` to apply fixes. Oxlint enables all five Effect rules vendored from Sheetz's `tools/oxlint/anti-slop/effect` plugin. Oxfmt uses the Sheetz configuration without its web-only Tailwind stylesheet path.

The tests cover category boundaries, input validation, refresh preservation, CSV escaping, persistence, competing writers, credential-safe errors, request deadlines, and command-line workflows. Jev tests also cover multi-label probability thresholds, malformed answers, per-game saves, resuming after failure, and preserving existing tags. HTTP tests use injected clients or mocked fetch responses and do not need real credentials.
