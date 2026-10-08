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
	let state: Document = {
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
	const operations: WorkflowServices = {
		load: async () => state,
		modify: async (update) => {
			state = update(state);
			return state;
		},
		classify: async (input) => {
			calls++;
			state = applyResult(
				{ ...state, flight: input, result: { ...input, tags: ['Action'] } },
				input.requestId,
				input.appid,
			);
		},
	};
	return {
		operations,
		get: () => state,
		calls: () => calls,
		set: (next: Document) => {
			state = next;
		},
	};
}
it('replays without a journal using atomic persisted index, preserving tag edits', async () => {
	const testFixture = fixture();
	const classify = testFixture.operations.classify;
	testFixture.operations.classify = async (input) => {
		await classify(input);
		if (input.appid === 1) throw new Error('journal lost');
	};
	await expect(
		runClassification(step, 'job', testFixture.operations),
	).rejects.toThrow('journal lost');
	expect(testFixture.get().job?.completed).toBe(1);
	testFixture.set({
		...testFixture.get(),
		job: { ...testFixture.get().job!, status: 'running' },
		library: {
			...testFixture.get().library,
			games: testFixture.get().library.games.map((game) => ({
				...game,
				tags: [...game.tags, 'Edited'],
			})),
		},
	});
	testFixture.operations.classify = classify;
	await runClassification(step, 'job', testFixture.operations);
	expect(testFixture.calls()).toBe(2);
	expect(testFixture.get().job?.status).toBe('complete');
	expect(testFixture.get().library.games[1]?.tags).toEqual([
		'Edited',
		'Action',
	]);
});
it('cancels at next boundary after saving the in-flight game', async () => {
	const testFixture = fixture();
	const classify = testFixture.operations.classify;
	testFixture.operations.classify = async (input) => {
		testFixture.set({
			...testFixture.get(),
			job: { ...testFixture.get().job!, cancel: true },
		});
		await classify(input);
	};
	await runClassification(step, 'job', testFixture.operations);
	expect(testFixture.calls()).toBe(1);
	expect(testFixture.get().job?.status).toBe('cancelled');
	expect(testFixture.get().job?.completed).toBe(1);
});
it('failed step preserves uncertain flight and requires consent recovery', async () => {
	const testFixture = fixture();
	testFixture.operations.classify = async (input) => {
		testFixture.set({ ...testFixture.get(), flight: input });
		throw new Error('provider lost');
	};
	await expect(
		runClassification(step, 'job', testFixture.operations),
	).rejects.toThrow();
	expect(testFixture.get().job?.status).toBe('failed');
	expect(() => unlocked(testFixture.get())).toThrow('uncertain');
	expect(recover(testFixture.get()).flight).toBe(null);
});
it('active job blocks recovery and mutation, terminal delayed workflow cannot charge', async () => {
	const testFixture = fixture();
	expect(() => unlocked(testFixture.get())).toThrow('active');
	expect(() => recover(testFixture.get())).toThrow('active');
	testFixture.set({
		...testFixture.get(),
		job: { ...testFixture.get().job!, status: 'failed' },
	});
	await runClassification(step, 'job', testFixture.operations);
	expect(testFixture.calls()).toBe(0);
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
