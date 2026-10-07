import { Schema } from 'effect';

import { AppId, Category, type Library } from '../../src/domain/library.js';

const Entries = Schema.Array(Schema.Tuple([Schema.String, Schema.Unknown]));
const Record = Schema.Struct({
	is_deleted: Schema.optionalKey(Schema.Boolean),
	value: Schema.optionalKey(Schema.Unknown),
});
const Collection = Schema.Struct({
	name: Schema.String,
	added: Schema.optionalKey(Schema.Array(AppId)),
	removed: Schema.optionalKey(Schema.Array(AppId)),
	filterSpec: Schema.optionalKey(Schema.Unknown),
});
export interface Membership {
	name: string;
	appids: ReadonlyArray<number>;
}
// Dynamic filter collections are excluded: their predicates cannot be reconstructed as static membership.
export function parseCollections(text: string): ReadonlyArray<Membership> {
	const entries = Schema.decodeUnknownSync(Entries)(JSON.parse(text));
	const memberships: Membership[] = [];
	for (const [key, value] of entries) {
		if (!key.startsWith('user-collections.')) continue;
		const record = Schema.decodeUnknownSync(Record)(value);
		if (record.is_deleted) continue;
		if (typeof record.value !== 'string')
			throw new Error('Missing collection value');
		const collection = Schema.decodeUnknownSync(Collection)(
			JSON.parse(record.value),
		);
		const name = Schema.decodeUnknownSync(Category)(collection.name.trim());
		if (collection.filterSpec !== undefined && collection.filterSpec !== null)
			continue;
		const removed = new Set(collection.removed ?? []);
		memberships.push({
			name,
			appids: [...new Set(collection.added ?? [])].filter(
				(id) => !removed.has(id),
			),
		});
	}
	return memberships;
}
export function attachCollections(
	library: Library,
	memberships: ReadonlyArray<Membership>,
): Library {
	return {
		...library,
		games: library.games.map((game) => ({
			...game,
			tags: [
				...new Set([
					...game.tags,
					...memberships
						.filter((m) => m.appids.includes(game.appid))
						.map((m) => m.name),
				]),
			],
		})),
	};
}
