# Steam categorizer

Organize your Steam library with a Foldkit web app or an Effect v4 CLI. Sync games, import Steam files, and classify games with TypeSafe's Jev model.

Neither interface edits collections in the Steam client. Effect packages are pinned to `4.0.0` to match Foldkit's peer dependency. The CLI keeps its library locally; the web app saves private libraries and category definitions in Cloudflare D1.

## Run the web app locally

Use Node.js 22.19 or newer. Build the assets and initialize the local database:

```sh
npm ci
npm run web:build
npm run web:db
```

Run `npm run web:api` and `npm run web:dev` in separate terminals. Open the Vite address printed in the second terminal. Local development uses a shared test identity, not Cloudflare Access. The bypass requires a loopback request and is absent from the Alchemy deployment.

To enable Steam sync and classification locally, put `STEAM_API_KEY` and `TYPESAFE_API_KEY` in `web/.dev.vars`. This file is ignored by Git. Without keys, imports, editing, exports, and category definitions still work. Never put keys in `VITE_*` variables.

## Import a library

Choose **Import** and upload or paste one of these JSON formats:

- A CLI library file, including its Steam ID, tags, and review flags.
- CLI export JSON.
- Steam `GetOwnedGames` JSON or a raw game array.

Confirm replacement before importing. Steam game data refreshes matching games while preserving existing tags and review flags. A CLI library import restores its own saved tags and flags. Games absent from the import are removed.

After importing games, use **Steam memberships** to upload a Steam `cloud-storage-namespace-1.json` file. Static collection membership becomes tags on matching app IDs. Deleted collections and removed memberships are excluded. Dynamic collection filters are skipped, not reconstructed. This file cannot supply game names or playtime on its own.

Use **Category criteria** to edit classification questions or import a criteria JSON file. **Import collection names** converts Steam collection names into editable definitions without importing membership. Category definitions are saved under your verified sign-in and the active Steam ID. Offline imports use a separate offline key. Unsaved drafts remain in the tab. Download category JSON separately from the library backup.

## Background classification

**Classify** submits the current search and category filter to a Cloudflare Workflow. Jobs snapshot category definitions and process at most 500 games, in batches of up to three concurrent games. The Workflow saves each game's results in D1 and continues after the tab closes. Reopening the app loads saved progress. **Cancel job** prevents new paid requests and preserves results from requests already in flight. Jobs started before concurrent classification was added finish sequentially.

The workflow uses Alchemy's Effect-native `Workflow` and `task` APIs. The custom Worker entry exports Alchemy's workflow bridge as `ClassificationWorkflow`, retaining the deployed `CLASSIFICATION` binding. Checkpoint names remain stable so existing jobs can replay saved steps.

Paid requests are not automatically retried. If a provider response is lost, the app blocks further classification until you explicitly clear the uncertain paid lock. Recovery can cause duplicate charges. Starting a new job skips already reviewed games unless you select the option to include them.

## Deploy privately with Alchemy

Deployment provisions a Worker, D1, a rate-limit Durable Object, a Workflow, and Cloudflare Access with email PIN login. Allowlists protect the app, API, and preview URLs. Each authenticated email owns an isolated library. Entering a Steam ID does not prove Steam ownership; sync requires that account's game details to be public.

The [Deploy workflow](.github/workflows/deploy.yml) runs on pushes to `main` or a manual dispatch on `main`. Type checks, lint, formatting, tests, and builds must pass before deployment. Deployments use the GitHub `production` environment and run one at a time.

Configure deployment before merging the workflow:

1. Configure a Cloudflare account and Zero Trust organization. Enable the account's Workers subdomain and ensure the `carneloot.com` zone is active in that account. The app uses `steam-organizer.carneloot.com` as its canonical hostname; Alchemy attaches the Worker custom domain and Cloudflare manages its DNS record and TLS certificate. The existing Access application also protects the custom domain.
2. Create a 1Password item named `steam-organizer-github` in the `Secrets` vault with these fields:

   | Field                   | Value                                                             |
   | ----------------------- | ----------------------------------------------------------------- |
   | `CLOUDFLARE_ACCOUNT_ID` | The target Cloudflare account ID                                  |
   | `CLOUDFLARE_API_TOKEN`  | An API token scoped to the target account                         |
   | `STEAM_API_KEY`         | The server-side Steam API key                                     |
   | `TYPESAFE_API_KEY`      | The server-side TypeSafe API key                                  |
   | `ACCESS_EMAILS`         | Comma-separated explicit email addresses for you and your friends |

