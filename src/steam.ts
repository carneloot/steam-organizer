import { Config, Effect, Redacted } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';

import { AppError, gamesFromResponse, OwnedGamesResponse } from './library.js';

export const fetchLibrary = Effect.fn('Steam.fetchLibrary')(
	function* (steamId: string) {
		const key = yield* Config.Redacted('STEAM_API_KEY').pipe(
			Effect.mapError(
				() =>
					new AppError({
						message:
							'Set STEAM_API_KEY to your Steam Web API key before using sync.',
					}),
			),
		);
		if (Redacted.value(key).trim() === '') {
			return yield* new AppError({
				message: 'STEAM_API_KEY must not be empty.',
			});
		}
		const client = (yield* HttpClient.HttpClient).pipe(
			HttpClient.retryTransient({ times: 2 }),
		);
		const response = yield* client
			.get('https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/', {
				urlParams: {
					key: Redacted.value(key),
					steamid: steamId,
					include_appinfo: '1',
					include_played_free_games: '1',
					format: 'json',
				},
			})
			.pipe(
				Effect.mapError(
					() =>
						new AppError({
							message:
								'Steam request failed. Check your network and try again.',
						}),
				),
			);
		if (response.status < 200 || response.status >= 300) {
			return yield* new AppError({
				message: `Steam returned HTTP ${response.status}. Check your API key and try again.`,
			});
		}
		const payload = yield* HttpClientResponse.schemaBodyJson(
			OwnedGamesResponse,
		)(response).pipe(
			Effect.mapError(
				() =>
					new AppError({
						message:
							'Steam returned an invalid library response. Nothing was saved.',
					}),
			),
		);
		return yield* gamesFromResponse(payload);
	},
	Effect.timeout('30 seconds'),
	Effect.catchTag('TimeoutError', () =>
		Effect.fail(
			new AppError({
				message: 'Steam request timed out. Nothing was saved. Try again.',
			}),
		),
	),
);
