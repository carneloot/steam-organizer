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
	modify(update: (s: Document) => Document): Promise<Document>;
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
	io: WorkflowServices,
) {
	try {
		const snapshot = await step.do('snapshot', options, async () => {
			const s = await io.load();
			if (s.job?.id !== id) throw new Error('Job missing.');
			return s.job;
		});
		for (let index = 0; index < snapshot.ids.length; index++) {
			const proceed = await step.do(`boundary-${index}`, options, async () => {
				const s = await io.modify((s) => {
					if (s.job?.id !== id || !activeJob(s)) return s;
					return {
						...s,
						job: {
							...s.job,
							status: s.job.cancel ? 'cancelled' : 'running',
							current: s.job.cancel
								? null
								: (s.library.games.find((g) => g.appid === snapshot.ids[index])
										?.name ?? null),
						},
					};
				});
				return s.job?.id === id && activeJob(s);
			});
			if (!proceed) return;
			await step.do(
				`game-${index}-${snapshot.ids[index]}`,
				options,
				async () => {
					const s = await io.load();
					if (s.job?.id !== id || !activeJob(s) || s.job.completed > index)
						return;
					await io.classify({
						appid: snapshot.ids[index]!,
						criteria: snapshot.criteria,
						requestId: `${id}:${index}`,
					});
				},
			);
		}
		await step.do('finish', options, () =>
			io
				.modify((s) =>
					s.job?.id === id && activeJob(s)
						? {
								...s,
								job: {
									...s.job,
									status: s.job.cancel ? 'cancelled' : 'complete',
									current: null,
								},
							}
						: s,
				)
				.then(() => undefined),
		);
	} catch (error) {
		await step.do('fail', options, () => failJob(io, id));
		throw error;
	}
}
export async function failJob(
	io: Pick<WorkflowServices, 'modify'>,
	id: string,
) {
	await io.modify((s) =>
		s.job?.id === id && activeJob(s)
			? {
					...s,
					job: {
						...s.job,
						status: 'failed',
						current: null,
						error:
							'Classification stopped. Saved results are preserved; recover any uncertain paid request before continuing.',
					},
				}
			: s,
	);
}
export function workflowServices(env: Env, owner: string): WorkflowServices {
	const store = new Store(env.DB, owner);
	return {
		load: async () => (await Effect.runPromise(store.load())).state,
		modify: (f) => Effect.runPromise(store.modify(f)),
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
	const io = workflowServices(env, owner);
	let s = await io.load();
	if (!activeJob(s)) return s;
	const id = s.job!.id;
	try {
		if (s.job!.status === 'queued')
			await ensureStarted(env.CLASSIFICATION, owner, id);
		const status = await (await env.CLASSIFICATION.get(id)).status();
		if (['errored', 'terminated', 'complete'].includes(status.status))
			await failJob(io, id);
	} catch {
		// Release the claim on infrastructure failure; a delayed instance cannot charge a terminal job.
		await failJob(io, id);
	}
	s = await io.load();
	return s;
}
