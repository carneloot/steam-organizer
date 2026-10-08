import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers';
import { Workflow, task } from 'alchemy/Cloudflare/Workflows';
import { Effect, Exit } from 'effect';

import { activeJob, classifyOne, paidState } from './business.js';
import { HttpError } from './security.js';
import { services, type Env } from './services.js';
import { Store } from './store.js';

export type WorkflowServices = ReturnType<typeof workflowServices>;
const options = {
	retries: { limit: 0, delay: '1 second' },
	timeout: '2 minutes',
} as const;
export class Classification extends Workflow<Classification>()(
	'CLASSIFICATION',
	Effect.succeed(
		Effect.fn('Classification.run')(function* (input: {
			owner: string;
			id: string;
		}) {
			const env = (yield* WorkerEnvironment) as Env;
			yield* runClassification(input.id, workflowServices(env, input.owner));
		}),
	),
) {}
export const runClassification = Effect.fn('Classification.runBatch')(
	function* (id: string, operations: WorkflowServices) {
		const snapshot = yield* task(
			'snapshot',
			Effect.gen(function* () {
				const state = yield* operations.load();
				if (state.job?.id !== id)
					return yield* Effect.fail(new HttpError(404, 'Job missing.'));
				return {
					...state.job,
					concurrency: state.requests === undefined ? 1 : 3,
				};
			}),
			options,
		);
		const concurrency = snapshot.concurrency ?? 1;
		for (let index = 0; index < snapshot.ids.length; index += concurrency) {
			const proceed = yield* task(
				`boundary-${index}`,
				Effect.gen(function* () {
					const state = yield* operations.modify((state) => {
						if (state.job?.id !== id || !activeJob(state)) return state;
						return {
							...state,
							job: {
								...state.job,
								status: state.job.cancel ? 'cancelled' : 'running',
								current: state.job.cancel
									? null
									: (state.library.games.find(
											(game) => game.appid === snapshot.ids[index],
										)?.name ?? null),
							},
						};
					});
					return state.job?.id === id && activeJob(state);
				}),
				options,
			);
			if (!proceed) return;
			const results = yield* Effect.forEach(
				snapshot.ids.slice(index, index + concurrency),
				(appid, offset) => {
					const gameIndex = index + offset;
					const requestId = `${id}:${gameIndex}`;
					return task(
						`game-${gameIndex}-${appid}`,
						Effect.gen(function* () {
							const state = yield* operations.load();
							if (
								state.job?.id !== id ||
								!activeJob(state) ||
								state.job.cancel ||
								paidState(state, requestId).completed?.requestId ===
									requestId ||
								(state.requests === undefined &&
									state.job.completed > gameIndex)
							)
								return;
							yield* operations.classify({
								appid,
								criteria: snapshot.criteria,
								requestId,
							});
						}),
						options,
					).pipe(Effect.exit);
				},
				{ concurrency },
			);
			const failure = results.find(Exit.isFailure);
			if (failure) return yield* Effect.failCause(failure.cause);
		}
		yield* task(
			'finish',
			operations
				.modify((state) =>
					state.job?.id === id && activeJob(state)
						? {
								...state,
								job: {
									...state.job,
									status: state.job.cancel ? 'cancelled' : 'complete',
									current: null,
								},
							}
						: state,
				)
				.pipe(Effect.asVoid),
			options,
		);
	},
	(effect, id, operations) =>
		effect.pipe(
			Effect.catchCause((cause) =>
				task('fail', failJob(operations, id), options).pipe(
					Effect.andThen(Effect.failCause(cause)),
				),
			),
		),
);
export const failJob = Effect.fn('Classification.failJob')(function* (
	operations: Pick<WorkflowServices, 'modify'>,
	id: string,
) {
	yield* operations.modify((state) =>
		state.job?.id === id && activeJob(state)
			? {
					...state,
					job: {
						...state.job,
						status: 'failed',
						current: null,
						error:
							'Classification stopped. Saved results are preserved; recover any uncertain paid request before continuing.',
					},
				}
			: state,
	);
});
export function workflowServices(env: Env, owner: string) {
	const store = new Store(env.DB, owner);
	return {
		load: () => store.load().pipe(Effect.map(({ state }) => state)),
		modify: store.modify,
		classify: (input: Parameters<typeof classifyOne>[1]) =>
			classifyOne(store, input).pipe(Effect.provide(services(env))),
	};
}
export const ensureStarted = Effect.fn('Classification.ensureStarted')(
	function* (binding: Env['CLASSIFICATION'], owner: string, id: string) {
		yield* Effect.tryPromise(() =>
			binding.create({ id, params: { owner, id } }),
		).pipe(
			Effect.catch((error) =>
				// Creation may have succeeded even when its response was lost.
				Effect.tryPromise(async () => (await binding.get(id)).status()).pipe(
					Effect.mapError(() => error),
				),
			),
		);
	},
);
export const reconcile = Effect.fn('Classification.reconcile')(function* (
	env: Env,
	owner: string,
) {
	const operations = workflowServices(env, owner);
	const state = yield* operations.load();
	if (!activeJob(state)) return state;
	const id = state.job!.id;
	yield* Effect.gen(function* () {
		if (state.job!.status === 'queued')
			yield* ensureStarted(env.CLASSIFICATION, owner, id);
		const status = yield* Effect.tryPromise(async () =>
			(await env.CLASSIFICATION.get(id)).status(),
		);
		if (['errored', 'terminated', 'complete'].includes(status.status))
			yield* failJob(operations, id);
	}).pipe(
		Effect.catch(() =>
			// Release the claim on infrastructure failure; a delayed instance cannot charge a terminal job.
			failJob(operations, id),
		),
	);
	return yield* operations.load();
});
