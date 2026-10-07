import { Context, type Effect, Schema } from 'effect';

import type {
	Game,
	Library,
	OwnedGamesResponse,
	SteamGame,
} from '../domain/library.js';

export class ImportDecodeError extends Schema.TaggedError<ImportDecodeError>()(
	'ImportDecodeError',
	{ message: Schema.String },
) {}
export class InvalidOwnedGamesError extends Schema.TaggedError<InvalidOwnedGamesError>()(
	'InvalidOwnedGamesError',
	{ message: Schema.String },
) {}
export class GameNotFoundError extends Schema.TaggedError<GameNotFoundError>()(
	'GameNotFoundError',
	{ message: Schema.String },
) {}

export class LibraryService extends Context.Service<
	LibraryService,
	{
		readonly decodeImport: (
			input: string,
		) => Effect.Effect<
			ReadonlyArray<SteamGame>,
			ImportDecodeError | InvalidOwnedGamesError
		>;
		readonly gamesFromResponse: (
			payload: Schema.Schema.Type<typeof OwnedGamesResponse>,
		) => Effect.Effect<ReadonlyArray<SteamGame>, InvalidOwnedGamesError>;
		readonly updateGame: (
			library: Library,
			appid: number,
			update: (game: Game) => Game,
		) => Effect.Effect<Library, GameNotFoundError>;
	}
>()('steam-categorizer/Library') {}
