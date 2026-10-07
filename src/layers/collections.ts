import { Effect, Layer, Schema } from 'effect';

import {
	CategoryCriteria,
	defaultCategoryCriteria,
} from '../domain/classification.js';
import { Category } from '../domain/library.js';
import {
	Collections,
	CollectionsDecodeError,
	NoActiveCollectionsError,
} from '../services/collections.js';

export const CollectionsLayer = Layer.sync(Collections, () =>
	Collections.of({ extractCategoryCriteria }),
);

const CloudStorage = Schema.Array(
	Schema.Tuple([Schema.String, Schema.Unknown]),
);
const CloudRecord = Schema.Struct({
	is_deleted: Schema.optionalKey(Schema.Boolean),
	value: Schema.optionalKey(Schema.Unknown),
});
const Collection = Schema.Struct({ name: Schema.String }).pipe(
	Schema.fromJsonString,
);

const extractCategoryCriteria = Effect.fn(
	'Collections.extractCategoryCriteria',
)(function* (input: string) {
	const entries = yield* Schema.decodeUnknownEffect(
		CloudStorage.pipe(Schema.fromJsonString),
	)(input).pipe(
		Effect.mapError(
			() =>
				new CollectionsDecodeError({
					message:
						'Invalid Steam collections file. Expected a cloud-storage-namespace JSON array of [key, record] pairs.',
				}),
		),
	);
	const names = new Set<string>();
	for (const [key, value] of entries) {
		if (!key.startsWith('user-collections.')) continue;
		const record = yield* Schema.decodeUnknownEffect(CloudRecord)(value).pipe(
			Effect.mapError(
				() =>
					new CollectionsDecodeError({
						message: `Invalid Steam collection record ${key}.`,
					}),
			),
		);
		if (
			record.is_deleted ||
			record.value === undefined ||
			record.value === null ||
			record.value === ''
		)
			continue;
		const collection = yield* Schema.decodeUnknownEffect(Collection)(
			record.value,
		).pipe(
			Effect.mapError(
				() =>
					new CollectionsDecodeError({
						message: `Invalid Steam collection value ${key}. Expected a JSON string containing a collection name.`,
					}),
			),
		);
		const name = yield* Schema.decodeUnknownEffect(Category)(
			collection.name.trim(),
		).pipe(
			Effect.mapError(
				() =>
					new CollectionsDecodeError({
						message: `Invalid name in Steam collection ${key}. Names must be nonempty and cannot contain control characters.`,
					}),
			),
		);
		names.add(name);
	}
	if (names.size === 0) {
		return yield* new NoActiveCollectionsError({
			message:
				'No active collections found. Choose the cloud-storage-namespace file containing your user-collections records.',
		});
	}
	const defaults = new Map(Object.entries(defaultCategoryCriteria));
	return yield* Schema.decodeUnknownEffect(CategoryCriteria)(
		Object.fromEntries(
			[...names]
				.sort()
				.map((name) => [
					name,
					defaults.get(name) ?? `Games matching the category "${name}".`,
				]),
		),
	).pipe(
		Effect.mapError(
			() =>
				new CollectionsDecodeError({
					message: 'Cannot convert Steam collections to category criteria.',
				}),
		),
	);
});