3. Grant the Cloudflare token edit/write permissions for Workers Scripts, D1, Access: Apps and Policies, Access: Organizations, Identity Providers, and Groups, and Secrets Store. Add Zone Read scoped to `carneloot.com` for automatic domain lookup. Scope the token to the target account and zone. Worker custom-domain attachment does not require separate DNS Edit or Workers Routes Edit permissions.
4. Give a 1Password service account read access to the item. Store its token as the GitHub repository secret `OP_SERVICE_ACCOUNT_TOKEN` so same-repository PR plans can use it. Create a GitHub environment named `production`, restrict it to `main`, and add required reviewers if you want approval before deployment. You can override the repository token with an environment secret of the same name for deployment.

The workflows use `1password/load-secrets-action@v5`, matching `bg3-equipment-guide`. Each field resolves from `op://Secrets/steam-organizer-github/<field>`. Resolved values are passed only to deployment, planning, and comment redaction steps, not exported globally. No Cloudflare profile or additional state password is required.

Workers serving Static Assets do not receive `ctx.access` through Cloudflare's internal router, even after login. The server therefore verifies `Cf-Access-Jwt-Assertion` against the fixed team issuer and application audience, using Cloudflare's public signing keys. It validates the signature, expiration, and claims before using the email as the library owner. Raw email headers and unsigned tokens are never trusted. Direct invocations with native `ctx.access` continue using that verified identity.

Alchemy derives the server-side verification settings automatically. It reads the existing Zero Trust organization's team domain without changing its settings and binds the protecting Access application's `aud` output to the Worker. The application retains its `Web/Access` resource identity and login policy. No extra 1Password fields are needed. Do not add a separate hostname-specific Access application for this domain, since it takes precedence over the Worker-level application and issues tokens with a different audience. Missing or incorrect verification settings fail closed.

Alchemy uses Cloudflare-backed state and the `production` stage, so fresh GitHub runners share the same deployment state. If you already deployed with the previous local-state configuration, migrate that state before enabling CI deployment. Do not discard it or automatically adopt existing resources.

### Production plans on pull requests

The [Alchemy Production Plan workflow](.github/workflows/alchemy-plan.yml) follows `sheetz`: it plans the PR head against the `production` stage and creates or updates one bot-owned PR comment. The comment lists resource, binding, and stack-action changes, identifies the revision, and links to the workflow run. Planning failures also produce a comment and fail the job. Outdated runs are canceled and do not overwrite comments for a newer revision.

The workflow uses Alchemy's structured `Stack.plan` API without applying the plan. It disables state-store updates, so the Cloudflare-backed state store must already be bootstrapped through an authorized deployment before PR planning can succeed. Planning still evaluates PR code and contacts Cloudflare; it is not an offline diff. Raw logs and resource properties are excluded from comments, and configured secrets and allowlisted emails are redacted.

Planning logs show Cloudflare API methods, sanitized route templates, and HTTP statuses for each attempt, including retries. Resource identifiers, query strings, headers, and bodies are omitted. Transport failures are logged without their error payloads. These diagnostics do not read response bodies, so an HTTP 200 response containing an API-level error still appears as HTTP 200; use it alongside the final Alchemy error. Diagnostic logs remain in the workflow run, not the PR comment.

Fork PRs are skipped. Same-repository PR authors must be trusted with the production credentials because their code runs in the planning job. The plan job does not use the `production` environment restricted to `main`; it needs the repository-level 1Password token described above. Production deployment still uses the protected environment.

Cloudflare permits one email PIN identity provider per scope. If an existing provider is not owned by this stack, resolve its reuse or adoption before the first deployment. The workflow does not pass `--adopt` automatically.

Do not deploy `web/wrangler.local.jsonc`; it is exclusively for the emulator. Add friends by updating the 1Password `ACCESS_EMAILS` field and running Deploy on `main`. The workflow provisions resources and the custom hostname on the first run; the Cloudflare zone must already exist. It does not copy the reference project's public-page health check or Worker-only rollback, which would not verify this Access-protected app or roll back its D1 migrations.

