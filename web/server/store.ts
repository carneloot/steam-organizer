import { D1Client } from '@effect/sql-d1';
import { Effect, Schema } from 'effect';
import { type Statement } from 'effect/sql';

import {
	CategoryCriteria,
	defaultCategoryCriteria,
} from '../../src/domain/classification.js';
import {
	AppId,
	Category,
	Game,
	Library,
	emptyLibrary,
	selectGames,
} from '../../src/domain/library.js';
import { ClassifyInput, CriteriaInput, Job, TagsInput } from '../shared.js';
import { HttpError } from './security.js';

const StoredJob = Schema.Struct({
	...Job.fields,
	ids: Schema.Array(AppId),
	criteria: CategoryCriteria,
	steamId: Library.fields.steamId,
	cancel: Schema.Boolean,
});
export type StoredJob = typeof StoredJob.Type;
const PaidRequest = Schema.Struct({
	jobId: Schema.String,
	appid: AppId,
	operationId: Schema.NullOr(Schema.String),
	expiresAt: Schema.NullOr(Schema.Finite),
	tags: Schema.NullOr(Schema.Array(Category)),
	completed: Schema.Boolean,
});
export type PaidRequest = typeof PaidRequest.Type;
const View = Schema.Struct({
	library: Library,
	criteria: CategoryCriteria,
	job: Schema.NullOr(StoredJob),
});
export type View = typeof View.Type;
const LibrarySnapshot = Schema.Struct({
	revision: Schema.Natural,
	library: Library,
});

export const activeJob = (job: StoredJob | null) =>
	job?.status === 'queued' || job?.status === 'running';

const gameJson = (sql: D1Client.D1Client) => sql`json_patch(json_object(
	'appid', g.appid, 'name', g.name, 'playtime_forever', g.playtime_forever,
	'tags', json(g.tags), 'reviewed', json(CASE g.reviewed WHEN 1 THEN 'true' ELSE 'false' END)
), CASE WHEN g.playtime_2weeks IS NULL THEN '{}' ELSE
	json_object('playtime_2weeks', g.playtime_2weeks) END)`;

// These fragments are correlated to the library row. Interpolated values remain parameters.
const idleGuards = (sql: D1Client.D1Client, now: number) => {
	const noActiveJob = sql`NOT EXISTS (SELECT 1 FROM classification_jobs j
		WHERE j.owner=l.owner AND j.status IN ('queued','running'))`;
	const noPendingRequests = sql`NOT EXISTS (SELECT 1 FROM classification_requests r
		WHERE r.owner=l.owner AND r.completed=0)`;
	const noActiveOperations = sql`(l.operation_expires_at IS NULL OR l.operation_expires_at<=${now})
		AND NOT EXISTS (SELECT 1 FROM classification_requests r WHERE r.owner=l.owner
		AND r.completed=0 AND r.operation_expires_at>${now})`;
	return {
		noActiveJob,
		noPendingRequests,
		noActiveOperations,
		idle: sql.and([noActiveJob, noActiveOperations, noPendingRequests]),
	};
};

type Row = { data: string; revision: number };
function librarySnapshot(
	metadata: ReadonlyArray<Row>,
	games: ReadonlyArray<Row>,
): { revision: number; library: unknown } {
	const row = metadata[0];
	return {
		revision: row?.revision ?? 0,
		library: row
			? {
					...JSON.parse(row.data),
					games: games.map((row) => JSON.parse(row.data)),
				}
			: emptyLibrary(),
	};
}

export class Store {
	private layer;
	constructor(
		db: D1Database,
		private owner: string,
	) {
		this.layer = D1Client.layer({ db });
	}

