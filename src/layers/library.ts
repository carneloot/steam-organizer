import { Effect, Layer, Schema } from 'effect';

import {
	type Game,
	type Library,
	OwnedGamesResponse,
	SteamGames,
} from '../domain/library.js';
import {
	LibraryService,
	ImportDecodeError,
	InvalidOwnedGamesError,
	GameNotFoundError,
} from '../services/library.js';

export const LibraryLayer = Layer.sync(LibraryService, () =>
	LibraryService.of({
		decodeImport: Effect.fn('Library.decodeImport')(function* (input) {
			const parsed = yield* Schema.decodeUnknownEffect(
				Schema.Union([SteamGames, OwnedGamesResponse]).pipe(
					Schema.fromJsonString,
				),
			)(input).pipe(
				Effect.mapError(
					() =>
						new ImportDecodeError({
							message:
								'Invalid import. Expected a Steam GetOwnedGames response or an array of games with appid, name and playtime_forever. App IDs must be unique.',
						}),
				),
			);
			if ('response' in parsed) return yield* gamesFromResponse(parsed);
			return parsed;
		}),
		gamesFromResponse,
		updateGame: Effect.fn('Library.updateGame')(function* (
			library: Library,
			appid: number,
			update: (game: Game) => Game,
		) {
			if (!library.games.some((game) => game.appid === appid)) {
				return yield* new GameNotFoundError({
					message: `No game with app ID ${appid}. Use list to find an ID.`,
				});
			}
			return {
				...library,
				games: library.games.map((game) =>
					game.appid === appid ? update(game) : game,
				),
			};
		}),
	}),
);

const gamesFromResponse = Effect.fn('Library.gamesFromResponse')(function* (
	payload: Schema.Schema.Type<typeof OwnedGamesResponse>,
) {
	const { games, game_count } = payload.response;
	if (games === undefined && game_count !== 0) {
		return yield* new InvalidOwnedGamesError({
			message:
				'Steam did not return a library. Check the Steam ID, API key and Game details privacy settings. Your saved library was not changed.',
		});
	}
	if (game_count !== undefined && game_count !== (games?.length ?? 0)) {
		return yield* new InvalidOwnedGamesError({
			message:
				'Steam returned an inconsistent game count. Your saved library was not changed.',
		});
	}
	return games ?? [];
});
