import {
	Config,
	DateTime,
	Duration,
	Effect,
	FileSystem,
	Layer,
	Path,
	Predicate,
	Schedule,
	Schema,
} from 'effect';
import { RateLimiter } from 'effect/persistence';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

import { ConfigurationError } from '../services/app-config.js';

const State = Schema.Struct({
	fixed: Schema.optionalKey(
		Schema.Struct({ count: Schema.Finite, expiresAt: Schema.Finite }),
	),
	bucket: Schema.optionalKey(
		Schema.Struct({ tokens: Schema.Finite, lastRefill: Schema.Finite }),
	),
	cooldownUntil: Schema.optionalKey(Schema.Finite),
	adaptiveNext: Schema.optionalKey(Schema.Finite),
});

export const FileRateLimiterStoreLayer = Layer.effect(
	RateLimiter.RateLimiterStore,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const directory = yield* Config.String('API_RATE_LIMIT_DIRECTORY').pipe(
			Config.withDefault(
				path.join(homedir(), '.cache', 'steam-categorizer', 'rate-limits'),
			),
			Effect.mapError(
				() =>
					new ConfigurationError({
						message: 'Cannot load API_RATE_LIMIT_DIRECTORY.',
					}),
			),
		);
		const modify = Effect.fn('RateLimiterStore.modify')(
			function* <A>(
				key: string,
				update: (state: typeof State.Type, now: number) => A,
			) {
				const file = path.join(
					directory,
					`${createHash('sha256').update(key).digest('hex')}.json`,
				);
				const lock = `${file}.lock`;
				yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
				yield* Effect.acquireRelease(
					fs.makeDirectory(lock).pipe(
						Effect.retry({
							schedule: Schedule.spaced('50 millis'),
							while: (error) =>
								Predicate.isTagged(error.reason, 'AlreadyExists'),
						}),
					),
					() => fs.remove(lock, { recursive: true }).pipe(Effect.orDie),
				);
				const text = yield* fs
					.readFileString(file)
					.pipe(
						Effect.catchReason('PlatformError', 'NotFound', () =>
							Effect.succeed(null),
						),
					);
				const state =
					text === null
						? {}
						: yield* Schema.decodeEffect(State.pipe(Schema.fromJsonString))(
								text,
							);
				const result = update(
					state,
					DateTime.toEpochMillis(yield* DateTime.now),
				);
				const temporary = yield* fs.makeTempFileScoped({
					directory,
					prefix: '.rate-limit-',
				});
				yield* fs.chmod(temporary, 0o600);
				yield* fs.writeFileString(temporary, JSON.stringify(state));
				yield* fs.rename(temporary, file);
				return result;
			},
			Effect.scoped,
			Effect.mapError(
				() =>
					new RateLimiter.RateLimiterError({
						reason: new RateLimiter.RateLimitStoreError({
							message: `Cannot update API rate-limit store ${directory}. Check permissions and state files. Remove stale .lock directories only when no CLI process is running.`,
						}),
					}),
			),
		);

		return RateLimiter.RateLimiterStore.of({
			fixedWindow: (options) =>
				modify(options.key, (state, now) => {
					const counter =
						state.fixed === undefined || state.fixed.expiresAt <= now
							? { count: 0, expiresAt: now }
							: { ...state.fixed };
					const count = counter.count + options.tokens;
					if (options.limit !== undefined && count > options.limit)
						return [count, counter.expiresAt - now] as const;
					counter.count = count;
					counter.expiresAt +=
						Duration.toMillis(options.refillRate) * options.tokens;
					Object.assign(state, { fixed: counter });
					return [count, counter.expiresAt - now] as const;
				}),
			tokenBucket: (options) =>
				modify(options.key, (state, now) => {
					const refill = Duration.toMillis(options.refillRate);
					const bucket =
						state.bucket === undefined
							? { tokens: options.limit, lastRefill: now }
							: { ...state.bucket };
					const added = Math.floor((now - bucket.lastRefill) / refill);
					if (added > 0) {
						bucket.tokens = Math.min(options.limit, bucket.tokens + added);
						bucket.lastRefill += added * refill;
					}
					if (bucket.tokens >= options.limit) bucket.lastRefill = now;
					const remaining = bucket.tokens - options.tokens;
					if (options.allowOverflow || remaining >= 0)
						bucket.tokens = remaining;
					Object.assign(state, { bucket });
					return [remaining, Math.max(0, now - bucket.lastRefill)] as const;
				}),
			// Retain server cooldowns without increasing the conservative baseline through learning.
			adaptiveConsume: (options) =>
				modify(options.key, (state, now): RateLimiter.AdaptiveConsumeResult => {
					if (state.cooldownUntil === undefined)
						return { delay: Duration.zero, epoch: 0, phase: 'inactive' };
					if (state.cooldownUntil > now)
						return {
							delay: Duration.millis(state.cooldownUntil - now),
							epoch: 0,
							phase: 'cooldown',
						};
					// Stagger waiters after cooldown rather than releasing them all at once.
					const next = Math.max(now, state.adaptiveNext ?? 0);
					Object.assign(state, {
						adaptiveNext:
							next +
							(Duration.toMillis(options.fallbackWindow) * options.tokens) /
								options.fallbackLimit,
					});
					return {
						delay: Duration.millis(next - now),
						epoch: 0,
						phase: 'learned',
					};
				}),
			adaptiveFeedback: (options) =>
				options.status !== 429 || options.retryAfter === undefined
					? Effect.void
					: modify(options.key, (state, now) => {
							Object.assign(state, {
								cooldownUntil: Math.max(
									state.cooldownUntil ?? 0,
									now + Duration.toMillis(options.retryAfter ?? Duration.zero),
								),
							});
						}),
		});
	}),
);
