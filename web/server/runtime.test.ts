import { Effect } from 'effect';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

import { buildWorker } from '../../tools/build-worker.js';
import { Store } from './store.js';

it('Alchemy Effect Worker validates API requests and saves Workflow results without browser polling', async () => {
	const issuer = 'https://runtime-team.cloudflareaccess.com';
	const audience = 'runtime-access-application';
	const { publicKey, privateKey } = await generateKeyPair('RS256', {
		extractable: true,
	});
	const jwk = {
		...(await exportJWK(publicKey)),
		kid: 'runtime',
		alg: 'RS256',
		use: 'sig',
	};
	const token = await new SignJWT({ email: ' Runtime@Example.Test ' })
		.setProtectedHeader({ alg: 'RS256', kid: 'runtime' })
		.setIssuer(issuer)
		.setAudience(audience)
		.setSubject('runtime-user')
		.setExpirationTime('5m')
		.sign(privateKey);
	const bundled = await buildWorker();
	let calls = 0;
	let rejectPaidRequests = false;
	const pending: (() => void)[] = [];
	const runtime = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: String(bundled.files[0].content),
			compatibilityDate: '2026-10-07',
			compatibilityFlags: ['nodejs_compat'],
			bindings: {
				LOCAL_DEV: 'true',
				TYPESAFE_API_KEY: 'fake-test-key',
				ACCESS_TEAM_DOMAIN: issuer,
				ACCESS_AUD: audience,
			},
			serviceBindings: {
				ASSETS: async () =>
					new Response('<main>Steam Organizer assets</main>', {
						headers: { 'content-type': 'text/html' },
					}),
			},
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
				if (request.url === `${issuer}/cdn-cgi/access/certs`) {
					return new Response(JSON.stringify({ keys: [jwk] }), {
						headers: { 'content-type': 'application/json' },
					});
				}
				if (new URL(request.url).hostname !== 'api.typesafe.ai')
					return new Response('{}', {
						headers: { 'content-type': 'application/json' },
					});
				calls++;
				if (rejectPaidRequests) return new Response('{}', { status: 401 });
				await new Promise<void>((resolve) => {
					pending.push(resolve);
					if (pending.length === 3) pending.forEach((release) => release());
				});
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
		const sql = await readFile('web/migrations/0001_state.sql', 'utf8');
		await db.batch(
			sql
				.split(';')
				.filter((statement) => statement.trim())
				.map((statement) => db.prepare(statement)),
		);
		const jwtHeaders = {
			'cf-access-jwt-assertion': token,
			'cf-access-authenticated-user-email': 'attacker@example.test',
		};
		const page = await runtime.dispatchFetch('https://not-local.test/', {
			headers: jwtHeaders,
		});
		expect(page.status).toBe(200);
		expect(await page.text()).toBe('<main>Steam Organizer assets</main>');
		const imported = await runtime.dispatchFetch(
			'https://not-local.test/api/import',
			{
				method: 'POST',
				headers: {
					...jwtHeaders,
					origin: 'https://not-local.test',
					'content-type': 'application/json',
					'x-requested-with': 'steam-organizer',
				},
				body: JSON.stringify({
					confirm: true,
					text: JSON.stringify([
						{ appid: 1, name: 'JWT owner game', playtime_forever: 0 },
					]),
				}),
			},
		);
		expect(imported.status).toBe(200);
		expect(await db.prepare('SELECT owner FROM libraries').all()).toMatchObject(
			{ results: [{ owner: 'runtime@example.test' }] },
		);
		const anonymousPage = await runtime.dispatchFetch(
			'https://not-local.test/',
			{
				headers: {
					'cf-access-authenticated-user-email': 'attacker@example.test',
				},
			},
		);
		expect(anonymousPage.status).toBe(403);
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
				{ appid: 401, name: 'Portal companion', playtime_forever: 0 },
				{ appid: 402, name: 'Portal puzzles', playtime_forever: 0 },
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
		const store = new Store(db, 'local@example.test');
		const waitForJob = async () => {
			let { state } = await Effect.runPromise(store.load());
			for (let attempt = 0; attempt < 150; attempt++) {
				if (state.job?.status === 'complete' || state.job?.status === 'failed')
					break;
				await new Promise((resolve) => setTimeout(resolve, 100));
				state = (await Effect.runPromise(store.load())).state;
			}
			return state;
		};
		let document = await waitForJob();
		expect(document.job?.status).toBe('complete');
		expect(document.job?.ids).toEqual([400, 401, 402]);
		expect(document.job?.completed).toBe(3);
		expect(document.library.games.map((game) => game.tags)).toEqual([
			[],
			['Puzzle'],
			['Puzzle'],
			['Puzzle'],
			[],
		]);
		expect(calls).toBe(3);
		rejectPaidRequests = true;
		await post('classify', {
			steamId: null,
			search: 'portal',
			category: 'unplayed',
			all: true,
		});
		document = await waitForJob();
		expect(document.job?.status).toBe('failed');
		expect(document.job?.completed).toBe(0);
		expect(calls).toBe(6);
		expect(Object.keys(document.requests ?? {})).toHaveLength(3);
		for (const [index, appid] of [400, 401, 402].entries())
			expect(
				document.requests?.[`${document.job?.id}:${index}`]?.flight?.appid,
			).toBe(appid);
		expect(document.library.games.map((game) => game.tags)).toEqual([
			[],
			['Puzzle'],
			['Puzzle'],
			['Puzzle'],
			[],
		]);
		await post('classify/recover', { confirm: true });
	} finally {
		await runtime.dispose();
	}
}, 30_000);
