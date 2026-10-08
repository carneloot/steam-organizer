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
const PaidState = Schema.Struct({
	operation: Schema.NullOr(
		Schema.Struct({ id: Schema.String, expiresAt: Schema.Finite }),
	),
	flight: Schema.NullOr(Flight),
	result: Schema.NullOr(
		Schema.Struct({ ...Flight.fields, tags: Schema.Array(Category) }),
	),
	completed: Schema.NullOr(Flight),
});
export type PaidState = typeof PaidState.Type;
export const Document = Schema.Struct({
	library: Library,
	requests: Schema.optionalKey(Schema.Record(Schema.String, PaidState)),
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
	...PaidState.fields,
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

// Each row starts with its table's owner-local primary key.
function tables(state: Document) {
	return {
		library_games: {
			columns: [
				'appid',
				'position',
				'name',
				'playtime_forever',
				'playtime_2weeks',
				'tags',
				'reviewed',
			],
			rows: state.library.games.map((game, position) => [
				game.appid,
				position,
				game.name,
				game.playtime_forever,
				game.playtime_2weeks ?? null,
				JSON.stringify(game.tags),
				Number(game.reviewed),
			]),
		},
		category_criteria: {
			columns: ['steam_id', 'criteria'],
			rows: Object.entries(state.criteriaBySteamId ?? {}).map(
				([id, criteria]) => [id, JSON.stringify(criteria)],
			),
		},
		classification_jobs: {
			columns: [
				'id',
				'status',
				'total',
				'completed',
				'current',
				'error',
				'steam_id',
				'ids',
				'criteria',
				'cancel',
			],
			rows: state.job
				? [
						[
							state.job.id,
							state.job.status,
							state.job.total,
							state.job.completed,
							state.job.current,
							state.job.error,
							state.job.steamId,
							JSON.stringify(state.job.ids),
							JSON.stringify(state.job.criteria),
							Number(state.job.cancel),
						],
					]
				: [],
		},
		classification_requests: {
			columns: ['request_id', 'operation', 'flight', 'result', 'completed'],
			rows: Object.entries(state.requests ?? {}).map(([id, request]) => [
				id,
				JSON.stringify(request.operation),
				JSON.stringify(request.flight),
				JSON.stringify(request.result),
				JSON.stringify(request.completed),
			]),
		},
	};
}

export class Store {
	constructor(
		private db: D1Database,
		private owner: string,
	) {}
	load = Effect.fn('Store.load')(() =>
		Effect.gen({ self: this }, function* () {
			const snapshot: unknown = yield* Effect.tryPromise(async () => {
				await this.db
					.prepare('INSERT OR IGNORE INTO libraries(owner) VALUES(?)')
					.bind(this.owner)
					.run();
				// A batch gives all tables the same transactional snapshot.
				const [metadata, games, criteria, jobs, requests] =
					await this.db.batch<{
						revision: number;
						document: string;
						key: string;
					}>(
						[
							`SELECT revision, json_object(
						'version', version, 'steamId', steam_id,
						'jobPresent', job_present, 'criteriaPresent', criteria_present,
						'requestsPresent', requests_present, 'operation', json(operation),
						'flight', json(flight), 'result', json(result), 'completed', json(completed)
					) AS document FROM libraries WHERE owner=?`,
							`SELECT json_patch(json_object(
						'appid', appid, 'name', name, 'playtime_forever', playtime_forever,
						'tags', json(tags), 'reviewed', json(CASE reviewed WHEN 1 THEN 'true' ELSE 'false' END)
					), CASE WHEN playtime_2weeks IS NULL THEN '{}' ELSE
						json_object('playtime_2weeks', playtime_2weeks) END) AS document
					FROM library_games WHERE owner=? ORDER BY position`,
							'SELECT steam_id AS key, criteria AS document FROM category_criteria WHERE owner=?',
							`SELECT json_object('id', id, 'status', status, 'total', total,
						'completed', completed, 'current', current, 'error', error,
						'steamId', steam_id, 'ids', json(ids), 'criteria', json(criteria),
						'cancel', json(CASE cancel WHEN 1 THEN 'true' ELSE 'false' END)
					) AS document FROM classification_jobs WHERE owner=?`,
							`SELECT request_id AS key, json_object('operation', json(operation),
						'flight', json(flight), 'result', json(result), 'completed', json(completed)
					) AS document FROM classification_requests WHERE owner=?`,
						].map((sql) => this.db.prepare(sql).bind(this.owner)),
					);
				const row = metadata?.results[0];
				if (!row || !games || !criteria || !jobs || !requests)
					throw new Error('Missing state');
				const meta = JSON.parse(row.document);
				return {
					revision: row.revision,
					state: {
						library: {
							version: meta.version,
							steamId: meta.steamId,
							games: games.results.map((game) => JSON.parse(game.document)),
						},
						operation: meta.operation,
						flight: meta.flight,
						result: meta.result,
						completed: meta.completed,
						...(meta.jobPresent
							? {
									job: jobs.results[0]
										? JSON.parse(jobs.results[0].document)
										: null,
								}
							: {}),
						...(meta.criteriaPresent
							? {
									criteriaBySteamId: Object.fromEntries(
										criteria.results.map((row) => [
											row.key,
											JSON.parse(row.document),
										]),
									),
								}
							: {}),
						...(meta.requestsPresent
							? {
									requests: Object.fromEntries(
										requests.results.map((row) => [
											row.key,
											JSON.parse(row.document),
										]),
									),
								}
							: {}),
					},
				};
			});
			return yield* Schema.decodeUnknownEffect(
				Schema.Struct({ revision: Schema.Natural, state: Document }),
			)(snapshot);
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
				const results = yield* Effect.tryPromise(async () => {
					const statements: D1PreparedStatement[] = [];
					const previous = tables(state);
					const current = tables(next);
					const guard =
						'EXISTS (SELECT 1 FROM libraries WHERE owner=? AND revision=?)';
					for (const name of [
						'library_games',
						'category_criteria',
						'classification_jobs',
						'classification_requests',
					] as const) {
						const table = current[name];
						const before = new Map(
							previous[name].rows.map((row) => [row[0], JSON.stringify(row)]),
						);
						const after = new Map(table.rows.map((row) => [row[0], row]));
						const removed = [...before.keys()].filter((key) => !after.has(key));
						const changed = table.rows.filter(
							(row) => before.get(row[0]) !== JSON.stringify(row),
						);
						const key =
							name === 'classification_jobs' ? 'owner' : table.columns[0];
						if (removed.length)
							statements.push(
								this.db
									.prepare(
										`DELETE FROM ${name} WHERE owner=? AND ${table.columns[0]} IN (SELECT value FROM json_each(?)) AND ${guard}`,
									)
									.bind(
										this.owner,
										JSON.stringify(removed),
										this.owner,
										revision,
									),
							);
						// Bulk changes use one bound JSON array, avoiding D1's parameter limit on large imports.
						if (changed.length)
							statements.push(
								this.db
									.prepare(
										`INSERT INTO ${name}(owner,${table.columns.join(',')})
							SELECT ?,${table.columns.map((_, i) => `json_extract(value,'$[${i}]')`).join(',')}
							FROM json_each(?) WHERE ${guard}
							ON CONFLICT(${key === 'owner' ? 'owner' : `owner,${key}`}) DO UPDATE SET
							${table.columns.map((column) => `${column}=excluded.${column}`).join(',')}`,
									)
									.bind(
										this.owner,
										JSON.stringify(changed),
										this.owner,
										revision,
									),
							);
					}
					// Advance the revision last. Every preceding write has the same CAS guard,
					// and D1 rolls back the entire batch if any statement fails.
					statements.push(
						this.db
							.prepare(`UPDATE libraries SET revision=revision+1,
						version=?,steam_id=?,job_present=?,criteria_present=?,requests_present=?,
						operation=?,flight=?,result=?,completed=? WHERE owner=? AND revision=?`)
							.bind(
								next.library.version,
								next.library.steamId,
								Number(next.job !== undefined),
								Number(next.criteriaBySteamId !== undefined),
								Number(next.requests !== undefined),
								JSON.stringify(next.operation),
								JSON.stringify(next.flight),
								JSON.stringify(next.result),
								JSON.stringify(next.completed),
								this.owner,
								revision,
							),
					);
					return this.db.batch(statements);
				});
				if (results.at(-1)?.meta.changes === 1) return next;
			}
			return yield* Effect.fail(
				new HttpError(409, 'Concurrent update. Try again.'),
			);
		}),
	);
}
