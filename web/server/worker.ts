import {
	DurableObject,
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers';
import { Cause, Effect, Exit, Schema } from 'effect';

import { exportLibrary } from '../../src/domain/library.js';
import { mutate, stateResponse } from './business.js';
import {
	updateLimit,
	LimitStateSchema,
	type LimitInput,
	type LimitState,
} from './rate-limit.js';
import { authorize, readBody, json, HttpError } from './security.js';
import { services, type Env } from './services.js';
import { Store } from './store.js';
import { reconcile, runClassification, workflowServices } from './workflow.js';

export class ClassificationWorkflow extends WorkflowEntrypoint<
	Env,
	{ owner: string; id: string }
> {
	async run(
		event: WorkflowEvent<{ owner: string; id: string }>,
		step: WorkflowStep,
	) {
		await runClassification(
			step,
			event.payload.id,
			workflowServices(this.env, event.payload.owner),
		);
	}
}

export class ApiCoordinator extends DurableObject<Env> {
	async fetch(request: Request) {
		try {
			const input: LimitInput = await request.json();
			const result = await this.ctx.storage.transaction(async (tx) => {
				const s: LimitState = Schema.decodeUnknownSync(LimitStateSchema)(
					(await tx.get(input.key)) ?? {},
				);
				const result = updateLimit(s, input, Date.now());
				await tx.put(input.key, s);
				return result;
			});
			return json(result);
		} catch {
			return json({ message: 'Rate limit storage unavailable.' }, 503);
		}
	}
}
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		try {
			const identity = await authorize(request, env, ctx);
			const url = new URL(request.url),
				path = url.pathname;
			if (path === '/api') throw new HttpError(404, 'Unknown API route.');
			if (!path.startsWith('/api/')) {
				const response = await env.ASSETS.fetch(request);
				const headers = new Headers(response.headers);
				headers.set('cache-control', 'no-store');
				return new Response(response.body, {
					status: response.status,
					headers,
				});
			}
			if (request.method === 'POST') {
				const body = await readBody(request);
				const exit = await Effect.runPromiseExit(
					mutate(path, body, env, identity).pipe(Effect.provide(services(env))),
				);
				if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
				return json(exit.value);
			}
			if (request.method !== 'GET')
				throw new HttpError(405, 'Method not allowed.');
			const s =
				path === '/api/state'
					? await reconcile(env, identity)
					: (await Effect.runPromise(new Store(env.DB, identity).load())).state;
			if (path === '/api/state') return json(stateResponse(s, env, identity));
			if (path === '/api/backup') return json(s.library);
			if (path === '/api/export') {
				const format = url.searchParams.get('format');
				if (format !== 'json' && format !== 'csv')
					throw new HttpError(400, 'Unknown export format.');
				return new Response(exportLibrary(s.library, format), {
					headers: {
						'content-type': format === 'csv' ? 'text/csv' : 'application/json',
						'cache-control': 'no-store',
						'content-disposition': `attachment; filename="steam-library.${format}"`,
						'x-content-type-options': 'nosniff',
					},
				});
			}
			throw new HttpError(404, 'Unknown API route.');
		} catch (error) {
			return json(
				{
					message:
						error instanceof HttpError
							? error.message
							: 'Request failed. Please try again.',
				},
				error instanceof HttpError ? error.status : 400,
			);
		}
	},
};
