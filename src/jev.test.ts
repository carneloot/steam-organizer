import { assert, describe, it } from '@effect/vitest';
import { ConfigProvider, Deferred, Effect, Fiber, Predicate } from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import { TestClock } from 'effect/testing';

import { classifyGame } from './jev.js';

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: 'jev-test-secret' }),
);
const game = {
	appid: 620,
	name: 'Portal 2',
	playtime_forever: 123,
	tags: ['Favorites'],
	reviewed: false,
};
const answers = {
	Action: { type: 'noul', noul: 0.799 },
	Adventure: { type: 'noul', noul: 0 },
	RPG: { type: 'noul', noul: 0.2 },
	Strategy: { type: 'noul', noul: 0.1 },
	Simulation: { type: 'noul', noul: 0.1 },
	Puzzle: { type: 'noul', noul: 0.8 },
	Platformer: { type: 'noul', noul: 0.79 },
	Racing: { type: 'noul', noul: 0 },
	Sports: { type: 'noul', noul: 0 },
	Horror: { type: 'noul', noul: 0 },
	Roguelike: { type: 'noul', noul: 0 },
	'Co-op': { type: 'noul', noul: 1 },
};

describe('Jev adapter', () => {
	it.effect(
		'sends typed multi-label questions and applies the probability boundary',
		() =>
			Effect.gen(function* () {
				const client = HttpClient.make((request, url) =>
					Effect.sync(() => {
						assert.strictEqual(
							url.href,
							'https://api.typesafe.ai/v1/systemone',
						);
						assert.strictEqual(request.method, 'POST');
						assert.strictEqual(
							request.headers.authorization,
							'Bearer jev-test-secret',
						);
						assert.strictEqual(
							request.headers['content-type'],
							'application/json',
						);
						if (!Predicate.isTagged(request.body, 'Uint8Array'))
							throw new Error('Expected JSON body');
						const payload = JSON.parse(
							new TextDecoder().decode(request.body.body),
						);
						assert.strictEqual(payload.model, 'jev-latest');
						assert.deepStrictEqual(payload.state, {
							appid: 620,
							name: 'Portal 2',
						});
						assert.deepStrictEqual(
							Object.keys(payload.questions).sort(),
							Object.keys(answers).sort(),
						);
						assert.strictEqual(payload.questions.Puzzle.type, 'noul');
						assert.include(payload.questions.Puzzle.criteria.true, 'puzzles');
						return HttpClientResponse.fromWeb(
							request,
							Response.json({ answers }),
						);
					}),
				);
				assert.deepStrictEqual(
					yield* classifyGame(game).pipe(
						Effect.provideService(HttpClient.HttpClient, client),
					),
					['Puzzle', 'Co-op'],
				);
			}).pipe(Effect.provide(config)),
	);

	it.effect.each([
		{ status: 401, body: { secret: 'jev-test-secret' }, expected: 'HTTP 401' },
		{ status: 429, body: {}, expected: 'HTTP 429' },
		{ status: 529, body: {}, expected: 'HTTP 529' },
		{ status: 200, body: { answers: {} }, expected: 'omitted' },
		{
			status: 200,
			body: { answers: { ...answers, Puzzle: { type: 'noul', noul: 1.1 } } },
			expected: 'invalid',
		},
		{
			status: 200,
			body: { answers: { ...answers, Puzzle: { type: 'noul', noul: -0.1 } } },
			expected: 'invalid',
		},
		{
			status: 200,
			body: {
				answers: { ...answers, Puzzle: { type: 'choice', choice: 'Puzzle' } },
			},
			expected: 'invalid',
		},
	])(
		'rejects status $status or malformed answers without leaking secrets',
		({ status, body, expected }) =>
			Effect.gen(function* () {
				let calls = 0;
				const client = HttpClient.make((request) => {
					calls++;
					return Effect.succeed(
						HttpClientResponse.fromWeb(
							request,
							Response.json(body, { status }),
						),
					);
				});
				const error = yield* classifyGame(game).pipe(
					Effect.provideService(HttpClient.HttpClient, client),
					Effect.flip,
				);
				assert.include(error.message, expected);
				assert.notInclude(JSON.stringify(error), 'jev-test-secret');
				assert.strictEqual(calls, 1);
			}).pipe(Effect.provide(config)),
	);

	it.effect.each([{}, { TYPESAFE_API_KEY: '   ' }])(
		'rejects missing or blank keys before requesting',
		(values) =>
			Effect.gen(function* () {
				const client = HttpClient.make(() => Effect.die('must not request'));
				const error = yield* classifyGame(game).pipe(
					Effect.provideService(HttpClient.HttpClient, client),
					Effect.flip,
				);
				assert.include(error.message, 'TYPESAFE_API_KEY');
			}).pipe(
				Effect.provide(
					ConfigProvider.layer(ConfigProvider.fromUnknown(values)),
				),
			),
	);

	it.effect(
		'sanitizes transport failures and does not retry potentially billed requests',
		() =>
			Effect.gen(function* () {
				let calls = 0;
				const client = HttpClient.make((request) => {
					calls++;
					return Effect.fail(
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({
								request,
								cause: 'jev-test-secret',
							}),
						}),
					);
				});
				const error = yield* classifyGame(game).pipe(
					Effect.provideService(HttpClient.HttpClient, client),
					Effect.flip,
				);
				assert.include(error.message, 'request failed');
				assert.notInclude(JSON.stringify(error), 'jev-test-secret');
				assert.strictEqual(calls, 1);
			}).pipe(Effect.provide(config)),
	);

	it.effect.each([false, true])(
		'times out a stalled request or body, stalled body: %s',
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
				const fiber = yield* classifyGame(game).pipe(
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
