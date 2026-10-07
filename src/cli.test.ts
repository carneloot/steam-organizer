import { assert, describe, it } from '@effect/vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CLI integration', () => {
	it('classifies without prompts, preserves tags, resumes after failure and supports filters and --all', () => {
		const directory = mkdtempSync(join(tmpdir(), 'steam-jev-cli-'));
		const file = join(directory, 'library.json');
		const mock = join(directory, 'mock-jev.mjs');
		const initial = {
			version: 1,
			steamId: null,
			games: [
				{
					appid: 1,
					name: 'Alpha',
					playtime_forever: 0,
					tags: ['Favorites', 'Puzzle'],
					reviewed: false,
				},
				{
					appid: 2,
					name: 'Beta',
					playtime_forever: 123,
					tags: [],
					reviewed: false,
				},
				{
					appid: 3,
					name: 'Gamma',
					playtime_forever: 60,
					tags: ['Completed'],
					reviewed: true,
				},
			],
		};
		const run = (fail: string, ...args: string[]) =>
			spawnSync(
				process.execPath,
				[
					'--import',
					mock,
					'--import',
					'tsx',
					'src/cli.ts',
					'--file',
					file,
					...args,
				],
				{
					encoding: 'utf8',
					timeout: 10_000,
					env: {
						...process.env,
						TYPESAFE_API_KEY: 'test-key',
						MOCK_FAIL: fail,
					},
				},
			);
		try {
			writeFileSync(file, JSON.stringify(initial));
			writeFileSync(
				mock,
				`
				globalThis.fetch = async (input, init) => {
					const request = new Request(input, init);
					if (request.url !== 'https://api.typesafe.ai/v1/systemone') throw new Error('Unexpected endpoint');
					const payload = await request.json();
					if (String(payload.state.appid) === process.env.MOCK_FAIL || process.env.MOCK_FAIL === 'all') return Response.json({}, { status: 401 });
					return Response.json({ answers: Object.fromEntries(Object.keys(payload.questions).map(tag => [tag, { type: 'noul', noul: ['Puzzle', 'Co-op'].includes(tag) ? 0.95 : 0.1 }])) });
				};
			`,
			);
			const failed = run('2', 'classify');
			assert.strictEqual(failed.status, 1, failed.stderr);
			assert.include(failed.stdout + failed.stderr, 'HTTP 401');
			const partial = JSON.parse(readFileSync(file, 'utf8'));
			assert.deepStrictEqual(partial.games[0], {
				...initial.games[0],
				tags: ['Favorites', 'Puzzle', 'Co-op'],
				reviewed: true,
			});
			assert.deepStrictEqual(partial.games[1], initial.games[1]);
			assert.deepStrictEqual(partial.games[2], initial.games[2]);
			const resumed = run('1', 'review', '--category', 'Played');
			assert.strictEqual(resumed.status, 0, resumed.stderr);
			assert.include(resumed.stdout, 'Classified 1 games');
			const saved = readFileSync(file, 'utf8');
			assert.deepStrictEqual(JSON.parse(saved).games[1], {
				...initial.games[1],
				tags: ['Puzzle', 'Co-op'],
				reviewed: true,
			});
			const skipped = run('all', 'classify');
			assert.strictEqual(skipped.status, 0, skipped.stderr);
			assert.include(skipped.stdout, 'Classified 0 games');
			assert.strictEqual(readFileSync(file, 'utf8'), saved);
			const revisit = run(
				'2',
				'classify',
				'--all',
				'--search',
				'ALPHA',
				'--category',
				'Favorites',
			);
			assert.strictEqual(revisit.status, 0, revisit.stderr);
			assert.include(revisit.stdout, 'Classified 1 games');
			assert.strictEqual(readFileSync(file, 'utf8'), saved);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);

	it('imports, tags, filters, refreshes, exports and untags in separate processes', () => {
		const directory = mkdtempSync(join(tmpdir(), 'steam-cli-'));
		const file = join(directory, 'library.json');
		const run = (...args: ReadonlyArray<string>) => {
			const result = spawnSync(
				process.execPath,
				['--import', 'tsx', 'src/cli.ts', '--file', file, ...args],
				{
					encoding: 'utf8',
					timeout: 10_000,
				},
			);
			assert.strictEqual(result.status, 0, result.stderr);
			return result.stdout;
		};
		try {
			assert.include(run('import', 'examples/games.json'), 'Imported 4 games');
			run('tag', '620', 'Co-op', 'Favorites', 'Co-op');
			const tagged = run(
				'list',
				'--category',
				'favorites',
				'--search',
				'PORTAL',
				'--json',
			);
			assert.deepStrictEqual(
				JSON.parse(tagged).map((game: { appid: number; tags: string[] }) => ({
					appid: game.appid,
					tags: game.tags,
				})),
				[{ appid: 620, tags: ['Co-op', 'Favorites'] }],
			);
			run('import', 'examples/games.json');
			assert.include(run('list', '--category', 'Favorites'), 'Portal 2');
			assert.include(run('categories'), 'Favorites\t1');
			assert.deepStrictEqual(
				JSON.parse(run('export')).games.find(
					(game: { appid: number }) => game.appid === 620,
				).tags,
				['Co-op', 'Favorites'],
			);
			assert.include(run('export', '--format', 'csv'), '"Co-op; Favorites"');
			run('untag', '620', 'Favorites');
			assert.strictEqual(
				run('list', '--category', 'Favorites', '--json').trim(),
				'[]',
			);
			const before = readFileSync(file, 'utf8');
			const failure = spawnSync(
				process.execPath,
				[
					'--import',
					'tsx',
					'src/cli.ts',
					'--file',
					file,
					'tag',
					'999',
					'Favorites',
				],
				{ encoding: 'utf8' },
			);
			assert.strictEqual(failure.status, 1);
			assert.include(
				failure.stdout + failure.stderr,
				'No game with app ID 999',
			);
			assert.strictEqual(readFileSync(file, 'utf8'), before);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