	private query<A, E>(run: (sql: D1Client.D1Client) => Effect.Effect<A, E>) {
		return Effect.flatMap(D1Client.D1Client, run).pipe(
			Effect.provide(this.layer),
		);
	}
	private read<A>(
		schema: Schema.Decoder<A>,
		statement: Statement.Statement<{ data: string }>,
		fallback: A,
	) {
		return statement.pipe(
			Effect.map((rows) => (rows[0] ? JSON.parse(rows[0].data) : fallback)),
			Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		);
	}
	private jobQuery(sql: D1Client.D1Client) {
		return sql<Row>`SELECT json_object('id', id, 'status', status, 'total', total,
			'completed', completed, 'current', current, 'error', error,
			'steamId', steam_id, 'ids', json(ids), 'criteria', json(criteria),
			'cancel', json(CASE cancel WHEN 1 THEN 'true' ELSE 'false' END)
		) AS data FROM classification_jobs WHERE owner=${this.owner}`;
	}
	private ensureLibrary() {
		return this.query(
			(sql) =>
				sql`INSERT OR IGNORE INTO libraries ${sql.insert({ owner: this.owner })}`,
		);
	}
	private libraryQueries(sql: D1Client.D1Client) {
		return [
			sql<Row>`SELECT revision, json_object('version', version, 'steamId', steam_id) AS data
				FROM libraries WHERE owner=${this.owner}`,
			sql<Row>`SELECT ${gameJson(sql)} AS data FROM library_games g
				WHERE g.owner=${this.owner} ORDER BY g.position`,
		] as const;
	}
	private getLibrarySnapshot = Effect.fn('Store.getLibrarySnapshot')(() =>
		this.query((sql) =>
			Effect.gen({ self: this }, function* () {
				const [metadata, games] = yield* sql.batch(this.libraryQueries(sql));
				return yield* Schema.decodeUnknownEffect(LibrarySnapshot)(
					librarySnapshot(metadata, games),
				);
			}),
		),
	);
	getLibrary = Effect.fn('Store.getLibrary')(() =>
		this.getLibrarySnapshot().pipe(Effect.map(({ library }) => library)),
	);
	// Screen responses omit the paid ledger and other accounts' criteria.
	getView = Effect.fn('Store.getView')(() =>
		this.query((sql) =>
			Effect.gen({ self: this }, function* () {
				const [metadata, games, criteria, job] = yield* sql.batch([
					...this.libraryQueries(sql),
					sql<Row>`SELECT criteria AS data FROM category_criteria WHERE owner=${this.owner} AND steam_id=
					COALESCE((SELECT steam_id FROM libraries WHERE owner=${this.owner}),'offline')`,
					this.jobQuery(sql),
				]);
				return yield* Schema.decodeUnknownEffect(View)({
					library: librarySnapshot(metadata, games).library,
					criteria: criteria[0]
						? JSON.parse(criteria[0].data)
						: defaultCategoryCriteria,
					job: job[0] ? JSON.parse(job[0].data) : null,
				});
			}),
		),
	);
	getJob = Effect.fn('Store.getJob')(() =>
		this.query((sql) =>
			this.read(Schema.NullOr(StoredJob), this.jobQuery(sql), null),
		),
	);
	getRequest = Effect.fn('Store.getRequest')((requestId: string) =>
		this.query((sql) =>
			this.read(
				Schema.NullOr(PaidRequest),
				sql<Row>`SELECT json_object('jobId', job_id, 'appid', appid,
				'operationId', operation_id, 'expiresAt', operation_expires_at, 'tags', json(tags),
				'completed', json(CASE completed WHEN 1 THEN 'true' ELSE 'false' END)
			) AS data FROM classification_requests WHERE owner=${this.owner} AND request_id=${requestId}`,
				null,
			),
		),
	);
	getGame = Effect.fn('Store.getGame')((appid: number) =>
		this.query((sql) =>
			this.read(
				Schema.NullOr(
					Schema.Struct({ game: Game, steamId: Library.fields.steamId }),
				),
				sql<Row>`SELECT json_object('game', json(${gameJson(sql)}), 'steamId', l.steam_id) AS data
				FROM library_games g JOIN libraries l ON l.owner=g.owner
				WHERE g.owner=${this.owner} AND g.appid=${appid}`,
				null,
			),
		),
	);

