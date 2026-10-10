import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers';
import { Workflow, sleep, task } from 'alchemy/Cloudflare/Workflows';
import { Cause, Effect, Exit, Schema } from 'effect';

import { classifyOne } from './business.js';
import { HttpError } from './security.js';
import { services, type Env } from './services.js';
import { Store, activeJob } from './store.js';

export type WorkflowServices = Effect.Success<
	ReturnType<typeof workflowServices>
>;
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
			yield* Effect.gen(function* () {
				const operations = yield* workflowServices(env);
				yield* runClassification(input.id, operations);
			}).pipe(Effect.provide(Store.layer(env.DB, input.owner)));
		}),
	),
) {}
export const runClassification = Effect.fn('Classification.runBatch')(
	function* (id: string, operations: WorkflowServices) {
		const snapshot = yield* task(
			'snapshot',
			Effect.gen(function* () {
				const job = yield* operations.getJob();
				if (job?.id !== id)
					return yield* Effect.fail(new HttpError(404, 'Job missing.'));
				return job;
			}),
			options,
		);
		const concurrency = 3;
		for (let index = 0; index < snapshot.ids.length; index += concurrency) {
			const proceed = yield* task(
				`boundary-${index}`,
				operations.beginBatch(id, snapshot.ids[index]!),
				options,
			);
			if (!proceed) return;
			const results = yield* Effect.forEach(
				snapshot.ids.slice(index, index + concurrency),
				(appid, offset) => {
					const gameIndex = index + offset;
					return Effect.gen(function* () {
						let rejections = 0;
						for (let attempt = 0; ; attempt++) {
							const result = yield* task(
								`game-${gameIndex}-${appid}${attempt === 0 ? '' : `-attempt-${attempt}`}`,
								Effect.gen(function* () {
									if (!(yield* operations.shouldClassify(id, gameIndex)))
										return null;
									return yield* operations
										.classify({
											jobId: id,
											index: gameIndex,
											appid,
											criteria: snapshot.criteria,
										})
										.pipe(
											Effect.as(null),
											Effect.catchTags({
												ClassificationDeferred: (error) =>
													Effect.succeed({
														delay: error.retryAfterMs,
														rejected: false,
														message: error.message,
													}),
												ClassificationRequestError: (error) =>
													error.status === 429
														? Effect.succeed({
																delay: error.retryAfterMs ?? 60_000,
																rejected: true,
																message: `${error.message}${error.requestId ? ` Request ID: ${error.requestId}.` : ''}`,
															})
														: Effect.fail(error),
											}),
										);
								}),
								options,
							);
							if (!result) return;
							if (result.rejected && rejections++ >= 3)
								return yield* Effect.fail(
									new HttpError(
										429,
										`${result.message} Rate limit retries exhausted after 4 attempts. Try this game in a later job.`,
									),
								);
							const delay = Math.max(1_000, result.delay);
							yield* Effect.logWarning('Classification workflow waiting', {
								jobId: id,
								appid,
								index: gameIndex,
								attempt,
								rejections,
								delayMs: delay,
								reason: result.message,
							});
							yield* sleep(`wait-${gameIndex}-${appid}-${attempt}`, delay);
						}
					}).pipe(
						Effect.catchCause((cause) => {
							const error = Cause.squash(cause);
							// Cached task failures restore fields, not Error prototypes.
							const message = Schema.is(
								Schema.Struct({
									status: Schema.Finite,
									message: Schema.String,
								}),
							)(error)
								? error.message
								: 'Classification failed. Try this game in a later job.';
							return task(
								`error-${gameIndex}-${appid}`,
								Effect.logError('Classification workflow game failed', {
									jobId: id,
									appid,
									index: gameIndex,
									message,
								}).pipe(
									Effect.andThen(operations.saveGameError(id, appid, message)),
								),
								options,
							);
						}),
						Effect.exit,
					);
				},
				{ concurrency },
			);
			const failure = results.find(Exit.isFailure);
			if (failure) return yield* Effect.failCause(failure.cause);
		}
		yield* task('finish', operations.finishJob(id), options);
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
export const failJob = (
	operations: Pick<WorkflowServices, 'failJob'>,
	id: string,
) =>
	operations.failJob(
		id,
		'Classification stopped. Saved results are preserved; recover any uncertain paid request before continuing.',
	);
export const workflowServices = Effect.fn('Classification.services')(function* (
	env: Env,
) {
	const store = yield* Store;
	return {
		getJob: store.getJob,
		beginBatch: store.beginBatch,
		shouldClassify: store.shouldClassify,
		saveGameError: store.saveGameError,
		finishJob: store.finishJob,
		failJob: store.failJob,
		classify: (input: Parameters<typeof classifyOne>[0]) =>
			classifyOne(input).pipe(
				Effect.provideService(Store, store),
				Effect.provide(services(env)),
			),
	};
});
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
	const operations = yield* workflowServices(env);
	const job = yield* operations.getJob();
	if (!job || !activeJob(job)) return;
	const id = job.id;
	yield* Effect.gen(function* () {
		if (job.status === 'queued')
			yield* ensureStarted(env.CLASSIFICATION, owner, id);
		const status = yield* Effect.tryPromise(async () =>
			(await env.CLASSIFICATION.get(id)).status(),
		);
		if (['errored', 'terminated', 'complete'].includes(status.status))
			yield* failJob(operations, id);
	}).pipe(
		Effect.catch(() =>
			// A delayed instance cannot charge a terminal job after infrastructure failure.
			failJob(operations, id),
		),
	);
});
