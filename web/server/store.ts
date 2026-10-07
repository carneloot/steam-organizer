import { Effect, Schema } from 'effect';

import {
	CategoryCriteria,
	defaultCategoryCriteria,
} from '../../src/domain/classification.js';
import {
	AppId,
	Category,
	Library,
	emptyLibrary,
} from '../../src/domain/library.js';
import { Job } from '../shared.js';
import { HttpError } from './security.js';

const Flight = Schema.Struct({ requestId: Schema.String, appid: AppId });
export const Document = Schema.Struct({
	library: Library,
	job: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				...Job.fields,
				ids: Schema.Array(AppId),
				criteria: CategoryCriteria,
				steamId: Library.fields.steamId,
				cancel: Schema.Boolean,
			}),
		),
	),
	criteriaBySteamId: Schema.optionalKey(
		Schema.Record(Schema.String, CategoryCriteria),
	),
	operation: Schema.NullOr(
		Schema.Struct({ id: Schema.String, expiresAt: Schema.Finite }),
	),
	flight: Schema.NullOr(Flight),
	result: Schema.NullOr(
		Schema.Struct({ ...Flight.fields, tags: Schema.Array(Category) }),
	),
	completed: Schema.NullOr(Flight),
});
export type Document = typeof Document.Type;
export const initial = (): Document => ({
	library: emptyLibrary(),
	operation: null,
	flight: null,
	result: null,
	completed: null,
});
export const savedCriteria = (state: Document) =>
	state.criteriaBySteamId?.[state.library.steamId ?? 'offline'] ??
	defaultCategoryCriteria;
export class Store {
	constructor(
		private db: D1Database,
		private owner: string,
	) {}
	load = Effect.fn('Store.load')(() =>
		Effect.tryPromise(async () => {
			await this.db
				.prepare(
					'INSERT OR IGNORE INTO organizer_state(owner,document) VALUES(?,?)',
				)
				.bind(this.owner, JSON.stringify(initial()))
				.run();
			const row = await this.db
				.prepare('SELECT revision,document FROM organizer_state WHERE owner=?')
				.bind(this.owner)
				.first<{ revision: number; document: string }>();
			if (!row) throw new Error('Missing state');
			return {
				revision: row.revision,
				state: Schema.decodeUnknownSync(Document)(JSON.parse(row.document)),
			};
		}),
	);
	modify = Effect.fn('Store.modify')((update: (state: Document) => Document) =>
		Effect.gen({ self: this }, function* () {
			for (let attempt = 0; attempt < 20; attempt++) {
				const { revision, state } = yield* this.load();
				const next = yield* Effect.try({
					try: () => update(state),
					catch: (error) =>
						error instanceof HttpError
							? error
							: new HttpError(500, 'State update failed.'),
				});
				const result = yield* Effect.tryPromise(() =>
					this.db
						.prepare(
							'UPDATE organizer_state SET document=?,revision=revision+1 WHERE owner=? AND revision=?',
						)
						.bind(JSON.stringify(next), this.owner, revision)
						.run(),
				);
				if (result.meta.changes === 1) return next;
			}
			return yield* Effect.fail(
				new HttpError(409, 'Concurrent update. Try again.'),
			);
		}),
	);
}
