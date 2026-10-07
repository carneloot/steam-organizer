import { assert, describe, it } from '@effect/vitest';
import { ConfigProvider, Deferred, Effect, Fiber, Layer } from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import { TestClock } from 'effect/testing';

import { Steam } from '../services/steam.js';
import { LibraryLayer } from './library.js';
import { SteamLayer } from './steam.js';

const layer = SteamLayer.pipe(Layer.provide(LibraryLayer));
const fetchGameDescription = (appid: number) =>
	Effect.flatMap(Steam, (steam) => steam.fetchGameDescription(appid)).pipe(
		Effect.provide(layer),
	);
const fetchLibrary = (steamId: string) =>
	Effect.flatMap(Steam, (steam) => steam.fetchLibrary(steamId)).pipe(
		Effect.provide(layer),
	);

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({ STEAM_API_KEY: 'test-secret-never-log' }),
);
const steamId = '76561198000000000';

describe('Steam descriptions', () => {
	it.effect.each([
		{
			body: {
				620: {
					success: true,
					data: {
						detailed_description: ' Full description ',
						short_description: 'Short summary',
					},
				},
			},
			expected: 'Full description',
		},
		{
			body: {
				620: {
					success: true,
					data: {
						detailed_description: '  ',
						short_description: ' Short summary ',
					},
				},
			},
			expected: 'Short summary',
		},
		{
			body: {
				620: { success: true, data: { short_description: 'Short only' } },
			},
			expected: 'Short only',
		},
		{ body: { 620: { success: false } }, expected: null },
		{ body: { 620: { success: true } }, expected: null },
		{
			body: { 620: { success: true, data: { short_description: ' ' } } },
			expected: null,
		},
		{
			body: {
				621: { success: true, data: { detailed_description: 'Wrong game' } },
			},
			expected: null,
		},
		{
			body: { 620: { success: true, data: { detailed_description: 123 } } },
			expected: null,
		},
	])(
		'decodes descriptions or returns no description for $body',
		({ body, expected }) =>
			Effect.gen(function* () {
				const client = HttpClient.make((request, url) =>
					Effect.sync(() => {
						assert.strictEqual(url.origin, 'https://store.steampowered.com');
						assert.strictEqual(url.pathname, '/api/appdetails');
						assert.strictEqual(url.searchParams.get('appids'), '620');
						assert.strictEqual(url.searchParams.get('l'), 'english');
						assert.strictEqual(url.searchParams.has('key'), false);
						assert.strictEqual(request.headers.authorization, undefined);
						return HttpClientResponse.fromWeb(request, Response.json(body));
					}),
				);
				assert.strictEqual(
					yield* fetchGameDescription(620).pipe(
						Effect.provideService(HttpClient.HttpClient, client),
					),
					expected,
				);
			}).pipe(
				Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
			),
	);

	it.effect.each([429, 503])('returns no description on HTTP %s', (status) =>
		Effect.gen(function* () {
			const client = HttpClient.make((request) =>
				Effect.succeed(
					HttpClientResponse.fromWeb(request, Response.json({}, { status })),
				),
			);
			assert.strictEqual(
				yield* fetchGameDescription(620).pipe(
					Effect.provideService(HttpClient.HttpClient, client),
				),
				null,
			);
		}),
	);

	it.effect(
		'returns no description on transport failures and invalid JSON',
		() =>
			Effect.gen(function* () {
				const failed = HttpClient.make((request) =>
					Effect.fail(
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({
								request,
								cause: 'offline',
							}),
						}),
					),
				);
				assert.strictEqual(
					yield* fetchGameDescription(620).pipe(
						Effect.provideService(HttpClient.HttpClient, failed),
					),
					null,
				);
				const invalid = HttpClient.make((request) =>
					Effect.succeed(
						HttpClientResponse.fromWeb(request, new Response('not JSON')),
					),
				);
				assert.strictEqual(
					yield* fetchGameDescription(620).pipe(
						Effect.provideService(HttpClient.HttpClient, invalid),
					),
					null,
				);
			}),
	);

	it.effect.each([false, true])(
		'returns no description after a five-second stall, body: %s',
		(body) =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				const client = HttpClient.make((request) =>
					Effect.gen(function* () {
						yield* Deferred.succeed(started, undefined);
						if (!body) return yield* Effect.never;
						return HttpClientResponse.fromWeb(
							request,
							new Response(new ReadableStream()),
						);
					}),
				);
				const fiber = yield* fetchGameDescription(620).pipe(
					Effect.provideService(HttpClient.HttpClient, client),
					Effect.forkScoped,
				);
				yield* Deferred.await(started);
				yield* TestClock.adjust('5 seconds');
				assert.strictEqual(yield* Fiber.join(fiber), null);
			}),
	);
});

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
