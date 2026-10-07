#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, FileSystem, Layer, Schema } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import {
	CategoryCriteria,
	defaultCategoryCriteria,
} from './domain/classification.js';
import {
	AppId,
	categories,
	Category,
	exportLibrary,
	mergeLibrary,
	selectGames,
	SteamId,
	terminalText,
} from './domain/library.js';
import { AppConfigLayer } from './layers/app-config.js';
import { CollectionsLayer } from './layers/collections.js';
import { JevLayer } from './layers/jev.js';
import { FileLibraryStoreLayer } from './layers/library-store.js';
import { LibraryLayer } from './layers/library.js';
import { SteamLayer } from './layers/steam.js';
import { Classifier } from './services/classifier.js';
import { Collections } from './services/collections.js';
import { LibraryStore } from './services/library-store.js';
import { LibraryService } from './services/library.js';
import { Steam } from './services/steam.js';

class InputFileError extends Schema.TaggedError<InputFileError>()(
	'InputFileError',
	{ message: Schema.String },
) {}
class InvalidCategoriesError extends Schema.TaggedError<InvalidCategoriesError>()(
	'InvalidCategoriesError',
	{ message: Schema.String },
) {}
class AccountMismatchError extends Schema.TaggedError<AccountMismatchError>()(
	'AccountMismatchError',
	{ message: Schema.String },
) {}

const root = Command.make('steam-categorizer').pipe(
	Command.withDescription(
		'Organize your Steam games locally. Never modifies the Steam client.',
	),
	Command.withSharedFlags({
		file: Flag.String('file').pipe(
			Flag.withDefault('.steam-categorizer/library.json'),
			Flag.withDescription(
				'Local library file, relative to the current directory',
			),
		),
	}),
);

const sync = Command.make(
	'sync',
	{
		steamId: Argument.String('steam-id').pipe(Argument.withSchema(SteamId)),
	},
	Effect.fn('CLI.sync')(function* ({ steamId }) {
		const { file } = yield* root;
		const store = yield* LibraryStore;
		const steam = yield* Steam;
		const games = yield* steam.fetchLibrary(steamId);
		const library = yield* store.modify(
			file,
			Effect.fn(function* (previous) {
				if (previous.steamId !== null && previous.steamId !== steamId) {
					return yield* new AccountMismatchError({
						message:
							'This file belongs to another Steam account. Use --file with a different path.',
					});
				}
				return mergeLibrary(previous, games, steamId);
			}),
		);
		yield* Console.log(
			`Synced ${library.games.length} games to ${file}. Existing tags were preserved by app ID.`,
		);
	}),
).pipe(
	Command.withDescription(
		'Fetch owned games. Requires STEAM_API_KEY and a 17-digit Steam ID.',
	),
);

const importCommand = Command.make(
	'import',
	{
		input: Argument.String('input-json'),
	},
	Effect.fn('CLI.import')(function* ({ input }) {
		const { file } = yield* root;
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs.readFileString(input).pipe(
			Effect.mapError(
				(error) =>
					new InputFileError({
						message: `Cannot read import ${input}: ${error.reason._tag}`,
					}),
			),
		);
		const library = yield* LibraryService;
		const games = yield* library.decodeImport(text);
		const store = yield* LibraryStore;
		yield* store.modify(file, (previous) =>
			Effect.succeed(mergeLibrary(previous, games, previous.steamId)),
		);
		yield* Console.log(`Imported ${games.length} games to ${file}.`);
	}),
).pipe(
	Command.withDescription(
		'Replace the game list from JSON, preserving tags for matching app IDs.',
	),
);

const extractCategories = Command.make(
	'extract-categories',
	{ input: Argument.String('collections-json') },
	Effect.fn('CLI.extractCategories')(function* ({ input }) {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs.readFileString(input).pipe(
			Effect.mapError(
				(error) =>
					new InputFileError({
						message: `Cannot read collections ${input}: ${error.reason._tag}`,
					}),
			),
		);
		const collections = yield* Collections;
		const criteria = yield* collections.extractCategoryCriteria(text);
		yield* Console.log(JSON.stringify(criteria, null, 2));
		yield* Console.error(
			`Extracted ${Object.keys(criteria).length} categories. Review the descriptions before classification, especially personal collections. Redirect stdout to a new categories file.`,
		);
	}),
).pipe(
	Command.withDescription(
		'Extract Steam collection names as a categories config JSON on stdout. Never modifies Steam or your library.',
	),
);

