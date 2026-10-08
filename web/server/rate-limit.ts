import { Duration, Effect, Layer, Schema } from 'effect';
import { RateLimiter } from 'effect/persistence';

export interface LimitState {
	fixed?: { count: number; expiresAt: number };
	bucket?: { tokens: number; lastRefill: number };
	cooldownUntil?: number;
	adaptiveNext?: number;
}
export const LimitInputSchema = Schema.Struct({
	method: Schema.String,
	key: Schema.String,
	tokens: Schema.optionalKey(Schema.Finite),
	limit: Schema.optionalKey(Schema.UndefinedOr(Schema.Finite)),
	refillRate: Schema.optionalKey(Schema.Finite),
	allowOverflow: Schema.optionalKey(Schema.Boolean),
	fallbackWindow: Schema.optionalKey(Schema.Finite),
	fallbackLimit: Schema.optionalKey(Schema.Finite),
	status: Schema.optionalKey(Schema.Finite),
	retryAfter: Schema.optionalKey(Schema.Finite),
});
export type LimitInput = typeof LimitInputSchema.Type;
export const LimitStateSchema = Schema.Struct({
	fixed: Schema.optionalKey(
		Schema.Struct({ count: Schema.Finite, expiresAt: Schema.Finite }),
	),
	bucket: Schema.optionalKey(
		Schema.Struct({ tokens: Schema.Finite, lastRefill: Schema.Finite }),
	),
	cooldownUntil: Schema.optionalKey(Schema.Finite),
	adaptiveNext: Schema.optionalKey(Schema.Finite),
});
const Pair = Schema.Tuple([Schema.Finite, Schema.Finite]);
const Adaptive = Schema.Struct({
	delay: Schema.Finite,
	epoch: Schema.Finite,
	phase: Schema.Literals(['inactive', 'cooldown', 'learned']),
});
export function updateLimit(
	state: LimitState,
	input: LimitInput,
	now: number,
): unknown {
	if (input.method === 'fixedWindow') {
		const window =
			!state.fixed || state.fixed.expiresAt <= now
				? { count: 0, expiresAt: now }
				: { ...state.fixed };
		const count = window.count + (input.tokens ?? 1);
		if (input.limit !== undefined && count > input.limit)
			return [count, window.expiresAt - now];
		window.count = count;
		window.expiresAt += (input.refillRate ?? 0) * (input.tokens ?? 1);
		state.fixed = window;
		return [count, window.expiresAt - now];
	}
	if (input.method === 'tokenBucket') {
		const limit = input.limit ?? 1,
			refill = input.refillRate ?? 1;
		const bucket = state.bucket
			? { ...state.bucket }
			: { tokens: limit, lastRefill: now };
		const added = Math.floor((now - bucket.lastRefill) / refill);
		if (added > 0) {
			bucket.tokens = Math.min(limit, bucket.tokens + added);
			bucket.lastRefill += added * refill;
		}
		if (bucket.tokens >= limit) bucket.lastRefill = now;
		const remaining = bucket.tokens - (input.tokens ?? 1);
		if (input.allowOverflow || remaining >= 0) bucket.tokens = remaining;
		state.bucket = bucket;
		return [remaining, Math.max(0, now - bucket.lastRefill)];
	}
	if (input.method === 'adaptiveFeedback') {
		if (input.status === 429 && input.retryAfter !== undefined)
			state.cooldownUntil = Math.max(
				state.cooldownUntil ?? 0,
				now + input.retryAfter,
			);
		return null;
	}
	if (state.cooldownUntil === undefined)
		return { delay: 0, epoch: 0, phase: 'inactive' };
	if (state.cooldownUntil > now)
		return { delay: state.cooldownUntil - now, epoch: 0, phase: 'cooldown' };
	const next = Math.max(now, state.adaptiveNext ?? 0);
	state.adaptiveNext =
		next +
		((input.fallbackWindow ?? 0) * (input.tokens ?? 1)) /
			(input.fallbackLimit ?? 1);
	return { delay: next - now, epoch: 0, phase: 'learned' };
}
export function limiterLayer(namespace: DurableObjectNamespace) {
	const call = Effect.fn('CloudRateLimiter.call')(
		function* <A>(input: LimitInput, schema: Schema.Decoder<A>) {
			const text = yield* Effect.tryPromise(async () => {
				const response = await namespace
					.get(namespace.idFromName('rate-limits'))
					.fetch('https://internal/limit', {
						method: 'POST',
						body: JSON.stringify(input),
					});
				if (!response.ok) throw new Error('Rate limit storage unavailable');
				return await response.text();
			});
			return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text);
		},
		Effect.mapError(
			() =>
				new RateLimiter.RateLimiterError({
					reason: new RateLimiter.RateLimitStoreError({
						message: 'Rate limit storage unavailable.',
					}),
				}),
		),
	);
	const store = Layer.succeed(
		RateLimiter.RateLimiterStore,
		RateLimiter.RateLimiterStore.of({
			fixedWindow: (options) =>
				call(
					{
						...options,
						method: 'fixedWindow',
						refillRate: Duration.toMillis(options.refillRate),
					},
					Pair,
				),
			tokenBucket: (options) =>
				call(
					{
						...options,
						method: 'tokenBucket',
						refillRate: Duration.toMillis(options.refillRate),
					},
					Pair,
				),
			adaptiveConsume: (options) =>
				call(
					{
						...options,
						method: 'adaptiveConsume',
						fallbackWindow: Duration.toMillis(options.fallbackWindow),
					},
					Adaptive,
				).pipe(
					Effect.map((result) => ({
						...result,
						delay: Duration.millis(result.delay),
					})),
				),
			adaptiveFeedback: (options) =>
				call(
					{
						method: 'adaptiveFeedback',
						key: options.key,
						status: options.status,
						...(options.retryAfter === undefined
							? {}
							: { retryAfter: Duration.toMillis(options.retryAfter) }),
					},
					Schema.Null,
				).pipe(Effect.asVoid),
		}),
	);
	return RateLimiter.layer.pipe(Layer.provide(store));
}
