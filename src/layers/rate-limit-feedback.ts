import { DateTime, Duration, Effect, Option } from 'effect';
import type { HttpClientResponse } from 'effect/http';
import { RateLimiter } from 'effect/persistence';

export const retryAfterMillis = Effect.fn('Http.retryAfterMillis')(function* (
	raw: string | undefined,
	cooldown: number,
) {
	const seconds = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
	const date = raw === undefined ? Option.none() : DateTime.make(raw);
	const now = DateTime.toEpochMillis(yield* DateTime.now);
	return Number.isFinite(seconds) && seconds >= 0
		? seconds * 1_000
		: Option.isSome(date)
			? Math.max(0, DateTime.toEpochMillis(date.value) - now)
			: cooldown;
});

export const rateLimitFeedback = (
	limiter: RateLimiter.RateLimiter,
	key: string,
	cooldown: number,
) =>
	Effect.fn('Http.rateLimitFeedback')(function* (
		response: HttpClientResponse.HttpClientResponse,
	) {
		if (response.status !== 429) return;
		const delay = yield* retryAfterMillis(
			response.headers['retry-after'],
			cooldown,
		);
		yield* limiter.adaptiveFeedback({
			key,
			epoch: 0,
			tokens: 1,
			status: 429,
			retryAfter: Duration.millis(delay),
		});
	});
