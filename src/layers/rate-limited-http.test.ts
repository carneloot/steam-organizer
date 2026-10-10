import { assert, describe, it } from '@effect/vitest';
import {
	DateTime,
	Duration,
	Effect,
	Fiber,
	Layer,
	Predicate,
	Queue,
	Redacted,
} from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { RateLimiter } from 'effect/persistence';
import { TestClock } from 'effect/testing';

import { AppConfig } from '../services/app-config.js';
import { Classifier } from '../services/classifier.js';
import { Steam } from '../services/steam.js';
import { JevLayer, JevWorkflowLayer } from './jev.js';
import { LibraryLayer } from './library.js';
import { SteamLayer } from './steam.js';

const limiterLayer = RateLimiter.layer.pipe(
	Layer.provide(RateLimiter.layerStoreMemory),
);
const apiLayer = (durablePacing: boolean) =>
	Layer.mergeAll(SteamLayer, durablePacing ? JevWorkflowLayer : JevLayer).pipe(
		Layer.provide(LibraryLayer),
		Layer.provide(
			Layer.succeed(AppConfig, {
				steamApiKey: Redacted.make('steam-test-key'),
				jevApiKey: Redacted.make('jev-test-key'),
			}),
		),
	);
const makeApis = Effect.fn('Test.makeApis')(function* (
	transport: HttpClient.HttpClient,
	durablePacing = false,
) {
	return yield* Effect.gen(function* () {
		const steam = yield* Steam;
		const classifier = yield* Classifier;
		return {
			web: steam.fetchLibrary('76561198000000000').pipe(Effect.asVoid),
			store: steam.fetchGameDescription(620).pipe(Effect.asVoid),
			jev: classifier
				.classifyGame(
					{ appid: 620, name: 'Portal 2', description: null },
					{ Puzzle: 'Solving puzzles' },
				)
				.pipe(Effect.asVoid),
		};
	}).pipe(
		Effect.provide(apiLayer(durablePacing)),
		Effect.provideService(HttpClient.HttpClient, transport),
	);
});
const bodies: Readonly<Record<string, unknown>> = {
	'api.steampowered.com': { response: { game_count: 0 } },
	'store.steampowered.com': {
		620: { success: true, data: { short_description: 'Spatial puzzles' } },
	},
	'api.typesafe.ai': { answers: { Puzzle: { type: 'noul', noul: 0.9 } } },
};