All invited users share the deployed Steam and TypeSafe credentials and their costs. API keys never reach the browser. Classification sends game names, app IDs, descriptions, and your category questions to TypeSafe, not Steam IDs or existing tags. Libraries and category definitions are server-side, not browser-only.

The cloud deployment and live Access login require verification after provisioning. Local tests use mocked provider traffic and do not incur charges. Alchemy and the current Wrangler runtime are pinned prerelease tooling; inspect `npm audit` before deploying. Production browser dependencies have no reported vulnerabilities, but development tooling currently includes upstream audit findings.

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

The CLI calls `jev-latest` once per game, with all category questions in that request. It adds tags whose yes probability is at least 0.8. The default categories are:

`Action`, `Adventure`, `RPG`, `Strategy`, `Simulation`, `Puzzle`, `Platformer`, `Racing`, `Sports`, `Horror`, `Roguelike`, and `Co-op`.

Before classification, the CLI tries to fetch the game's English description from Steam's public store endpoint. It prefers the detailed description and falls back to the short description. This lookup does not need a Steam API key and has a five-second deadline. If the description is missing, Steam is unavailable, or the lookup times out, Jev uses the game name and app ID alone. Descriptions are used for classification but are not saved to the library.

Jev uses the description and its knowledge of the game to predict tags. These are model predictions, not verified Steam metadata. The default categories do not include personal labels such as `Completed`, `Dropped`, or `Favorites`.

The CLI classifies games in batches of up to three concurrent games while retaining Steam and TypeSafe rate limits. Each successful classification saves immediately and marks the game reviewed, even if no tags meet the threshold. Saves run one at a time to prevent file-lock conflicts. If a game fails, the CLI saves successful results from the rest of the batch before stopping. Existing tags are preserved. Run `classify` again to resume after an interruption or failure, or use `classify --all` to include previously reviewed games. Reclassification adds tags but does not remove existing ones. Use `untag` to remove a wrong prediction.

Use `--search` and `--category` to limit classification, for example `classify --category Unplayed`. Games reviewed manually in older versions are skipped unless you use `--all`.

Classification sends game names, app IDs, and available store descriptions to TypeSafe and may incur API charges. Steam IDs, playtime, and existing tags are not sent. The API key is not saved. The CLI fetches the description first with a five-second deadline, then calls the classifier with a separate 30-second deadline, including response decoding. Failed Jev requests are not retried automatically to avoid duplicate charges; run the command again to resume.

## Customize classification categories

Create a JSON file such as `my-categories.json`. Map each category name to a description of when it applies:

```json
{
	"Cozy farming": "Includes farming and low-pressure play.",
	"Competitive": "Players compete against each other."
}
```

With `TYPESAFE_API_KEY` set, run:

```sh
node dist/cli.js classify --categories-file my-categories.json
```

`--categories-file` works with both `classify` and `review`. Paths are relative to your current directory. The file replaces the default classification categories for that run. Omit the flag to use the defaults. The file must contain at least one category. Names and descriptions must be nonempty and have no leading or trailing whitespace. Names cannot contain control characters. Invalid or unreadable files stop the command before any requests or library changes.

Jev evaluates each category independently, so a game can receive several tags or none. The 0.8 probability threshold still applies. Category names and descriptions are sent to TypeSafe. Use criteria that the public description can support, not personal judgments such as whether you finished or liked a game.

To apply new categories to previously reviewed games, add `--all`:

```sh
node dist/cli.js classify --all --categories-file my-categories.json
```

Existing tags and playtime groups are preserved. Changing the file does not automatically reclassify games or remove old tags. Use `untag` to remove tags you no longer want.

Callers obtain the `Classifier` service and pass a decoded `CategoryCriteria` map as the second argument to `classifier.classifyGame(game, criteria)`. Decode custom maps with `Schema.decodeUnknownEffect(CategoryCriteria)` at the input boundary; the classifier does not decode them again. The game input contains `appid`, `name`, and `description`, which is a string or `null` when unavailable. The classifier does not fetch descriptions. The exported `defaultCategoryCriteria` map in `src/domain/classification.ts` can be spread into a custom map to extend or override the defaults.

