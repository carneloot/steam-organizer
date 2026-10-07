import { Duration, Effect, Layer, Schema } from 'effect';
import { RateLimiter } from 'effect/persistence';

export interface LimitState {
	fixed?: { count: number; expiresAt: number };
	bucket?: { tokens: number; lastRefill: number };
	cooldownUntil?: number;
	adaptiveNext?: number;
}
export interface LimitInput {
	method: string;
	key: string;
	tokens?: number;
	limit?: number | undefined;
	refillRate?: number;
	allowOverflow?: boolean;
	fallbackWindow?: number;
	fallbackLimit?: number;
	status?: number;
	retryAfter?: number;
}
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
	s: LimitState,
	o: LimitInput,
	now: number,
): unknown {
	if (o.method === 'fixedWindow') {
		const c =
			!s.fixed || s.fixed.expiresAt <= now
				? { count: 0, expiresAt: now }
				: { ...s.fixed };
		const count = c.count + (o.tokens ?? 1);
		if (o.limit !== undefined && count > o.limit)
			return [count, c.expiresAt - now];
		c.count = count;
		c.expiresAt += (o.refillRate ?? 0) * (o.tokens ?? 1);
		s.fixed = c;
		return [count, c.expiresAt - now];
	}
	if (o.method === 'tokenBucket') {
		const limit = o.limit ?? 1,
			refill = o.refillRate ?? 1;
		const b = s.bucket ? { ...s.bucket } : { tokens: limit, lastRefill: now };
		const added = Math.floor((now - b.lastRefill) / refill);
		if (added > 0) {
			b.tokens = Math.min(limit, b.tokens + added);
			b.lastRefill += added * refill;
		}
		if (b.tokens >= limit) b.lastRefill = now;
		const remaining = b.tokens - (o.tokens ?? 1);
		if (o.allowOverflow || remaining >= 0) b.tokens = remaining;
		s.bucket = b;
		return [remaining, Math.max(0, now - b.lastRefill)];
	}
	if (o.method === 'adaptiveFeedback') {
		if (o.status === 429 && o.retryAfter !== undefined)
			s.cooldownUntil = Math.max(s.cooldownUntil ?? 0, now + o.retryAfter);
		return null;
	}
	if (s.cooldownUntil === undefined)
		return { delay: 0, epoch: 0, phase: 'inactive' };
	if (s.cooldownUntil > now)
		return { delay: s.cooldownUntil - now, epoch: 0, phase: 'cooldown' };
	const next = Math.max(now, s.adaptiveNext ?? 0);
	s.adaptiveNext =
		next + ((o.fallbackWindow ?? 0) * (o.tokens ?? 1)) / (o.fallbackLimit ?? 1);
	return { delay: next - now, epoch: 0, phase: 'learned' };
}
export function limiterLayer(namespace: DurableObjectNamespace) {
	const call = Effect.fn('CloudRateLimiter.call')(
		<A>(input: LimitInput, schema: Schema.Decoder<A>) =>
			Effect.tryPromise({
				try: async () => {
					const response = await namespace
						.get(namespace.idFromName('rate-limits'))
						.fetch('https://internal/limit', {
							method: 'POST',
							body: JSON.stringify(input),
						});
					if (!response.ok) throw new Error('Rate limit storage unavailable');
					return Schema.decodeUnknownSync(schema)(await response.json());
				},
				catch: () =>
					new RateLimiter.RateLimiterError({
						reason: new RateLimiter.RateLimitStoreError({
							message: 'Rate limit storage unavailable.',
						}),
					}),
			}),
	);
	const store = Layer.succeed(
		RateLimiter.RateLimiterStore,
		RateLimiter.RateLimiterStore.of({
			fixedWindow: (o) =>
				call(
					{
						...o,
						method: 'fixedWindow',
						refillRate: Duration.toMillis(o.refillRate),
					},
					Pair,
				),
			tokenBucket: (o) =>
				call(
					{
						...o,
						method: 'tokenBucket',
						refillRate: Duration.toMillis(o.refillRate),
					},
					Pair,
				),
			adaptiveConsume: (o) =>
				call(
					{
						...o,
						method: 'adaptiveConsume',
						fallbackWindow: Duration.toMillis(o.fallbackWindow),
					},
					Adaptive,
				).pipe(Effect.map((r) => ({ ...r, delay: Duration.millis(r.delay) }))),
			adaptiveFeedback: (o) =>
				call(
					{
						method: 'adaptiveFeedback',
						key: o.key,
						status: o.status,
						...(o.retryAfter === undefined
							? {}
							: { retryAfter: Duration.toMillis(o.retryAfter) }),
					},
					Schema.Null,
				).pipe(Effect.asVoid),
		}),
	);
	return RateLimiter.layer.pipe(Layer.provide(store));
}