describe('API HTTP rate limiting', () => {
	it.effect('paces every Steam sync retry through the limiter', () =>
		Effect.gen(function* () {
			const sent = yield* Queue.unbounded<number>();
			let calls = 0;
			const apis = yield* makeApis(
				HttpClient.make((request) =>
					Effect.gen(function* () {
						calls++;
						yield* Queue.offer(
							sent,
							DateTime.toEpochMillis(yield* DateTime.now),
						);
						return HttpClientResponse.fromWeb(
							request,
							Response.json(bodies['api.steampowered.com'], {
								status: calls < 3 ? 503 : 200,
							}),
						);
					}),
				),
			);
			const running = yield* apis.web.pipe(Effect.forkScoped);
			assert.strictEqual(yield* Queue.take(sent), 0);
			for (const expected of [1_000, 2_000]) {
				yield* TestClock.adjust(999);
				assert.isUndefined(running.pollUnsafe());
				assert.strictEqual(calls, expected / 1_000);
				yield* TestClock.adjust(1);
				assert.strictEqual(yield* Queue.take(sent), expected);
			}
			yield* Fiber.join(running);
			assert.strictEqual(calls, 3);
		}).pipe(Effect.provide(limiterLayer)),
	);

	it.effect.each([
		{ host: 'api.steampowered.com', api: 'web', spacing: 1_000 },
		{ host: 'store.steampowered.com', api: 'store', spacing: 2_000 },
		{ host: 'api.typesafe.ai', api: 'jev', spacing: 1_000 },
	] as const)(
		'paces $host requests at the adapter boundary',
		({ host, api, spacing }) =>
			Effect.gen(function* () {
				const sent = yield* Queue.unbounded<number>();
				const apis = yield* makeApis(
					HttpClient.make((request, url) =>
						Effect.gen(function* () {
							assert.strictEqual(url.hostname, host);
							yield* Queue.offer(
								sent,
								DateTime.toEpochMillis(yield* DateTime.now),
							);
							return HttpClientResponse.fromWeb(
								request,
								Response.json(bodies[host]),
							);
						}),
					),
				);
				yield* apis[api];
				assert.strictEqual(yield* Queue.take(sent), 0);
				const waiting = yield* apis[api].pipe(Effect.forkScoped);
				yield* TestClock.adjust(spacing - 1);
				assert.isUndefined(waiting.pollUnsafe());
				yield* TestClock.adjust(1);
				assert.strictEqual(yield* Queue.take(sent), spacing);
				yield* Fiber.join(waiting);
			}).pipe(Effect.provide(limiterLayer)),
	);

	it.effect.each([
		{ host: 'api.typesafe.ai', api: 'jev', header: '7', expected: 7_000 },
		{
			host: 'api.typesafe.ai',
			api: 'jev',
			header: 'Thu, 01 Jan 1970 00:00:11 GMT',
			expected: 11_000,
		},
		{
			host: 'api.typesafe.ai',
			api: 'jev',
			header: 'invalid',
			expected: 60_000,
		},
		{
			host: 'store.steampowered.com',
			api: 'store',
			header: undefined,
			expected: 300_000,
		},
		{
			host: 'api.steampowered.com',
			api: 'web',
			header: undefined,
			expected: 60_000,
		},
	] as const)(
		'records $host cooldown $header before the next attempt',
		({ host, api, header, expected }) =>
			Effect.gen(function* () {
				let calls = 0;
				const sent = yield* Queue.unbounded<void>();
				const apis = yield* makeApis(
					HttpClient.make((request) =>
						Effect.gen(function* () {
							calls++;
							yield* Queue.offer(sent, undefined);
							return HttpClientResponse.fromWeb(
								request,
								Response.json(bodies[host], {
									status: 429,
									headers:
										header === undefined ? {} : { 'Retry-After': header },
								}),
							);
						}),
					),
				);
				const first = yield* Effect.exit(apis[api]).pipe(Effect.forkScoped);
				yield* Queue.take(sent);
				yield* TestClock.adjust(0);
				assert.strictEqual(calls, 1);
				const limiter = yield* RateLimiter.RateLimiter;
				assert.strictEqual(
					Duration.toMillis(
						(yield* limiter.adaptiveConsume({
							key: host,
							tokens: 1,
							fallbackLimit: 1,
							fallbackWindow: Duration.seconds(1),
						})).delay,
					),
					expected,
				);
				yield* Fiber.interrupt(first);
			}).pipe(Effect.provide(limiterLayer)),
	);

	it.effect(
		'waits for a Jev cooldown without retrying the failed classification',
		() =>
			Effect.gen(function* () {
				let calls = 0;
				const apis = yield* makeApis(
					HttpClient.make((request) =>
						Effect.sync(() => {
							calls++;
							return HttpClientResponse.fromWeb(
								request,
								Response.json(bodies['api.typesafe.ai'], {
									status: calls === 1 ? 429 : 200,
									headers: { 'Retry-After': '7' },
								}),
							);
						}),
					),
				);
				const failure = yield* apis.jev.pipe(Effect.flip);
				assert.strictEqual(failure._tag, 'ClassificationRequestError');
				assert.strictEqual(calls, 1);
				const waiting = yield* apis.jev.pipe(Effect.forkScoped);
				yield* TestClock.adjust(6_999);
				assert.strictEqual(calls, 1);
				assert.isUndefined(waiting.pollUnsafe());
				yield* TestClock.adjust(1);
				yield* Fiber.join(waiting);
				assert.strictEqual(calls, 2);
			}).pipe(Effect.provide(limiterLayer)),
	);

	it.effect(
		'defers web requests immediately through a cooldown longer than the HTTP timeout',
		() =>
			Effect.gen(function* () {
				let calls = 0;
				const apis = yield* makeApis(
					HttpClient.make((request) =>
						Effect.sync(() => {
							calls++;
							return HttpClientResponse.fromWeb(
								request,
								Response.json(bodies['api.typesafe.ai'], {
									status: calls === 1 ? 429 : 200,
									headers: {
										'Retry-After': '75',
										'x-request-id': 'long-cooldown',
									},
								}),
							);
						}),
					),
					true,
				);
				const rejected = yield* apis.jev.pipe(Effect.flip);
				assert.strictEqual(rejected._tag, 'ClassificationRequestError');
				if (Predicate.isTagged(rejected, 'ClassificationRequestError')) {
					assert.strictEqual(rejected.status, 429);
					assert.strictEqual(rejected.retryAfterMs, 75_000);
					assert.strictEqual(rejected.requestId, 'long-cooldown');
				}
				const deferred = yield* apis.jev.pipe(Effect.flip);
				assert.strictEqual(deferred._tag, 'ClassificationDeferred');
				if (Predicate.isTagged(deferred, 'ClassificationDeferred'))
					assert.strictEqual(deferred.retryAfterMs, 75_000);
				assert.strictEqual(calls, 1);
				yield* TestClock.adjust(74_999);
				const stillDeferred = yield* apis.jev.pipe(Effect.flip);
				assert.strictEqual(stillDeferred._tag, 'ClassificationDeferred');
				assert.strictEqual(calls, 1);
				yield* TestClock.adjust(1);
				yield* apis.jev;
				assert.strictEqual(calls, 2);
				const paced = yield* apis.jev.pipe(Effect.flip);
				assert.strictEqual(paced._tag, 'ClassificationDeferred');
				assert.strictEqual(calls, 2);
			}).pipe(Effect.provide(limiterLayer)),
	);

	it.effect('keeps API budgets independent', () =>
		Effect.gen(function* () {
			const apis = yield* makeApis(
				HttpClient.make((request, url) =>
					Effect.succeed(
						HttpClientResponse.fromWeb(
							request,
							Response.json(bodies[url.hostname]),
						),
					),
				),
			);
			yield* apis.web;
			yield* apis.store;
			yield* apis.jev;
			assert.strictEqual(DateTime.toEpochMillis(yield* DateTime.now), 0);
		}).pipe(Effect.provide(limiterLayer)),
	);
});
