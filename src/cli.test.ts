import { assert, describe, it } from '@effect/vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CLI integration', () => {
	it('extracts a Steam collections file into a usable categories config without modifying source or library', () => {
		const directory = mkdtempSync(join(tmpdir(), 'steam-collections-cli-'));
		const input = join(directory, 'cloud storage namespace.json');
		const output = join(directory, 'categories.json');
		const library = join(directory, 'library.json');
		const run = (...args: string[]) =>
			spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
				encoding: 'utf8',
				timeout: 10_000,
				env: { ...process.env, TYPESAFE_API_KEY: '' },
			});
		try {
			const source = JSON.stringify([
				[
					'user-collections.uc-puzzle',
					{ value: JSON.stringify({ name: 'Puzzle', added: [620] }) },
				],
				[
					'user-collections.uc-custom',
					{ value: JSON.stringify({ name: 'Cozy farming', filterSpec: {} }) },
				],
				[
					'user-collections.deleted',
					{ is_deleted: true, value: JSON.stringify({ name: 'Deleted' }) },
				],
			]);
			writeFileSync(input, source);
			writeFileSync(library, 'Must not be read or overwritten');
			const extracted = run('--file', library, 'extract-categories', input);
			assert.strictEqual(extracted.status, 0, extracted.stderr);
			assert.deepStrictEqual(JSON.parse(extracted.stdout), {
				'Cozy farming': 'Games matching the category "Cozy farming".',
				Puzzle: 'Solving logical or spatial puzzles is a central mechanic.',
			});
			assert.include(extracted.stderr, 'Extracted 2 categories');
			assert.strictEqual(readFileSync(input, 'utf8'), source);
			assert.strictEqual(
				readFileSync(library, 'utf8'),
				'Must not be read or overwritten',
			);
			writeFileSync(output, extracted.stdout);
			const accepted = run(
				'--file',
				join(directory, 'empty-library.json'),
				'classify',
				'--categories-file',
				output,
			);
			assert.strictEqual(accepted.status, 0, accepted.stderr);
			assert.include(accepted.stdout, 'Classified 0 games');
			writeFileSync(
				input,
				JSON.stringify([
					[
						'user-collections.valid',
						{ value: JSON.stringify({ name: 'Puzzle' }) },
					],
					['user-collections.invalid', { value: 'not JSON' }],
				]),
			);
			const invalid = run('extract-categories', input);
			assert.strictEqual(invalid.status, 1, invalid.stderr);
			assert.strictEqual(invalid.stdout, '');
			assert.include(invalid.stderr, 'Invalid Steam collection value');
			const missing = run(
				'extract-categories',
				join(directory, 'missing.json'),
			);
			assert.strictEqual(missing.status, 1, missing.stderr);
			assert.strictEqual(missing.stdout, '');
			assert.include(missing.stderr, 'Cannot read collections');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);

	it('classifies without prompts, preserves tags, resumes after failure and supports filters and --all', () => {
		const directory = mkdtempSync(join(tmpdir(), 'steam-jev-cli-'));
		const file = join(directory, 'library.json');
		const mock = join(directory, 'mock-jev.mjs');
		const categoriesFile = join(directory, 'categories.json');
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
						API_RATE_LIMIT_DIRECTORY: join(directory, 'rate-limits'),
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
					const url = new URL(request.url);
					if (url.origin === 'https://store.steampowered.com') {
						const appid = url.searchParams.get('appids');
						return Response.json({ [appid]: { success: true, data: { detailed_description: 'Store description for ' + appid } } });
					}
					if (request.url !== 'https://api.typesafe.ai/v1/systemone') throw new Error('Unexpected endpoint');
					const payload = await request.json();
					if (payload.state.description !== 'Store description for ' + payload.state.appid) throw new Error('Missing store description');
					if (payload.questions['Cozy farming']) {
						if (Object.keys(payload.questions).join(',') !== 'Cozy farming,Competitive') throw new Error('Default categories were not replaced');
						if (payload.questions['Cozy farming'].criteria.true !== 'Includes farming and low-pressure play.') throw new Error('Missing custom description');
					}
					if (String(payload.state.appid) === process.env.MOCK_FAIL || process.env.MOCK_FAIL === 'all') return Response.json({}, { status: 401 });
					return Response.json({ answers: Object.fromEntries(Object.keys(payload.questions).map(tag => [tag, { type: 'noul', noul: ['Puzzle', 'Co-op', 'Cozy farming'].includes(tag) ? 0.95 : 0.1 }])) });
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
			writeFileSync(
				categoriesFile,
				JSON.stringify({
					'Cozy farming': 'Includes farming and low-pressure play.',
					Competitive: 'Players compete against each other.',
				}),
			);
			const custom = run(
				'2',
				'review',
				'--all',
				'--search',
				'Alpha',
				'--categories-file',
				categoriesFile,
			);
			assert.strictEqual(custom.status, 0, custom.stderr);
			assert.include(custom.stdout, 'Saved Jev tags: Cozy farming');
			const customized = readFileSync(file, 'utf8');
			const customGames = JSON.parse(customized).games;
			assert.deepStrictEqual(customGames[0].tags, [
				'Favorites',
				'Puzzle',
				'Co-op',
				'Cozy farming',
			]);
			assert.deepStrictEqual(
				customGames.slice(1),
				JSON.parse(saved).games.slice(1),
			);
			for (const contents of [
				'not JSON',
				'{}',
				'[]',
				'{"Cozy":123}',
				'{"Cozy":" "}',
				'{" Bad":"Description"}',
				'{"Bad\\nname":"Description"}',
			]) {
				writeFileSync(categoriesFile, contents);
				const invalid = run(
					'all',
					'classify',
					'--all',
					'--categories-file',
					categoriesFile,
				);
				assert.strictEqual(invalid.status, 1, invalid.stderr);
				assert.include(
					invalid.stdout + invalid.stderr,
					'Invalid categories file',
				);
				assert.strictEqual(readFileSync(file, 'utf8'), customized);
			}
			const missing = run(
				'all',
				'classify',
				'--categories-file',
				join(directory, 'missing.json'),
			);
			assert.strictEqual(missing.status, 1, missing.stderr);
			assert.include(missing.stdout + missing.stderr, 'Cannot read categories');
			assert.strictEqual(readFileSync(file, 'utf8'), customized);
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