const filters = {
	search: Flag.String('search').pipe(Flag.withDefault('')),
	category: Flag.String('category').pipe(Flag.withDefault('')),
};
const list = Command.make(
	'list',
	{
		...filters,
		unreviewed: Flag.Boolean('unreviewed').pipe(Flag.withDefault(false)),
		json: Flag.Boolean('json').pipe(Flag.withDefault(false)),
	},
	Effect.fn('CLI.list')(function* ({ search, category, unreviewed, json }) {
		const { file } = yield* root;
		const store = yield* LibraryStore;
		const games = selectGames(
			yield* store.load(file),
			search,
			category,
			unreviewed,
		);
		if (json) {
			yield* Console.log(
				JSON.stringify(
					games.map((game) => ({ ...game, categories: categories(game) })),
					null,
					2,
				),
			);
			return;
		}
		if (games.length === 0)
			yield* Console.log(
				'No games found. Use sync or import to load a library, or change your filters.',
			);
		for (const game of games) {
			yield* Console.log(
				`${game.appid}\t${terminalText(game.name)}\t${(game.playtime_forever / 60).toFixed(1)}h\t${categories(game).join(', ')}${game.reviewed ? '' : ' [unreviewed]'}`,
			);
		}
	}),
).pipe(
	Command.withDescription('List games with automatic groups and custom tags.'),
);

const summary = Command.make(
	'categories',
	{},
	Effect.fn('CLI.categories')(function* () {
		const { file } = yield* root;
		const store = yield* LibraryStore;
		const library = yield* store.load(file);
		const counts = new Map<string, number>();
		for (const game of library.games) {
			for (const category of categories(game))
				counts.set(category, (counts.get(category) ?? 0) + 1);
		}
		yield* Console.log(
			`${library.games.length} games, ${library.games.filter((game) => !game.reviewed).length} unreviewed`,
		);
		for (const [category, count] of [...counts].sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			yield* Console.log(`${category}\t${count}`);
		}
	}),
).pipe(
	Command.withDescription(
		'Show category counts. A game can belong to multiple categories.',
	),
);

const tagArguments = {
	appid: Argument.Int('appid').pipe(Argument.withSchema(AppId)),
	tags: Argument.String('tags').pipe(
		Argument.withSchema(Category),
		Argument.variadic({ min: 1 }),
	),
};
const tag = Command.make(
	'tag',
	tagArguments,
	Effect.fn('CLI.tag')(function* ({ appid, tags }) {
		const { file } = yield* root;
		const store = yield* LibraryStore;
		const libraryService = yield* LibraryService;
		yield* store.modify(file, (library) =>
			libraryService.updateGame(library, appid, (game) => ({
				...game,
				tags: [...new Set([...game.tags, ...tags])],
			})),
		);
		yield* Console.log(`Tagged ${appid}: ${tags.join(', ')}`);
	}),
).pipe(Command.withDescription('Add one or more custom tags to a game.'));

const untag = Command.make(
	'untag',
	tagArguments,
	Effect.fn('CLI.untag')(function* ({ appid, tags }) {
		const { file } = yield* root;
		const store = yield* LibraryStore;
		const libraryService = yield* LibraryService;
		yield* store.modify(file, (library) =>
			libraryService.updateGame(library, appid, (game) => ({
				...game,
				tags: game.tags.filter((tag) => !tags.includes(tag)),
			})),
		);
		yield* Console.log(
			`Removed custom tags from ${appid}. Automatic groups are derived from playtime.`,
		);
	}),
).pipe(
	Command.withDescription('Remove custom tags. Tag names are case-sensitive.'),
);

