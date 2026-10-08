import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

import { buildWorker } from '../../tools/build-worker.js';

it('Alchemy Effect Worker validates API requests and saves Workflow results without browser polling', async () => {
	const bundled = await buildWorker();
	let calls = 0;
	const runtime = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: String(bundled.files[0].content),
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
		const db = await runtime.getD1Database('DB');
		await db
			.prepare(await readFile('web/migrations/0001_state.sql', 'utf8'))
			.run();
		const mutationHeaders = {
			origin: 'http://localhost',
			'content-type': 'application/json',
			'x-requested-with': 'steam-organizer',
		};
		for (const [url, method, body, headers, status] of [
			['http://localhost/api/missing', 'GET', undefined, {}, 404],
			['http://localhost/api/state', 'DELETE', undefined, {}, 405],
			['http://localhost/api/export?format=xml', 'GET', undefined, {}, 400],
			['https://not-local.test/api/state', 'GET', undefined, {}, 403],
			['http://localhost/api/tags', 'POST', '{', mutationHeaders, 400],
			[
				'http://localhost/api/sync',
				'POST',
				'{"steamId":"invalid","confirm":true}',
				mutationHeaders,
				400,
			],
			[
				'http://localhost/api/classify/recover',
				'POST',
				'{"confirm":false}',
				mutationHeaders,
				400,
			],
			[
				'http://localhost/api/jobs/cancel',
				'POST',
				'{}',
				{ ...mutationHeaders, origin: 'https://evil.test' },
				403,
			],
		] as const) {
			const response = await runtime.dispatchFetch(url, {
				method,
				headers,
				...(body === undefined ? {} : { body }),
			});
			expect(response.status, `${method} ${url}`).toBe(status);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(await response.json()).toHaveProperty('message');
		}
		const post = async (route: string, body: unknown) => {
			const response = await runtime.dispatchFetch(
				`http://localhost/api/${route}`,
				{
					method: 'POST',
					headers: {
						origin: 'http://localhost',
						'content-type': 'application/json',
						'x-requested-with': 'steam-organizer',
					},
					body: JSON.stringify(body),
				},
			);
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
			document.library.games.find(
				(game: { appid: number }) => game.appid === 400,
			).tags,
		).toEqual(['Puzzle']);
		expect(calls).toBe(1);
	} finally {
		await runtime.dispose();
	}
}, 30_000);
