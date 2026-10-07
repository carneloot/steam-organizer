import { assert, describe, it } from '@effect/vitest';
import { ConfigProvider, Deferred, Effect, Fiber } from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import { TestClock } from 'effect/testing';

import { fetchLibrary } from './steam.js';

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({ STEAM_API_KEY: 'test-secret-never-log' }),
);
const steamId = '76561198000000000';

describe('Steam adapter', () => {
	it.effect('sends the documented parameters and decodes the response', () =>
		Effect.gen(function* () {
			const client = HttpClient.make((request, url) =>
				Effect.sync(() => {
					assert.strictEqual(url.origin, 'https://api.steampowered.com');
					assert.strictEqual(
						url.pathname,
						'/IPlayerService/GetOwnedGames/v0001/',
					);
					assert.strictEqual(url.searchParams.get('steamid'), steamId);
					assert.strictEqual(
						url.searchParams.get('key'),
						'test-secret-never-log',
					);
					assert.strictEqual(url.searchParams.get('include_appinfo'), '1');
					assert.strictEqual(
						url.searchParams.get('include_played_free_games'),
						'1',
					);
					return HttpClientResponse.fromWeb(
						request,
						Response.json({
							response: {
								game_count: 1,
								games: [
									{ appid: 620, name: 'Portal 2', playtime_forever: 123 },
								],
							},
						}),
					);
				}),
			);
			const games = yield* fetchLibrary(steamId).pipe(
				Effect.provideService(HttpClient.HttpClient, client),
			);
			assert.deepStrictEqual(games, [
				{ appid: 620, name: 'Portal 2', playtime_forever: 123 },
			]);
		}).pipe(Effect.provide(config)),
	);

	it.effect.each([
		{ status: 403, body: {}, expected: 'HTTP 403' },
		{
			status: 200,
			body: { response: {} },
			expected: 'Steam did not return a library',
		},
		{
			status: 200,
			body: { response: { games: [{ appid: 'bad' }] } },
			expected: 'invalid library response',
		},
	])(
		'reports safe errors for status $status and response $body',
		({ status, body, expected }) =>
			Effect.gen(function* () {
				const client = HttpClient.make((request) =>
					Effect.succeed(
						HttpClientResponse.fromWeb(
							request,
							Response.json(body, { status }),
						),
					),
				);
				const error = yield* fetchLibrary(steamId).pipe(
					Effect.provideService(HttpClient.HttpClient, client),
					Effect.flip,
				);
				assert.include(error.message, expected);
				assert.notInclude(JSON.stringify(error), 'test-secret-never-log');
			}).pipe(Effect.provide(config)),
	);

	it.effect('does not leak transport failures that contain credentials', () =>
		Effect.gen(function* () {
			let attempts = 0;
			const client = HttpClient.make((request) => {
				attempts++;
				return Effect.fail(
					new HttpClientError.HttpClientError({
						reason: new HttpClientError.TransportError({
							request,
							cause: 'test-secret-never-log',
						}),
					}),
				);
			});
			const error = yield* fetchLibrary(steamId).pipe(
				Effect.provideService(HttpClient.HttpClient, client),
				Effect.flip,
			);
			assert.strictEqual(attempts, 3);
			assert.notInclude(JSON.stringify(error), 'test-secret-never-log');
			assert.include(error.message, 'request failed');
		}).pipe(Effect.provide(config)),
	);

	it.effect('fails without a key before making a request', () =>
		Effect.gen(function* () {
			const client = HttpClient.make(() =>
				Effect.die('must not request without credentials'),
			);
			const error = yield* fetchLibrary(steamId).pipe(
				Effect.provideService(HttpClient.HttpClient, client),
				Effect.flip,
			);
			assert.include(error.message, 'Set STEAM_API_KEY');
		}).pipe(
			Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
		),
	);

	it.effect(
		'retries transient HTTP statuses before accepting a successful response',
		() =>
			Effect.gen(function* () {
				let attempts = 0;
				const client = HttpClient.make((request) => {
					attempts++;
					return Effect.succeed(
						HttpClientResponse.fromWeb(
							request,
							Response.json(
								attempts < 3 ? {} : { response: { game_count: 0 } },
								{ status: attempts < 3 ? 503 : 200 },
							),
						),
					);
				});
				const games = yield* fetchLibrary(steamId).pipe(
					Effect.provideService(HttpClient.HttpClient, client),
				);
				assert.deepStrictEqual(games, []);
				assert.strictEqual(attempts, 3);
			}).pipe(Effect.provide(config)),
	);

	it.effect('applies the deadline to a stalled response body too', () =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			const client = HttpClient.make((request) =>
				Effect.gen(function* () {
					yield* Deferred.succeed(started, undefined);
					return HttpClientResponse.fromWeb(
						request,
						new Response(new ReadableStream()),
					);
				}),
			);
			const fiber = yield* fetchLibrary(steamId).pipe(
				Effect.provideService(HttpClient.HttpClient, client),
				Effect.flip,
				Effect.forkScoped,
			);
			yield* Deferred.await(started);
			yield* TestClock.adjust('30 seconds');
			assert.include((yield* Fiber.join(fiber)).message, 'timed out');
		}).pipe(Effect.provide(config)),
	);

	it.effect('interrupts a stuck request after 30 seconds', () =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			const client = HttpClient.make(() =>
				Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
			);
			const fiber = yield* fetchLibrary(steamId).pipe(
				Effect.provideService(HttpClient.HttpClient, client),
				Effect.flip,
				Effect.forkScoped,
			);
			yield* Deferred.await(started);
			yield* TestClock.adjust('30 seconds');
			assert.include((yield* Fiber.join(fiber)).message, 'timed out');
		}).pipe(Effect.provide(config)),
	);
});