## Extract categories from Steam collections

Exit Steam, then copy its active collections file from:

```text
<Steam folder>/userdata/<account-id>/config/cloudstorage/cloud-storage-namespace-1.json
```

The namespace number can differ. Pass the namespace file containing `user-collections.*` records, not `cloud-storage-namespaces.json`, `localconfig.vdf`, or an old LevelDB file.

Redirect the extracted config to a new file. Never redirect to the Steam source file, your library file, or a config you want to keep. Shell redirection truncates the destination before the command runs, even when extraction fails.

```sh
node dist/cli.js extract-categories /path/to/cloud-storage-namespace-1.json > my-categories.json
```

The command runs offline and does not need an API key. Standard output contains only the category config JSON. A reminder to review descriptions goes to standard error. The command does not write to Steam or your local library.

Extraction includes names from both static and dynamic collections. It ignores unrelated records, deleted collections, and records without a value. It trims names, combines identical names, and sorts them. Malformed active records or files with no active collections fail without printing a partial config.

Steam collections supply names, not Jev classification descriptions. Exact matches to the built-in category names reuse their descriptions. Other names receive a description such as `Games matching the category "Cozy farming".` Edit these descriptions to explain your intended criteria, and remove personal categories such as `Favorites` or `Completed` before classification.

With `TYPESAFE_API_KEY` set, use the resulting file:

```sh
node dist/cli.js classify --all --categories-file my-categories.json
```

This extracts classification categories only. It does not import existing game memberships or convert dynamic collection filters into classification rules.

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

## API rate limits

`SteamLayer` and `JevLayer` construct their clients directly with Effect's `HttpClient.withRateLimiter`. The CLI provides `RateLimiter` backed by `FileRateLimiterStoreLayer`. Each API has a separate initial budget:

| API                      | Initial pacing                            |
| ------------------------ | ----------------------------------------- |
| Steam Web API            | One request per second, including retries |
| Steam store descriptions | One request every two seconds             |
| TypeSafe Jev             | One request per second                    |

