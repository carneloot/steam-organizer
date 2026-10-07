import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';

import { CategoryCriteria, defaultCategoryCriteria } from './classification.js';

describe('CategoryCriteria boundary', () => {
	it.effect.each([
		{},
		{ '': 'Some description' },
		{ ' Untrimmed': 'Description' },
		{ 'Bad\nname': 'Description' },
		{ Valid: '' },
		{ Valid: '   ' },
	])('rejects invalid category criteria: %s', (criteria) =>
		Effect.gen(function* () {
			const error = yield* Schema.decodeUnknownEffect(CategoryCriteria)(
				criteria,
			).pipe(Effect.flip);
			assert.strictEqual(error._tag, 'SchemaError');
		}),
	);
	it.effect('validates built-in criteria', () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(
				yield* Schema.decodeEffect(CategoryCriteria)(defaultCategoryCriteria),
				defaultCategoryCriteria,
			);
		}),
	);
});
