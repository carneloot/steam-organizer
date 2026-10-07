import { Context, type Effect, type Schema } from 'effect';

import type {
	AppError,
	Game,
	Library,
	OwnedGamesResponse,
	SteamGame,
} from '../domain/library.js';

export class LibraryService extends Context.Service<
	LibraryService,
	{
		readonly decodeImport: (
			input: string,
		) => Effect.Effect<ReadonlyArray<SteamGame>, AppError>;
		readonly gamesFromResponse: (
			payload: Schema.Schema.Type<typeof OwnedGamesResponse>,
		) => Effect.Effect<ReadonlyArray<SteamGame>, AppError>;
		readonly updateGame: (
			library: Library,
			appid: number,
			update: (game: Game) => Game,
		) => Effect.Effect<Library, AppError>;
	}
>()('steam-categorizer/Library') {}
