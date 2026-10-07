import { Effect, Layer, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { RateLimiter } from 'effect/persistence';

import { OwnedGamesResponse } from '../domain/library.js';
import { AppConfig, ConfigurationError } from '../services/app-config.js';
import { LibraryService } from '../services/library.js';
import {
	Steam,
	SteamRequestError,
	SteamResponseError,
	SteamTimeoutError,
} from '../services/steam.js';
import { rateLimitFeedback } from './rate-limit-feedback.js';

const AppDetailsResponse = Schema.Record(
	Schema.String,
	Schema.Struct({
		success: Schema.Boolean,
		data: Schema.optionalKey(
			Schema.Struct({
				detailed_description: Schema.optionalKey(Schema.String),
				short_description: Schema.optionalKey(Schema.String),
			}),
		),
	}),
);

export const SteamLayer = Layer.effect(
	Steam,
	Effect.gen(function* () {
		const http = yield* HttpClient.HttpClient;
		const library = yield* LibraryService;
		const config = yield* AppConfig;
		const limiter = yield* RateLimiter.RateLimiter;
		const storeClient = http.pipe(
			HttpClient.transformResponse(
				Effect.tap(
					rateLimitFeedback(limiter, 'store.steampowered.com', 300_000),
				),
			),
			HttpClient.withRateLimiter({
				limiter,
				key: 'store.steampowered.com',
				limit: 1,
				window: '2 seconds',
				times: 0,
			}),
		);
		const libraryClient = http.pipe(
			HttpClient.transformResponse(
				Effect.tap(rateLimitFeedback(limiter, 'api.steampowered.com', 60_000)),
			),
			HttpClient.withRateLimiter({
				limiter,
				key: 'api.steampowered.com',
				limit: 1,
				window: '1 second',
				times: 0,
			}),
			HttpClient.retryTransient({ times: 2 }),
		);
		const fetchGameDescription = Effect.fn('Steam.fetchGameDescription')(
			function* (appid: number) {
				const response = yield* storeClient.get(
					'https://store.steampowered.com/api/appdetails',
					{
						urlParams: { appids: String(appid), l: 'english' },
					},
				);
				if (response.status < 200 || response.status >= 300) return null;
				const payload =
					yield* HttpClientResponse.schemaBodyJson(AppDetailsResponse)(
						response,
					);
				const details = payload[String(appid)];
				if (!details?.success) return null;
				return (
					details.data?.detailed_description?.trim() ||
					details.data?.short_description?.trim() ||
					null
				);
			},
			Effect.timeout('5 seconds'),
			Effect.orElseSucceed(() => null),
		);

		const key = config.steamApiKey;
		const fetchLibrary =
			key === null
				? Effect.fn('Steam.fetchLibrary')(() =>
						Effect.fail(
							new ConfigurationError({
								message:
									'Set STEAM_API_KEY to your Steam Web API key before using sync.',
							}),
						),
					)
				: Effect.fn('Steam.fetchLibrary')(
						function* (steamId: string) {
							const response = yield* libraryClient
								.get(
									'https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/',
									{
										urlParams: {
											key: Redacted.value(key),
											steamid: steamId,
											include_appinfo: '1',
											include_played_free_games: '1',
											format: 'json',
										},
									},
								)
								.pipe(
									Effect.mapError(
										() =>
											new SteamRequestError({
												message:
													'Steam request failed. Check your network and try again.',
											}),
									),
								);
							if (response.status < 200 || response.status >= 300) {
								return yield* new SteamRequestError({
									message: `Steam returned HTTP ${response.status}. Check your API key and try again.`,
								});
							}
							const payload = yield* HttpClientResponse.schemaBodyJson(
								OwnedGamesResponse,
							)(response).pipe(
								Effect.mapError(
									() =>
										new SteamResponseError({
											message:
												'Steam returned an invalid library response. Nothing was saved.',
										}),
								),
							);
							return yield* library.gamesFromResponse(payload);
						},
						Effect.timeoutOrElse({
							duration: '30 seconds',
							orElse: () =>
								Effect.fail(
									new SteamTimeoutError({
										message:
											'Steam request timed out. Nothing was saved. Try again.',
									}),
								),
						}),
					);
		return Steam.of({ fetchGameDescription, fetchLibrary });
	}),
);
