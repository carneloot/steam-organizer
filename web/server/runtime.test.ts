import { build } from 'esbuild';
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('native Workflow saves paid results without any browser polling', async () => {
	const bundled = await build({
		entryPoints: ['web/server/worker.ts'],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'neutral',
		mainFields: ['module', 'main'],
		external: ['cloudflare:*'],
	});
	let calls = 0;
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: bundled.outputFiles[0]!.text,
			compatibilityDate: '2026-10-07',
			compatibilityFlags: ['nodejs_compat'],
			bindings: { LOCAL_DEV: 'true', TYPESAFE_API_KEY: 'fake-test-key' },
			d1Databases: ['DB'],
			durableObjects: {
				COORDINATOR: { className: 'ApiCoordinator', useSQLite: true },
			},
			workflows: {
				CLASSIFICATION: {
					name: 'test-classification',
					className: 'ClassificationWorkflow',
				},
			},
			outboundService: async (request) => {
				if (new URL(request.url).hostname !== 'api.typesafe.ai')
					return new Response('{}', {
						headers: { 'content-type': 'application/json' },
					});
				calls++;
				await new Promise((resolve) => setTimeout(resolve, 200));
				return new Response(
					JSON.stringify({ answers: { Puzzle: { type: 'noul', noul: 0.95 } } }),
					{
						headers: { 'content-type': 'application/json' },
					},
				);
			},
		}),
	);
	try {
		const db = await mf.getD1Database('DB');
		await db
			.prepare(await readFile('web/migrations/0001_state.sql', 'utf8'))
			.run();
		const post = async (route: string, body: unknown) => {
			const response = await mf.dispatchFetch(`http://localhost/api/${route}`, {
				method: 'POST',
				headers: {
					origin: 'http://localhost',
					'content-type': 'application/json',
					'x-requested-with': 'steam-organizer',
				},
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
			return response.json();
		};
		await post('import', {
			confirm: true,
			text: JSON.stringify([
				{ appid: 620, name: 'Portal 2', playtime_forever: 400 },
				{ appid: 400, name: 'Portal', playtime_forever: 0 },
				{ appid: 9, name: 'Reviewed elsewhere', playtime_forever: 120 },
			]),
		});
		await post('criteria', {
			steamId: null,
			criteria: { Puzzle: 'Logical puzzles.' },
		});
		await post('classify', {
			steamId: null,
			search: 'portal',
			category: 'unplayed',
			all: false,
		});
		// No further HTTP requests: read persisted state directly while the job runs.
		let document;
		for (let attempt = 0; attempt < 150; attempt++) {
			const row = await db
				.prepare('SELECT document FROM organizer_state WHERE owner=?')
				.bind('local@example.test')
				.first<{ document: string }>();
			document = JSON.parse(row!.document);
			if (['complete', 'failed'].includes(document.job?.status)) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(document.job.status).toBe('complete');
		expect(document.job.ids).toEqual([400]);
		expect(document.job.completed).toBe(1);
		expect(
			document.library.games.find((g: { appid: number }) => g.appid === 400)
				.tags,
		).toEqual(['Puzzle']);
		expect(calls).toBe(1);
	} finally {
		await mf.dispose();
	}
}, 30_000);
