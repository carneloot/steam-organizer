import { assert, describe, it } from '@effect/vitest';
import {
	ConfigProvider,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Predicate,
	Redacted,
	Schema,
} from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import { TestClock } from 'effect/testing';

import {
	CategoryCriteria,
	type ClassificationGame,
} from '../domain/classification.js';
import { AppConfig } from '../services/app-config.js';
import { Classifier } from '../services/classifier.js';
import { AppConfigLayer } from './app-config.js';
import { JevLayer } from './jev.js';

const classifyGame = (game: ClassificationGame, criteria?: CategoryCriteria) =>
	Effect.flatMap(Classifier, (classifier) =>
		classifier.classifyGame(game, criteria),
	).pipe(Effect.provide(JevLayer), Effect.provide(AppConfigLayer));

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: 'jev-test-secret' }),
);
const game = {
	appid: 620,
	name: 'Portal 2',
	description: null,
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
	it.effect.each([false, true])(
		'uses only supplied category criteria, missing answer: %s',
		(missing) =>
			Effect.gen(function* () {
				const criteria = yield* Schema.decodeUnknownEffect(CategoryCriteria)({
					'Cozy farming': 'Includes farming and low-pressure play.',
					Competitive: 'Players compete against each other.',
				});
				const client = HttpClient.make((request) =>
					Effect.sync(() => {
						assert.strictEqual(request.method, 'POST');
						if (!Predicate.isTagged(request.body, 'Uint8Array'))
							throw new Error('Expected JSON body');
						const payload = JSON.parse(
							new TextDecoder().decode(request.body.body),
						);
						assert.deepStrictEqual(Object.keys(payload.questions), [
							'Cozy farming',
							'Competitive',
						]);
						assert.strictEqual(
							payload.questions['Cozy farming'].criteria.true,
							'Includes farming and low-pressure play.',
						);
						assert.strictEqual(
							payload.questions.Competitive.criteria.true,
							'Players compete against each other.',
						);
						return HttpClientResponse.fromWeb(
							request,
							Response.json({
								answers: {
									'Cozy farming': { type: 'noul', noul: 0.8 },
									...(missing
										? {}
										: { Competitive: { type: 'noul', noul: 0.799 } }),
									Favorites: { type: 'noul', noul: 1 },
								},
							}),
						);
					}),
				);
				const result = classifyGame(game, criteria).pipe(
					Effect.provideService(HttpClient.HttpClient, client),
				);
				if (missing)
					assert.include((yield* result.pipe(Effect.flip)).message, 'omitted');
				else assert.deepStrictEqual(yield* result, ['Cozy farming']);
			}).pipe(Effect.provide(config)),
	);

	it.effect.each([
		'Cooperative spatial puzzles in a dedicated campaign.',
		null,
	])(
		'sends the supplied description without looking it up: %s',
		(description) =>
			Effect.gen(function* () {
				let calls = 0;
				const client = HttpClient.make((request, url) =>
					Effect.sync(() => {
						calls++;
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
							...(description === null ? {} : { description }),
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
					yield* classifyGame({ ...game, description }).pipe(
						Effect.provideService(HttpClient.HttpClient, client),
					),
					['Puzzle', 'Co-op'],
				);
				assert.strictEqual(calls, 1);
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
				assert.strictEqual(
					error._tag,
					status === 200
						? 'ClassificationResponseError'
						: 'ClassificationRequestError',
				);
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
				assert.strictEqual(error._tag, 'ConfigurationError');
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
				assert.strictEqual(error._tag, 'ClassificationRequestError');
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
				const error = yield* Fiber.join(fiber);
				assert.include(error.message, 'timed out');
				assert.strictEqual(error._tag, 'ClassificationTimeoutError');
			}).pipe(Effect.provide(config)),
	);

	it.effect('uses the injected app config instead of environment config', () =>
		Effect.gen(function* () {
			const client = HttpClient.make((request) =>
				Effect.sync(() => {
					assert.strictEqual(
						request.headers.authorization,
						'Bearer injected-key',
					);
					return HttpClientResponse.fromWeb(
						request,
						Response.json({ answers }),
					);
				}),
			);
			const tags = yield* Effect.flatMap(Classifier, (classifier) =>
				classifier.classifyGame(game),
			).pipe(
				Effect.provide(JevLayer),
				Effect.provide(
					Layer.succeed(
						AppConfig,
						AppConfig.of({
							jevApiKey: Redacted.make('injected-key'),
							steamApiKey: null,
						}),
					),
				),
				Effect.provideService(HttpClient.HttpClient, client),
				Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
			);
			assert.deepStrictEqual(tags, ['Puzzle', 'Co-op']);
		}),
	);
});
