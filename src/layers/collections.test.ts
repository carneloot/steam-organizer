import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';

import { CategoryCriteria } from '../domain/classification.js';
import { Collections } from '../services/collections.js';
import { CollectionsLayer } from './collections.js';

const extractCategoryCriteria = (input: string) =>
	Effect.flatMap(Collections, (collections) =>
		collections.extractCategoryCriteria(input),
	).pipe(Effect.provide(CollectionsLayer));

describe('Steam collection extraction', () => {
	it.effect(
		'extracts static and dynamic names, trims and deduplicates them, and ignores unrelated or deleted records',
		() =>
			Effect.gen(function* () {
				const input = JSON.stringify([
					[
						'user-collections.uc-1',
						{
							value: JSON.stringify({
								id: 'uc-1',
								name: ' Puzzle ',
								added: [620],
								removed: [],
							}),
							version: '123',
						},
					],
					[
						'user-collections.uc-2',
						{
							value: JSON.stringify({
								name: 'Cozy farming',
								filterSpec: { tags: [492] },
							}),
						},
					],
					[
						'user-collections.uc-duplicate',
						{ value: JSON.stringify({ name: 'Puzzle' }) },
					],
					[
						'user-collections.uc-deleted',
						{ is_deleted: true, value: 'not JSON' },
					],
					['user-collections.uc-empty', {}],
					['user-collections.uc-null', { value: null }],
					['user-collections.uc-blank', { value: '' }],
					['unrelated.setting', 'not a collection record'],
					[
						'user-collections.uc-special',
						{ value: JSON.stringify({ name: 'Ação "co-op"' }) },
					],
					[
						'user-collections.uc-prototype',
						{ value: JSON.stringify({ name: 'constructor' }) },
					],
				]);
				const criteria = yield* extractCategoryCriteria(input);
				assert.deepStrictEqual(criteria, {
					'Ação "co-op"': 'Games matching the category "Ação "co-op"".',
					'Cozy farming': 'Games matching the category "Cozy farming".',
					Puzzle: 'Solving logical or spatial puzzles is a central mechanic.',
					constructor: 'Games matching the category "constructor".',
				});
				assert.deepStrictEqual(Object.keys(criteria), [
					'Ação "co-op"',
					'Cozy farming',
					'Puzzle',
					'constructor',
				]);
				assert.deepStrictEqual(
					yield* Schema.decodeUnknownEffect(CategoryCriteria)(criteria),
					criteria,
				);
			}),
	);

	it.effect.each([
		{ input: 'not JSON', expected: 'Invalid Steam collections file' },
		{ input: '{}', expected: 'Invalid Steam collections file' },
		{ input: '[[1, "798"]]', expected: 'Invalid Steam collections file' },
		{ input: '[]', expected: 'No active collections' },
		{
			input: JSON.stringify([['settings', {}]]),
			expected: 'No active collections',
		},
		{
			input: JSON.stringify([
				['user-collections.deleted', { is_deleted: true }],
			]),
			expected: 'No active collections',
		},
		{
			input: JSON.stringify([['user-collections.bad', 123]]),
			expected: 'Invalid Steam collection record',
		},
		{
			input: JSON.stringify([['user-collections.bad', { value: 'not JSON' }]]),
			expected: 'Invalid Steam collection value',
		},
		{
			input: JSON.stringify([
				['user-collections.bad', { value: { name: 'Puzzle' } }],
			]),
			expected: 'Invalid Steam collection value',
		},
		{
			input: JSON.stringify([
				['user-collections.bad', { value: '{"name":123}' }],
			]),
			expected: 'Invalid Steam collection value',
		},
		{
			input: JSON.stringify([
				['user-collections.bad', { value: '{"name":"   "}' }],
			]),
			expected: 'Invalid name',
		},
		{
			input: JSON.stringify([
				[
					'user-collections.bad',
					{ value: JSON.stringify({ name: 'Bad\nname' }) },
				],
			]),
			expected: 'Invalid name',
		},
	])('rejects malformed or empty input: $expected', ({ input, expected }) =>
		Effect.gen(function* () {
			const error = yield* extractCategoryCriteria(input).pipe(Effect.flip);
			assert.include(error.message, expected);
		}),
	);
});