const review = Command.make(
	'review',
	{
		...filters,
		categoriesFile: Flag.String('categories-file').pipe(
			Flag.withDefault(''),
			Flag.withDescription(
				'JSON map of category names to descriptions; replaces classification defaults',
			),
		),
		all: Flag.Boolean('all').pipe(
			Flag.withDefault(false),
			Flag.withDescription('Include games already reviewed'),
		),
	},
	Effect.fn('CLI.review')(function* ({
		search,
		category,
		categoriesFile,
		all,
	}) {
		const { file } = yield* root;
		let criteria: CategoryCriteria = defaultCategoryCriteria;
		if (categoriesFile !== '') {
			const fs = yield* FileSystem.FileSystem;
			const text = yield* fs.readFileString(categoriesFile).pipe(
				Effect.mapError(
					(error) =>
						new InputFileError({
							message: `Cannot read categories ${categoriesFile}: ${error.reason._tag}`,
						}),
				),
			);
			criteria = yield* Schema.decodeUnknownEffect(
				CategoryCriteria.pipe(Schema.fromJsonString),
			)(text).pipe(
				Effect.mapError(
					() =>
						new InvalidCategoriesError({
							message: `Invalid categories file ${categoriesFile}. Expected a nonempty JSON object mapping category names to nonempty, trimmed descriptions. Names must be trimmed and cannot contain control characters.`,
						}),
				),
			);
		}
		const store = yield* LibraryStore;
		const initial = yield* store.load(file);
		const classifier = yield* Classifier;
		const steam = yield* Steam;
		const libraryService = yield* LibraryService;
		const games = selectGames(initial, search, category, !all);
		for (const game of games) {
			yield* Console.log(
				`\n${terminalText(game.name)} (${game.appid}) | ${(game.playtime_forever / 60).toFixed(1)}h | ${categories(game).join(', ')}`,
			);
			const description = yield* steam.fetchGameDescription(game.appid);
			const tags = yield* classifier.classifyGame(
				{ appid: game.appid, name: game.name, description },
				criteria,
			);
			yield* store.modify(file, (library) =>
				libraryService.updateGame(library, game.appid, (current) => ({
					...current,
					tags: [...new Set([...current.tags, ...tags])],
					reviewed: true,
				})),
			);
			yield* Console.log(`Saved Jev tags: ${tags.join(', ') || 'none'}.`);
		}
		yield* Console.log(
			`Classified ${games.length} games. Saved games will be skipped next time unless you use --all.`,
		);
	}),
).pipe(
	Command.withAlias('classify'),
	Command.withDescription(
		'Automatically tag unreviewed games with TypeSafe Jev. Requires TYPESAFE_API_KEY. Saves after each game.',
	),
);

const exportCommand = Command.make(
	'export',
	{
		format: Flag.Literals('format', ['json', 'csv']).pipe(
			Flag.withDefault('json'),
		),
	},
	Effect.fn('CLI.export')(function* ({ format }) {
		const { file } = yield* root;
		const store = yield* LibraryStore;
		yield* Console.log(exportLibrary(yield* store.load(file), format));
	}),
).pipe(
	Command.withDescription(
		'Print JSON or CSV to stdout. Redirect it to an export file.',
	),
);

const steamLayer = SteamLayer.pipe(Layer.provide(LibraryLayer));
const appLayer = Layer.mergeAll(
	LibraryLayer,
	CollectionsLayer,
	FileLibraryStoreLayer,
	steamLayer,
	JevLayer,
).pipe(
	Layer.provide(AppConfigLayer),
	Layer.provide(FetchHttpClient.layer),
	Layer.provide(NodeServices.layer),
);

const reportError = (error: { readonly message: string }) =>
	Console.error(error.message).pipe(
		Effect.andThen(
			Effect.sync(() => {
				process.exitCode = 1;
			}),
		),
	);

root.pipe(
	Command.withSubcommands([
		sync,
		importCommand,
		extractCategories,
		list,
		summary,
		tag,
		untag,
		review,
		exportCommand,
	]),
	Command.run({ version: '0.1.0' }),
	Effect.provide(appLayer),
	Effect.catchTags({
		ConfigurationError: reportError,
		ClassificationRequestError: reportError,
		ClassificationResponseError: reportError,
		ClassificationTimeoutError: reportError,
		SteamRequestError: reportError,
		SteamResponseError: reportError,
		SteamTimeoutError: reportError,
		ImportDecodeError: reportError,
		InvalidOwnedGamesError: reportError,
		GameNotFoundError: reportError,
		CollectionsDecodeError: reportError,
		NoActiveCollectionsError: reportError,
		LibraryReadError: reportError,
		InvalidLibraryError: reportError,
		LibraryLockedError: reportError,
		LibraryWriteError: reportError,
		InputFileError: reportError,
		InvalidCategoriesError: reportError,
		AccountMismatchError: reportError,
	}),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
