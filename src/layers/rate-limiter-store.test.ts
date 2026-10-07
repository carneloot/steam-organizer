import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import {
	ConfigProvider,
	Deferred,
	Duration,
	Effect,
	Fiber,
	FileSystem,
	Layer,
} from 'effect';
import { RateLimiter } from 'effect/persistence';
import { TestClock } from 'effect/testing';
import { createHash } from 'node:crypto';

import { FileRateLimiterStoreLayer } from './rate-limiter-store.js';

const stateFile = (directory: string, key: string) =>
	`${directory}/${createHash('sha256').update(key).digest('hex')}.json`;
const makeStore = Effect.fn('Test.makeStore')(function* (directory: string) {
	return yield* RateLimiter.RateLimiterStore.pipe(
		Effect.provide(
			FileRateLimiterStoreLayer.pipe(
				Layer.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({ API_RATE_LIMIT_DIRECTORY: directory }),
					),
				),
			),
		),
	);
});

describe('FileRateLimiterStore', () => {
	it.effect(
		'preserves fractional tokens, rejects without consuming, and refills on interval boundaries',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const store = yield* makeStore(yield* fs.makeTempDirectoryScoped());
				const options = {
					key: 'bucket',
					limit: 2,
					refillRate: Duration.millis(500),
					allowOverflow: false,
				};
				assert.deepStrictEqual(
					yield* store.tokenBucket({ ...options, tokens: 1.5 }),
					[0.5, 0],
				);
				yield* TestClock.adjust(125);
				assert.deepStrictEqual(
					yield* store.tokenBucket({ ...options, tokens: 1 }),
					[-0.5, 125],
				);
				assert.deepStrictEqual(
					yield* store.tokenBucket({ ...options, tokens: 0.25 }),
					[0.25, 125],
				);
				yield* TestClock.adjust(375);
				assert.deepStrictEqual(
					yield* store.tokenBucket({ ...options, tokens: 0.5 }),
					[0.75, 0],
				);
				assert.deepStrictEqual(
					yield* store.tokenBucket({
						...options,
						tokens: 2,
						allowOverflow: true,
					}),
					[-1.25, 0],
				);
				yield* TestClock.adjust(500);
				assert.deepStrictEqual(
					yield* store.tokenBucket({
						...options,
						tokens: 0.25,
						allowOverflow: true,
					}),
					[-0.5, 0],
				);
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		'does not reserve rejected fixed-window tokens and resets expired counters',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const store = yield* makeStore(yield* fs.makeTempDirectoryScoped());
				const options = {
					key: 'fixed',
					tokens: 2,
					limit: 3,
					refillRate: Duration.millis(100),
				};
				assert.deepStrictEqual(yield* store.fixedWindow(options), [2, 200]);
				assert.deepStrictEqual(yield* store.fixedWindow(options), [4, 200]);
				yield* TestClock.adjust(200);
				assert.deepStrictEqual(yield* store.fixedWindow(options), [2, 200]);
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		'shares reservations and cooldowns across independent stores and restarts',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const directory = yield* fs.makeTempDirectoryScoped();
				const first = yield* makeStore(directory);
				const second = yield* makeStore(directory);
				const options = {
					key: 'shared',
					tokens: 1,
					refillRate: Duration.seconds(1),
					limit: undefined,
				};
				assert.deepStrictEqual(yield* first.fixedWindow(options), [1, 1_000]);
				assert.deepStrictEqual(yield* second.fixedWindow(options), [2, 2_000]);
				const restarted = yield* makeStore(directory);
				assert.deepStrictEqual(
					yield* restarted.fixedWindow(options),
					[3, 3_000],
				);
				yield* first.adaptiveFeedback({
					key: 'shared',
					epoch: 0,
					tokens: 1,
					status: 429,
					retryAfter: Duration.seconds(7),
				});
				yield* second.adaptiveFeedback({
					key: 'shared',
					epoch: 0,
					tokens: 1,
					status: 429,
					retryAfter: Duration.seconds(2),
				});
				const adaptive = {
					key: 'shared',
					tokens: 1,
					fallbackWindow: Duration.seconds(1),
					fallbackLimit: 1,
				};
				assert.strictEqual(
					Duration.toMillis((yield* restarted.adaptiveConsume(adaptive)).delay),
					7_000,
				);
				yield* TestClock.adjust(7_000);
				assert.strictEqual(
					Duration.toMillis((yield* first.adaptiveConsume(adaptive)).delay),
					0,
				);
				assert.strictEqual(
					Duration.toMillis((yield* second.adaptiveConsume(adaptive)).delay),
					1_000,
				);
				assert.strictEqual(
					Duration.toMillis((yield* restarted.adaptiveConsume(adaptive)).delay),
					2_000,
				);
				assert.isFalse(
					yield* fs.exists(`${stateFile(directory, 'shared')}.lock`),
				);
				assert.strictEqual(
					(yield* fs.stat(stateFile(directory, 'shared'))).mode & 0o777,
					0o600,
				);
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live('does not lose updates from competing stores', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();
			const first = yield* makeStore(directory);
			const second = yield* makeStore(directory);
			const options = {
				key: 'shared',
				tokens: 1,
				refillRate: Duration.seconds(60),
				limit: undefined,
			};
			const results = yield* Effect.all(
				[first.fixedWindow(options), second.fixedWindow(options)],
				{ concurrency: 'unbounded' },
			);
			assert.deepStrictEqual(
				results.map(([count]) => count).sort((a, b) => a - b),
				[1, 2],
			);
			assert.strictEqual(
				JSON.parse(yield* fs.readFileString(stateFile(directory, 'shared')))
					.fixed.count,
				2,
			);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect('fails closed on malformed state and releases the lock', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();
			const file = stateFile(directory, 'bad');
			yield* fs.writeFileString(file, 'not JSON');
			const store = yield* makeStore(directory);
			const error = yield* store
				.fixedWindow({
					key: 'bad',
					tokens: 1,
					refillRate: Duration.seconds(1),
					limit: undefined,
				})
				.pipe(Effect.flip);
			assert.strictEqual(error.reason._tag, 'RateLimitStoreError');
			assert.strictEqual(yield* fs.readFileString(file), 'not JSON');
			assert.isFalse(yield* fs.exists(`${file}.lock`));
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		'releases the lock and temporary file after an interrupted write',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const directory = yield* fs.makeTempDirectoryScoped();
				const started = yield* Deferred.make<void>();
				const store = yield* makeStore(directory).pipe(
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						writeFileString: () =>
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Effect.never),
							),
					}),
				);
				const fiber = yield* store
					.fixedWindow({
						key: 'interrupted',
						tokens: 1,
						refillRate: Duration.seconds(1),
						limit: undefined,
					})
					.pipe(Effect.forkScoped);
				yield* Deferred.await(started);
				yield* Fiber.interrupt(fiber);
				assert.deepStrictEqual(yield* fs.readDirectory(directory), []);
			}).pipe(Effect.provide(NodeServices.layer)),
	);
});