	private checkIdle = Effect.fn('Store.checkIdle')((recovery = false) =>
		this.query((sql) =>
			Effect.gen({ self: this }, function* () {
				const { noActiveJob, noActiveOperations, noPendingRequests } =
					idleGuards(sql, Date.now());
				const [flags] = yield* sql<{
					job: number;
					operation: number;
					pending: number;
				}>`SELECT
				NOT (${noActiveJob}) AS job, NOT (${noActiveOperations}) AS operation,
				NOT (${noPendingRequests}) AS pending FROM libraries l WHERE l.owner=${this.owner}`;
				if (flags?.job)
					return yield* Effect.fail(
						new HttpError(409, 'A classification job is active.'),
					);
				if (flags?.operation)
					return yield* Effect.fail(
						new HttpError(409, 'An operation is active.'),
					);
				if (flags?.pending && !recovery)
					return yield* Effect.fail(
						new HttpError(
							409,
							'Paid outcome uncertain. Confirm recovery before continuing.',
						),
					);
			}),
		),
	);
	claimLibrary = Effect.fn('Store.claimLibrary')((operationId: string) =>
		this.query((sql) =>
			Effect.gen({ self: this }, function* () {
				yield* this.ensureLibrary();
				for (let attempt = 0; attempt < 20; attempt++) {
					yield* this.checkIdle();
					const snapshot = yield* this.getLibrarySnapshot();
					const now = Date.now();
					const { idle } = idleGuards(sql, now);
					const result = yield* sql`UPDATE libraries AS l
					SET operation_id=${operationId}, operation_expires_at=${now + 120_000}
					WHERE l.owner=${this.owner} AND ${idle} AND l.revision=${snapshot.revision}
					RETURNING owner`;
					if (result.length === 1) return snapshot;
				}
				return yield* Effect.fail(
					new HttpError(409, 'Concurrent library update. Try again.'),
				);
			}),
		),
	);
	releaseLibrary = Effect.fn('Store.releaseLibrary')((operationId: string) =>
		this.query(
			(
				sql,
			) => sql`UPDATE libraries SET operation_id=NULL, operation_expires_at=NULL
			WHERE owner=${this.owner} AND operation_id=${operationId}`,
		).pipe(Effect.asVoid),
	);
	replaceLibrary = Effect.fn('Store.replaceLibrary')(
		(library: Library, operationId: string, revision: number) =>
			this.query((sql) =>
				Effect.gen({ self: this }, function* () {
					const now = Date.now();
					const { noActiveJob, noPendingRequests } = idleGuards(sql, now);
					const guard = sql`EXISTS (SELECT 1 FROM libraries l
					WHERE l.owner=${this.owner} AND l.operation_id=${operationId}
					AND l.revision=${revision} AND l.operation_expires_at>${now}
					AND ${noActiveJob} AND ${noPendingRequests})`;
					const results = yield* sql.batch([
						sql`DELETE FROM library_games WHERE owner=${this.owner} AND ${guard}`,
						// One JSON parameter avoids D1's bound-parameter limit on large imports.
						sql`INSERT INTO library_games(owner,appid,position,name,playtime_forever,playtime_2weeks,tags,reviewed)
						SELECT ${this.owner},json_extract(value,'$.appid'),key,json_extract(value,'$.name'),
						json_extract(value,'$.playtime_forever'),json_extract(value,'$.playtime_2weeks'),
						json_extract(value,'$.tags'),json_extract(value,'$.reviewed')
						FROM json_each(${JSON.stringify(library.games)}) WHERE ${guard}`,
						sql`UPDATE libraries SET steam_id=${library.steamId}, revision=revision+1,
						operation_id=NULL, operation_expires_at=NULL
						WHERE owner=${this.owner} AND ${guard} RETURNING owner`,
					]);
					if (results[2].length !== 1)
						return yield* Effect.fail(
							new HttpError(409, 'Library changed. Try again.'),
						);
				}),
			),
	);
	saveTags = Effect.fn('Store.saveTags')((input: typeof TagsInput.Type) =>
		this.query((sql) =>
			sql.batch([
				sql`UPDATE library_games SET ${sql.update({ tags: JSON.stringify(input.tags) })}
				WHERE owner=${this.owner} AND appid=${input.appid}`,
				sql`UPDATE libraries SET revision=revision+1 WHERE owner=${this.owner}
				AND EXISTS (SELECT 1 FROM library_games WHERE owner=${this.owner} AND appid=${input.appid})`,
			]),
		).pipe(Effect.asVoid),
	);
	saveCriteria = Effect.fn('Store.saveCriteria')(
		(input: typeof CriteriaInput.Type) =>
			this.query((sql) =>
				Effect.gen({ self: this }, function* () {
					yield* this.ensureLibrary();
					const { idle } = idleGuards(sql, Date.now());
					const result =
						yield* sql`INSERT INTO category_criteria(owner,steam_id,criteria)
				SELECT l.owner,${input.steamId ?? 'offline'},${JSON.stringify(input.criteria)} FROM libraries l
				WHERE l.owner=${this.owner} AND l.steam_id IS ${input.steamId} AND ${idle}
				ON CONFLICT(owner,steam_id) DO UPDATE SET criteria=excluded.criteria RETURNING owner`;
					if (result.length !== 1) {
						yield* this.checkIdle();
						return yield* Effect.fail(
							new HttpError(
								409,
								'Steam account changed. Reload before saving categories.',
							),
						);
					}
				}),
			),
	);
	startJob = Effect.fn('Store.startJob')(
		(id: string, input: typeof ClassifyInput.Type) =>
			this.query((sql) =>
				Effect.gen({ self: this }, function* () {
					yield* this.ensureLibrary();
					for (let attempt = 0; attempt < 20; attempt++) {
						yield* this.checkIdle();
						const { library, revision } = yield* this.getLibrarySnapshot();
						if (library.steamId !== input.steamId)
							return yield* Effect.fail(
								new HttpError(409, 'Steam account changed.'),
							);
						const ids = selectGames(
							library,
							input.search,
							input.category,
							!input.all,
						).map((game) => game.appid);
						if (ids.length > 500)
							return yield* Effect.fail(
								new HttpError(400, 'Select at most 500 games per job.'),
							);
						const { idle } = idleGuards(sql, Date.now());
						const selectedIds = JSON.stringify(ids);
						const results = yield* sql.batch([
							sql`INSERT INTO classification_jobs(owner,id,status,total,completed,current,error,steam_id,ids,criteria,cancel)
						SELECT l.owner,${id},'queued',json_array_length(${selectedIds}),0,NULL,NULL,l.steam_id,${selectedIds},
						COALESCE((SELECT criteria FROM category_criteria WHERE owner=l.owner AND steam_id=COALESCE(l.steam_id,'offline')),
							${JSON.stringify(defaultCategoryCriteria)}),0
						FROM libraries l WHERE l.owner=${this.owner} AND l.revision=${revision}
						AND l.steam_id IS ${input.steamId} AND ${idle}
						ON CONFLICT(owner) DO UPDATE SET id=excluded.id,status=excluded.status,total=excluded.total,
						completed=0,current=NULL,error=NULL,steam_id=excluded.steam_id,ids=excluded.ids,criteria=excluded.criteria,cancel=0
						RETURNING owner`,
							sql`DELETE FROM classification_requests WHERE owner=${this.owner} AND EXISTS
						(SELECT 1 FROM classification_jobs WHERE owner=${this.owner} AND id=${id})`,
						]);
						if (results[0].length === 1) return;
					}
					return yield* Effect.fail(
						new HttpError(409, 'Concurrent library update. Try again.'),
					);
				}),
			),
	);
	cancelJob = Effect.fn('Store.cancelJob')(() =>
		this.query(
			(sql) => sql`UPDATE classification_jobs SET cancel=1
			WHERE owner=${this.owner} AND status IN ('queued','running')`,
		).pipe(Effect.asVoid),
	);
	beginBatch = Effect.fn('Store.beginBatch')((id: string, appid: number) =>
		this.query((sql) =>
			Effect.gen({ self: this }, function* () {
				const result = yield* sql`UPDATE classification_jobs SET
				status=CASE cancel WHEN 1 THEN 'cancelled' ELSE 'running' END,
				current=CASE cancel WHEN 1 THEN NULL ELSE
					(SELECT name FROM library_games WHERE owner=${this.owner} AND appid=${appid}) END
				WHERE owner=${this.owner} AND id=${id} AND status IN ('queued','running') RETURNING status`;
				return result[0]?.status === 'running';
			}),
		),
	);
	shouldClassify = Effect.fn('Store.shouldClassify')(
		(id: string, index: number) =>
			this.query((sql) =>
				sql`SELECT 1 FROM classification_jobs j WHERE j.owner=${this.owner} AND j.id=${id}
			AND j.status IN ('queued','running') AND j.cancel=0 AND NOT EXISTS
			(SELECT 1 FROM classification_requests r WHERE r.owner=${this.owner}
				AND r.request_id=${`${id}:${index}`} AND r.completed=1)`.pipe(
					Effect.map((rows) => rows.length > 0),
				),
			),
	);
	finishJob = Effect.fn('Store.finishJob')((id: string) =>
		this.query(
			(sql) => sql`UPDATE classification_jobs
			SET status=CASE cancel WHEN 1 THEN 'cancelled' ELSE 'complete' END, current=NULL
			WHERE owner=${this.owner} AND id=${id} AND status IN ('queued','running')`,
		).pipe(Effect.asVoid),
	);
	failJob = Effect.fn('Store.failJob')((id: string, error: string) =>
		this.query(
			(
				sql,
			) => sql`UPDATE classification_jobs SET ${sql.update({ status: 'failed', current: null, error })}
			WHERE owner=${this.owner} AND id=${id} AND status IN ('queued','running')`,
		).pipe(Effect.asVoid),
	);

