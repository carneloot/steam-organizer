import { Effect } from 'effect';

import { activeJob, classifyOne } from './business.js';
import { services, type Env } from './services.js';
import { Store, type Document } from './store.js';

export interface CheckpointStep {
	do<T extends Rpc.Serializable<T>>(
		name: string,
		options: {
			retries: { limit: number; delay: '1 second' };
			timeout: '2 minutes';
		},
		callback: () => Promise<T>,
	): Promise<T>;
}
export interface WorkflowServices {
	load(): Promise<Document>;
	modify(update: (state: Document) => Document): Promise<Document>;
	classify(
		this: void,
		input: {
			appid: number;
			criteria: Record<string, string>;
			requestId: string;
		},
	): Promise<unknown>;
}
const options = {
	retries: { limit: 0, delay: '1 second' },
	timeout: '2 minutes',
} as const;
export async function runClassification(
	step: CheckpointStep,
	id: string,
	operations: WorkflowServices,
) {
	try {
		const snapshot = await step.do('snapshot', options, async () => {
			const state = await operations.load();
			if (state.job?.id !== id) throw new Error('Job missing.');
			return state.job;
		});
		for (let index = 0; index < snapshot.ids.length; index++) {
			const proceed = await step.do(`boundary-${index}`, options, async () => {
				const state = await operations.modify((state) => {
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
			});
			if (!proceed) return;
			await step.do(
				`game-${index}-${snapshot.ids[index]}`,
				options,
				async () => {
					const state = await operations.load();
					if (
						state.job?.id !== id ||
						!activeJob(state) ||
						state.job.completed > index
					)
						return;
					await operations.classify({
						appid: snapshot.ids[index]!,
						criteria: snapshot.criteria,
						requestId: `${id}:${index}`,
					});
				},
			);
		}
		await step.do('finish', options, () =>
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
				.then(() => undefined),
		);
	} catch (error) {
		await step.do('fail', options, () => failJob(operations, id));
		throw error;
	}
}
export async function failJob(
	operations: Pick<WorkflowServices, 'modify'>,
	id: string,
) {
	await operations.modify((state) =>
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
}
export function workflowServices(env: Env, owner: string): WorkflowServices {
	const store = new Store(env.DB, owner);
	return {
		load: async () => (await Effect.runPromise(store.load())).state,
		modify: (update) => Effect.runPromise(store.modify(update)),
		classify: (input) =>
			Effect.runPromise(
				classifyOne(store, input).pipe(Effect.provide(services(env))),
			),
	};
}
export async function ensureStarted(
	binding: Env['CLASSIFICATION'],
	owner: string,
	id: string,
) {
	try {
		await binding.create({ id, params: { owner, id } });
	} catch (error) {
		// Creation may have succeeded even when its response was lost.
		try {
			await (await binding.get(id)).status();
		} catch {
			throw error;
		}
	}
}
export async function reconcile(env: Env, owner: string): Promise<Document> {
	const operations = workflowServices(env, owner);
	let state = await operations.load();
	if (!activeJob(state)) return state;
	const id = state.job!.id;
	try {
		if (state.job!.status === 'queued')
			await ensureStarted(env.CLASSIFICATION, owner, id);
		const status = await (await env.CLASSIFICATION.get(id)).status();
		if (['errored', 'terminated', 'complete'].includes(status.status))
			await failJob(operations, id);
	} catch {
		// Release the claim on infrastructure failure; a delayed instance cannot charge a terminal job.
		await failJob(operations, id);
	}
	state = await operations.load();
	return state;
}
