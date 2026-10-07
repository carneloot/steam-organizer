import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';

import {
	categories,
	emptyLibrary,
	exportLibrary,
	Game,
	mergeLibrary,
	selectGames,
	terminalText,
} from '../domain/library.js';
import type { Library } from '../domain/library.js';
import { LibraryService } from '../services/library.js';
import { LibraryLayer } from './library.js';

const decodeImport = (input: string) =>
	Effect.flatMap(LibraryService, (library) => library.decodeImport(input)).pipe(
		Effect.provide(LibraryLayer),
	);
const updateGame = (
	library: Library,
	appid: number,
	update: (game: Game) => Game,
) =>
	Effect.flatMap(LibraryService, (service) =>
		service.updateGame(library, appid, update),
	).pipe(Effect.provide(LibraryLayer));

const game = (minutes: number, recent = 0): Game => ({
	appid: 620,
	name: 'Portal 2',
	playtime_forever: minutes,
	playtime_2weeks: recent,
	tags: [],
	reviewed: false,
});

describe('library', () => {
	it.each([
		[0, 'Unplayed'],
		[1, 'Sampled'],
		[119, 'Sampled'],
		[120, 'Played'],
		[7200, 'Played'],
	])(
		'categorizes %i minutes as %s, never inferring completion',
		(minutes, expected) => {
			assert.deepStrictEqual(categories(game(Number(minutes))), [expected]);
		},
	);

	it('adds recent activity only for positive playtime and deduplicates tags', () => {
		assert.deepStrictEqual(categories(game(120, 0)), ['Played']);
		assert.deepStrictEqual(
			categories({ ...game(120, 1), tags: ['Co-op', 'Played'] }),
			['Played', 'Recently played', 'Co-op'],
		);
	});

	it.effect('imports both documented JSON formats', () =>
		Effect.gen(function* () {
			const input = [{ appid: 620, name: 'Portal 2', playtime_forever: 87 }];
			assert.deepStrictEqual(yield* decodeImport(JSON.stringify(input)), input);
			assert.deepStrictEqual(
				yield* decodeImport(
					JSON.stringify({ response: { game_count: 1, games: input } }),
				),
				input,
			);
			assert.deepStrictEqual(
				yield* decodeImport('{"response":{"game_count":0}}'),
				[],
			);
		}),
	);

	it.effect.each([
		'not json',
		'{"response":{}}',
		'{"response":{"game_count":2,"games":[]}}',
		'[{"appid":620,"name":"Portal","playtime_forever":-1}]',
		'[{"appid":620,"name":"Portal","playtime_forever":1.5}]',
		'[{"appid":0,"name":"Portal","playtime_forever":0}]',
		'[{"appid":620,"name":"Portal","playtime_forever":0},{"appid":620,"name":"Duplicate","playtime_forever":5}]',
	])('rejects malformed or unavailable imports %#', (input) =>
		Effect.gen(function* () {
			const error = yield* decodeImport(input).pipe(Effect.flip);
			assert.strictEqual(error._tag, 'AppError');
		}),
	);

	it("refreshes metadata by app ID while retaining only matching games' decisions", () => {
		const previous = {
			...emptyLibrary(),
			games: [
				{ ...game(87), tags: ['Completed'], reviewed: true },
				{ ...game(0), appid: 99, tags: ['Dropped'] },
			],
		};
		const merged = mergeLibrary(
			previous,
			[
				{ appid: 21, name: 'New game', playtime_forever: 0 },
				{ appid: 620, name: 'Portal renamed', playtime_forever: 150 },
			],
			'76561198000000000',
		);
		assert.deepStrictEqual(merged.games, [
			{
				appid: 21,
				name: 'New game',
				playtime_forever: 0,
				tags: [],
				reviewed: false,
			},
			{
				appid: 620,
				name: 'Portal renamed',
				playtime_forever: 150,
				tags: ['Completed'],
				reviewed: true,
			},
		]);
		assert.strictEqual(merged.steamId, '76561198000000000');
	});

	it('combines search, category and review filters without mutating source order', () => {
		const library = {
			...emptyLibrary(),
			games: [
				{ ...game(0), appid: 2, name: 'Portal B', tags: ['Backlog'] },
				{
					...game(0),
					appid: 3,
					name: 'Portal C',
					tags: ['Backlog'],
					reviewed: true,
				},
				{ ...game(0), appid: 1, name: 'Portal A', tags: ['Favorites'] },
			],
		};
		assert.deepStrictEqual(
			selectGames(library, 'PORTAL', 'backlog', true).map((game) => game.appid),
			[2],
		);
		assert.deepStrictEqual(
			selectGames(library, '', 'Unplayed').map((game) => game.appid),
			[1, 2, 3],
		);
		assert.deepStrictEqual(
			library.games.map((game) => game.appid),
			[2, 3, 1],
		);
	});

	it.effect('rejects unknown game IDs instead of silently succeeding', () =>
		Effect.gen(function* () {
			const error = yield* updateGame(emptyLibrary(), 620, (game) => game).pipe(
				Effect.flip,
			);
			assert.include(error.message, 'No game with app ID 620');
		}),
	);

	it.effect('exports exact CSV escaping and JSON data', () =>
		Effect.gen(function* () {
			const library = {
				...emptyLibrary(),
				games: [
					{ ...game(75), name: 'Game, "Deluxe"\nEdition', tags: ['Co-op'] },
				],
			};
			assert.strictEqual(
				exportLibrary(library, 'csv'),
				'appid,name,playtime_minutes,categories,tags,reviewed\n"620","Game, ""Deluxe""\nEdition","75","Sampled; Co-op","Co-op","false"',
			);
			const json = yield* Schema.decodeUnknownEffect(
				Schema.Unknown.pipe(Schema.fromJsonString),
			)(exportLibrary(library, 'json'));
			assert.deepStrictEqual(json, {
				...library,
				games: [{ ...library.games[0], categories: ['Sampled', 'Co-op'] }],
			});
		}),
	);

	it('removes terminal control characters from displayed game titles', () => {
		assert.strictEqual(terminalText('Portal\x1b[2J\n2'), 'Portal [2J 2');
	});
});
