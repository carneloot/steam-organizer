import {
	Worker,
	Request,
	WorkerEnvironment,
	WorkerExecutionContext,
} from 'alchemy/Cloudflare/Workers';
import { Cause, Effect } from 'effect';
import { HttpServerResponse } from 'effect/http';

import { apiHandler } from './api.js';
import { authorize, HttpError, json, requestError } from './security.js';
import { services, type Env } from './services.js';
import { Classification } from './workflow.js';

export default class Application extends Worker<Application>()(
	'Web',
	{ main: import.meta.url },
	Effect.gen(function* () {
		yield* Classification;
		return {
			fetch: Effect.gen(function* () {
				const request = yield* Request;
				const env = (yield* WorkerEnvironment) as Env;
				const context = yield* WorkerExecutionContext;
				const identity = yield* Effect.tryPromise({
					try: () => authorize(request, env, context.raw),
					catch: requestError,
				});
				const path = new URL(request.url).pathname;
				if (path === '/api')
					return yield* Effect.fail(new HttpError(404, 'Unknown API route.'));
				if (!path.startsWith('/api/')) {
					const response = yield* Effect.tryPromise({
						try: () => env.ASSETS.fetch(request),
						catch: requestError,
					});
					const headers = new Headers(response.headers);
					headers.set('cache-control', 'no-store');
					return HttpServerResponse.fromWeb(
						new globalThis.Response(response.body, {
							status: response.status,
							headers,
						}),
					);
				}
				if (request.method !== 'GET' && request.method !== 'POST')
					return yield* Effect.fail(new HttpError(405, 'Method not allowed.'));
				return yield* apiHandler(env, identity).pipe(
					Effect.provide(services(env)),
				);
			}).pipe(
				Effect.catchCause((cause) => {
					const error = Cause.squash(cause);
					return Effect.succeed(
						HttpServerResponse.fromWeb(
							json(
								{
									message:
										error instanceof HttpError
											? error.message
											: 'Request failed. Please try again.',
								},
								error instanceof HttpError ? error.status : 400,
							),
						),
					);
				}),
			),
		};
	}),
) {}
