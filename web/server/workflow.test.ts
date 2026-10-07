import { expect, it } from 'vitest';

import { applyResult, recover, unlocked } from './business.js';
import { initial, type Document } from './store.js';
import {
	ensureStarted,
	runClassification,
	type CheckpointStep,
	type WorkflowServices,
} from './workflow.js';

const step: CheckpointStep = {
	do: async (_name, options, callback) => {
		expect(options.retries.limit).toBe(0);
		return callback();
	},
};
function fixture() {
	let s: Document = {
		...initial(),
		library: {
			version: 1,
			steamId: null,
			games: [1, 2].map((appid) => ({
				appid,
				name: `Game ${appid}`,
				playtime_forever: 0,
				tags: [],
				reviewed: false,
			})),
		},
		job: {
			id: 'job',
			status: 'queued',
			total: 2,
			completed: 0,
			current: null,
			error: null,
			cancel: false,
			steamId: null,
			ids: [1, 2],
			criteria: { Action: 'action' },
		},
	};
	let calls = 0;
	const io: WorkflowServices = {
		load: async () => s,
		modify: async (f) => {
			s = f(s);
			return s;
		},
		classify: async (input) => {
			calls++;
			s = applyResult(
				{ ...s, flight: input, result: { ...input, tags: ['Action'] } },
				input.requestId,
				input.appid,
			);
		},
	};
	return {
		io,
		get: () => s,
		calls: () => calls,
		set: (next: Document) => {
			s = next;
		},
	};
}
it('replays without a journal using atomic persisted index, preserving tag edits', async () => {
	const f = fixture();
	const classify = f.io.classify;
	f.io.classify = async (input) => {
		await classify(input);
		if (input.appid === 1) throw new Error('journal lost');
	};
	await expect(runClassification(step, 'job', f.io)).rejects.toThrow(
		'journal lost',
	);
	expect(f.get().job?.completed).toBe(1);
	f.set({
		...f.get(),
		job: { ...f.get().job!, status: 'running' },
		library: {
			...f.get().library,
			games: f
				.get()
				.library.games.map((g) => ({ ...g, tags: [...g.tags, 'Edited'] })),
		},
	});
	f.io.classify = classify;
	await runClassification(step, 'job', f.io);
	expect(f.calls()).toBe(2);
	expect(f.get().job?.status).toBe('complete');
	expect(f.get().library.games[1]?.tags).toEqual(['Edited', 'Action']);
});
it('cancels at next boundary after saving the in-flight game', async () => {
	const f = fixture();
	const classify = f.io.classify;
	f.io.classify = async (input) => {
		f.set({ ...f.get(), job: { ...f.get().job!, cancel: true } });
		await classify(input);
	};
	await runClassification(step, 'job', f.io);
	expect(f.calls()).toBe(1);
	expect(f.get().job?.status).toBe('cancelled');
	expect(f.get().job?.completed).toBe(1);
});
it('failed step preserves uncertain flight and requires consent recovery', async () => {
	const f = fixture();
	f.io.classify = async (input) => {
		f.set({ ...f.get(), flight: input });
		throw new Error('provider lost');
	};
	await expect(runClassification(step, 'job', f.io)).rejects.toThrow();
	expect(f.get().job?.status).toBe('failed');
	expect(() => unlocked(f.get())).toThrow('uncertain');
	expect(recover(f.get()).flight).toBe(null);
});
it('active job blocks recovery and mutation, terminal delayed workflow cannot charge', async () => {
	const f = fixture();
	expect(() => unlocked(f.get())).toThrow('active');
	expect(() => recover(f.get())).toThrow('active');
	f.set({ ...f.get(), job: { ...f.get().job!, status: 'failed' } });
	await runClassification(step, 'job', f.io);
	expect(f.calls()).toBe(0);
});
it('creation failure checks deterministic instance before propagating, accepting lost responses', async () => {
	const ids: string[] = [];
	const binding = {
		create: async ({ id }: { id: string }) => {
			ids.push(id);
			throw new Error('create lost');
		},
		get: async (id: string) => {
			ids.push(id);
			return { status: async () => ({ status: 'running' }) };
		},
	};
	await ensureStarted(
		binding as unknown as Parameters<typeof ensureStarted>[0],
		'owner',
		'job',
	);
	expect(ids).toEqual(['job', 'job']);
	binding.get = async () => {
		throw new Error('missing');
	};
	await expect(
		ensureStarted(
			binding as unknown as Parameters<typeof ensureStarted>[0],
			'owner',
			'job',
		),
	).rejects.toThrow('create lost');
});