These are conservative application defaults, not promises about provider capacity. Steam's [Web API terms](https://steamcommunity.com/dev/apiterms) allow 100,000 calls per day. TypeSafe's [model documentation](https://docs.typesafe.ai/models) currently lists 80 requests per second and 100K tokens per second, with limits subject to change. Valve does not publish a quota for the public store endpoint in those Web API terms.

Effect inspects rate-limit response headers. HTTP 429 responses also persist a cooldown based on `Retry-After`, supporting both seconds and HTTP dates. Without a usable header, the cooldown is five minutes for the Steam store and one minute for the other APIs. Jev requests are still not retried automatically. Steam's existing retries pass through the limiter.

Counters and cooldowns are shared across CLI processes and restarts in `~/.cache/steam-categorizer/rate-limits`, independently of `--file` and the working directory. Set `API_RATE_LIMIT_DIRECTORY` to use another shared directory. State files contain no API keys or request payloads. Writes use locks, atomic rename, and owner-only file permissions. Invalid or unwritable state prevents requests rather than bypassing the limiter.

Rate-limit waits count toward the existing request deadlines. A long cooldown can cause sync or classification to time out without sending a request. Description lookups still fall back to no description after five seconds. After a crash, remove stale `.lock` directories from the rate-limit directory only after confirming that no CLI process is running.

The store coordinates processes that share its directory, not other applications or machines using the same credentials or public IP. Callers that compose `SteamLayer` or `JevLayer` outside the CLI must provide `RateLimiter.layer` and a `RateLimiterStore`. Both adapters apply their rate-limit policy without a separate HTTP wrapper. HTTP unit tests use Effect's in-memory store; filesystem store tests are separate.

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

## Source structure

```text
src/
├── cli.ts                     # Commands and runtime layer composition
├── cli.test.ts                # CLI integration tests
├── domain/
│   ├── classification.ts      # Classifier input and category criteria
│   ├── classification.test.ts # Criteria validation tests
│   └── library.ts             # Schemas and pure library transformations
├── services/
│   ├── app-config.ts          # AppConfig values and configuration errors
│   ├── classifier.ts          # Classifier contract
│   ├── collections.ts         # Collections contract
│   ├── library.ts             # LibraryService contract
│   ├── library-store.ts       # LibraryStore persistence contract
│   └── steam.ts               # Steam contract
└── layers/
    ├── app-config.ts          # AppConfigLayer reads runtime configuration
    ├── collections.ts         # CollectionsLayer
    ├── jev.ts                 # JevLayer implements Classifier
    ├── library.ts             # LibraryLayer
    ├── library-store.ts       # FileLibraryStoreLayer
    ├── rate-limit-feedback.ts # Retry-After date workaround and fallback cooldowns
    ├── rate-limiter-store.ts  # FileRateLimiterStoreLayer implements Effect's store
    ├── steam.ts               # SteamLayer uses HttpClient, RateLimiter, LibraryService, AppConfig
    └── *.test.ts              # Implementation tests
```

List the source files with `rg --files src`. Service methods expose their result and error types without implementation dependencies. Layers acquire dependencies once and supply those methods. Pure functions, such as category derivation and library merging, stay in `domain/`.

`JevLayer` requires an HTTP client, `AppConfig`, and `RateLimiter`. The CLI obtains descriptions through `Steam` and passes them to `Classifier`. Another caller can supply descriptions from a different source without providing a Steam layer:

```ts
import { NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { RateLimiter } from 'effect/persistence';
import { AppConfigLayer } from './src/layers/app-config.js';
import { JevLayer } from './src/layers/jev.js';
import { FileRateLimiterStoreLayer } from './src/layers/rate-limiter-store.js';
import { Classifier } from './src/services/classifier.js';

const classify = Effect.gen(function* () {
	const classifier = yield* Classifier;
	return yield* classifier.classifyGame({
		appid: 620,
		name: 'Portal 2',
		description: 'Cooperative spatial puzzles in a dedicated campaign.',
	});
}).pipe(
	Effect.provide(JevLayer),
	Effect.provide(AppConfigLayer),
	Effect.provide(
		RateLimiter.layer.pipe(Layer.provide(FileRateLimiterStoreLayer)),
	),
	Effect.provide(FetchHttpClient.layer),
	Effect.provide(NodeServices.layer),
);
```

`AppConfigLayer` reads both API keys once at layer construction and rejects whitespace-only values. `AppConfig` exposes plain redacted values, with `null` for unset keys. Jev and Steam select their credential-dependent implementation at layer construction, without checking configuration on each call. Missing keys disable classification or library sync respectively; offline commands and public Steam description lookup remain available. Tests can inject an `AppConfig` with `Layer.succeed` without reading environment variables.

Each service declares its tagged errors alongside its contract. Callers can distinguish request failures, invalid responses, timeouts, invalid imports, missing games, locked files, and persistence failures without inspecting message text. `LibraryStore.modify` preserves the update callback's error type. The CLI handles these tags at the command boundary and prints their messages.

## Check changes

```sh
npm run check
npm run lint
npm run format
npm test
npm run build
```

Use `npm run lint:fix` and `npm run format:fix` to apply fixes. Oxlint enables all five Effect rules vendored from Sheetz's `tools/oxlint/anti-slop/effect` plugin. Oxfmt uses the Sheetz configuration without its web-only Tailwind stylesheet path.

Oxlint also runs the official Effect type-aware rules from the `@effect/tsgo` recommended preset. The `prepare` script patches Oxlint and `oxlint-tsgolint` after `npm install` or `npm ci`; it does not patch TypeScript. These three packages are pinned to compatible versions. When upgrading them, check the [supported versions and Oxlint setup guide](https://github.com/Effect-TS/tsgo/blob/main/docs/README.md). The Oxlint integration is experimental. Recommended rule severities are retained, so warnings are reported without failing lint unless `--deny-warnings` is passed.

The tests cover category boundaries, input validation, refresh preservation, CSV escaping, persistence, competing writers, credential-safe errors, request deadlines, and command-line workflows. Jev tests also cover multi-label probability thresholds, malformed answers, per-game saves, resuming after failure, and preserving existing tags. HTTP tests use injected clients or mocked fetch responses and do not need real credentials.