	claimRequest = Effect.fn('Store.claimRequest')(
		(input: {
			jobId: string;
			index: number;
			appid: number;
			name: string;
			steamId: string | null;
			operationId: string;
		}) =>
			this.query((sql) =>
				Effect.gen({ self: this }, function* () {
					const now = Date.now();
					const requestId = `${input.jobId}:${input.index}`;
					const result =
						yield* sql`INSERT INTO classification_requests(owner,request_id,job_id,appid,operation_id,operation_expires_at)
				SELECT j.owner,${requestId},j.id,g.appid,${input.operationId},${now + 120_000} FROM classification_jobs j
				JOIN libraries l ON l.owner=j.owner JOIN library_games g ON g.owner=j.owner
				WHERE j.owner=${this.owner} AND j.id=${input.jobId} AND j.status IN ('queued','running') AND j.cancel=0
				AND json_extract(j.ids,${`$[${input.index}]`})=${input.appid} AND g.appid=${input.appid} AND g.name=${input.name}
				AND l.steam_id IS ${input.steamId} AND j.steam_id IS l.steam_id
				AND (l.operation_expires_at IS NULL OR l.operation_expires_at<=${now})
				ON CONFLICT(owner,request_id) DO NOTHING RETURNING owner`;
					if (result.length === 1) return true;
					const request = yield* this.getRequest(requestId);
					if (request) {
						if (request.appid !== input.appid || request.jobId !== input.jobId)
							return yield* Effect.fail(
								new HttpError(409, 'Request ID reused for a different game.'),
							);
						if (request.completed || request.tags !== null) return false;
						return yield* Effect.fail(
							new HttpError(
								409,
								request.expiresAt !== null && request.expiresAt > now
									? 'An operation is active.'
									: 'Paid outcome uncertain. Confirm recovery before continuing.',
							),
						);
					}
					const job = yield* this.getJob();
					if (job?.id !== input.jobId || !activeJob(job))
						return yield* Effect.fail(
							new HttpError(409, 'Job is no longer active at this game.'),
						);
					if (job.cancel) return false;
					return yield* Effect.fail(
						new HttpError(409, 'Library changed. Try again.'),
					);
				}),
			),
	);
	saveResult = Effect.fn('Store.saveResult')(
		(requestId: string, operationId: string, tags: readonly string[]) =>
			this.query((sql) =>
				Effect.gen({ self: this }, function* () {
					const result =
						yield* sql`UPDATE classification_requests SET ${sql.update({ tags: JSON.stringify(tags) })}
				WHERE owner=${this.owner} AND request_id=${requestId} AND operation_id=${operationId} AND completed=0
				RETURNING owner`;
					if (result.length !== 1)
						return yield* Effect.fail(
							new HttpError(409, 'Classification lease lost.'),
						);
				}),
			),
	);
	applyResult = Effect.fn('Store.applyResult')((requestId: string) =>
		this.query((sql) => {
			const saved = sql`r.owner=${this.owner} AND r.request_id=${requestId} AND r.completed=0 AND r.tags IS NOT NULL`;
			// Keep the completion marker last so all statements see the unapplied result.
			// D1Client.batch is atomic; withTransaction is unsupported on D1.
			return sql
				.batch([
					sql`UPDATE library_games AS g SET reviewed=1,tags=(SELECT json_group_array(value) FROM (
					SELECT value FROM (
						SELECT value,key AS ordinal FROM json_each(g.tags)
						UNION ALL SELECT value,key+json_array_length(g.tags) FROM json_each(
							(SELECT r.tags FROM classification_requests r WHERE ${saved}))
					) GROUP BY value ORDER BY MIN(ordinal)
				)) WHERE g.owner=${this.owner} AND g.appid=(SELECT r.appid FROM classification_requests r WHERE ${saved})`,
					sql`UPDATE classification_jobs SET completed=completed+1,current=NULL WHERE owner=${this.owner}
					AND id=(SELECT r.job_id FROM classification_requests r WHERE ${saved})`,
					sql`UPDATE libraries SET revision=revision+1 WHERE owner=${this.owner}
					AND EXISTS (SELECT 1 FROM classification_requests r WHERE ${saved})`,
					sql`UPDATE classification_requests SET completed=1,tags=NULL,operation_id=NULL,operation_expires_at=NULL
					WHERE owner=${this.owner} AND request_id=${requestId} AND completed=0 AND tags IS NOT NULL`,
				])
				.pipe(Effect.asVoid);
		}),
	);
	releaseRequest = Effect.fn('Store.releaseRequest')(
		(requestId: string, operationId: string) =>
			this.query(
				(
					sql,
				) => sql`UPDATE classification_requests SET operation_id=NULL,operation_expires_at=NULL
			WHERE owner=${this.owner} AND request_id=${requestId} AND operation_id=${operationId}`,
			).pipe(Effect.asVoid),
	);
	recoverRequests = Effect.fn('Store.recoverRequests')((operationId: string) =>
		this.query((sql) =>
			Effect.gen({ self: this }, function* () {
				yield* this.ensureLibrary();
				yield* this.checkIdle(true);
				const now = Date.now();
				const { noActiveJob, noActiveOperations } = idleGuards(sql, now);
				const claim = yield* sql`UPDATE libraries AS l
				SET operation_id=${operationId},operation_expires_at=${now + 120_000}
				WHERE l.owner=${this.owner} AND ${noActiveJob} AND ${noActiveOperations} RETURNING owner`;
				if (claim.length !== 1)
					return yield* Effect.fail(
						new HttpError(409, 'An operation is active.'),
					);
				return yield* Effect.gen({ self: this }, function* () {
					const saved = yield* sql<{
						request_id: string;
					}>`SELECT request_id FROM classification_requests
					WHERE owner=${this.owner} AND completed=0 AND tags IS NOT NULL`;
					for (const row of saved) yield* this.applyResult(row.request_id);
					yield* sql`DELETE FROM classification_requests WHERE owner=${this.owner} AND completed=0
					AND EXISTS (SELECT 1 FROM libraries WHERE owner=${this.owner} AND operation_id=${operationId})`;
				}).pipe(
					Effect.ensuring(this.releaseLibrary(operationId).pipe(Effect.orDie)),
				);
			}),
		),
	);
}
