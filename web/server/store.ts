import { Effect, Schema } from 'effect';

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

const gameJson = `json_patch(json_object(
	'appid', g.appid, 'name', g.name, 'playtime_forever', g.playtime_forever,
	'tags', json(g.tags), 'reviewed', json(CASE g.reviewed WHEN 1 THEN 'true' ELSE 'false' END)
), CASE WHEN g.playtime_2weeks IS NULL THEN '{}' ELSE
	json_object('playtime_2weeks', g.playtime_2weeks) END)`;
const jobQuery = `SELECT json_object('id', id, 'status', status, 'total', total,
	'completed', completed, 'current', current, 'error', error,
	'steamId', steam_id, 'ids', json(ids), 'criteria', json(criteria),
	'cancel', json(CASE cancel WHEN 1 THEN 'true' ELSE 'false' END)
) AS data FROM classification_jobs WHERE owner=?1`;
const requestQuery = `SELECT json_object('jobId', job_id, 'appid', appid,
	'operationId', operation_id, 'expiresAt', operation_expires_at, 'tags', json(tags),
	'completed', json(CASE completed WHEN 1 THEN 'true' ELSE 'false' END)
) AS data FROM classification_requests WHERE owner=?1 AND request_id=?2`;

// Correlated to the library row, not a reconstructed owner-wide document.
const noActiveJob = `NOT EXISTS (SELECT 1 FROM classification_jobs j
	WHERE j.owner=l.owner AND j.status IN ('queued','running'))`;
const noPendingRequests = `NOT EXISTS (SELECT 1 FROM classification_requests r
	WHERE r.owner=l.owner AND r.completed=0)`;
const noActiveOperations = `(l.operation_expires_at IS NULL OR l.operation_expires_at<=?2)
	AND NOT EXISTS (SELECT 1 FROM classification_requests r WHERE r.owner=l.owner
	AND r.completed=0 AND r.operation_expires_at>?2)`;
const idle = `${noActiveJob} AND ${noActiveOperations} AND ${noPendingRequests}`;

type Row = { data: string; revision: number };
function librarySnapshot(
	metadata?: D1Result<Row>,
	games?: D1Result<Row>,
): { revision: number; library: unknown } {
	const row = metadata?.results[0];
	return {
		revision: row?.revision ?? 0,
		library: row
			? {
					...JSON.parse(row.data),
					games: games!.results.map((row) => JSON.parse(row.data)),
				}
			: emptyLibrary(),
	};
}

export class Store {
	constructor(
		private db: D1Database,
		private owner: string,
	) {}

	private sql(sql: string, ...values: (string | number | null)[]) {
		return this.db.prepare(sql).bind(this.owner, ...values);
	}
	private run(statement: D1PreparedStatement) {
		return Effect.tryPromise(() => statement.run());
	}
	private batch(statements: D1PreparedStatement[]) {
		return Effect.tryPromise(() => this.db.batch(statements));
	}
	private read<A>(
		schema: Schema.Decoder<A>,
		statement: D1PreparedStatement,
		fallback: A,
	) {
		return Effect.tryPromise(async () => {
			const row = await statement.first<{ data: string }>();
			return row ? JSON.parse(row.data) : fallback;
		}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));
	}
	private ensureLibrary() {
		return this.run(
			this.sql('INSERT OR IGNORE INTO libraries(owner) VALUES(?1)'),
		);
	}
	private libraryQueries() {
		return [
			this.sql(
				"SELECT revision, json_object('version', version, 'steamId', steam_id) AS data FROM libraries WHERE owner=?1",
			),
			this.sql(
				`SELECT ${gameJson} AS data FROM library_games g WHERE g.owner=?1 ORDER BY g.position`,
			),
		];
	}
	private getLibrarySnapshot = Effect.fn('Store.getLibrarySnapshot')(() =>
		Effect.gen({ self: this }, function* () {
			const [metadata, games] = yield* Effect.tryPromise(() =>
				this.db.batch<Row>(this.libraryQueries()),
			);
			return yield* Schema.decodeUnknownEffect(LibrarySnapshot)(
				librarySnapshot(metadata, games),
			);
		}),
	);
	getLibrary = Effect.fn('Store.getLibrary')(() =>
		this.getLibrarySnapshot().pipe(Effect.map(({ library }) => library)),
	);
	// A screen response includes the complete library. It never reads the paid ledger
	// or criteria belonging to another Steam account.
	getView = Effect.fn('Store.getView')(() =>
		Effect.gen({ self: this }, function* () {
			const [metadata, games, criteria, job] = yield* Effect.tryPromise(() =>
				this.db.batch<Row>([
					...this.libraryQueries(),
					this
						.sql(`SELECT criteria AS data FROM category_criteria WHERE owner=?1 AND steam_id=
					COALESCE((SELECT steam_id FROM libraries WHERE owner=?1),'offline')`),
					this.sql(jobQuery),
				]),
			);
			return yield* Schema.decodeUnknownEffect(View)({
				library: librarySnapshot(metadata, games).library,
				criteria: criteria?.results[0]
					? JSON.parse(criteria.results[0].data)
					: defaultCategoryCriteria,
				job: job?.results[0] ? JSON.parse(job.results[0].data) : null,
			});
		}),
	);
	getJob = Effect.fn('Store.getJob')(() =>
		this.read(Schema.NullOr(StoredJob), this.sql(jobQuery), null),
	);
	getRequest = Effect.fn('Store.getRequest')((requestId: string) =>
		this.read(
			Schema.NullOr(PaidRequest),
			this.sql(requestQuery, requestId),
			null,
		),
	);
	getGame = Effect.fn('Store.getGame')((appid: number) =>
		this.read(
			Schema.NullOr(
				Schema.Struct({ game: Game, steamId: Library.fields.steamId }),
			),
			this.sql(
				`SELECT json_object('game', json(${gameJson}), 'steamId', l.steam_id) AS data
				FROM library_games g JOIN libraries l ON l.owner=g.owner WHERE g.owner=?1 AND g.appid=?2`,
				appid,
			),
			null,
		),
	);

	private checkIdle = Effect.fn('Store.checkIdle')((recovery = false) =>
		Effect.gen({ self: this }, function* () {
			const flags = yield* Effect.tryPromise(() =>
				this.sql(
					`SELECT
				NOT (${noActiveJob}) AS job, NOT (${noActiveOperations}) AS operation,
				NOT (${noPendingRequests}) AS pending FROM libraries l WHERE l.owner=?1`,
					Date.now(),
				).first<{ job: number; operation: number; pending: number }>(),
			);
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
	);
	claimLibrary = Effect.fn('Store.claimLibrary')((operationId: string) =>
		Effect.gen({ self: this }, function* () {
			yield* this.ensureLibrary();
			for (let attempt = 0; attempt < 20; attempt++) {
				yield* this.checkIdle();
				const snapshot = yield* this.getLibrarySnapshot();
				const now = Date.now();
				const result = yield* this.run(
					this.sql(
						`UPDATE libraries AS l SET operation_id=?3, operation_expires_at=?4
					WHERE l.owner=?1 AND ${idle} AND l.revision=?5`,
						now,
						operationId,
						now + 120_000,
						snapshot.revision,
					),
				);
				if (result.meta.changes === 1) return snapshot;
			}
			return yield* Effect.fail(
				new HttpError(409, 'Concurrent library update. Try again.'),
			);
		}),
	);
	releaseLibrary = Effect.fn('Store.releaseLibrary')((operationId: string) =>
		this.run(
			this.sql(
				'UPDATE libraries SET operation_id=NULL, operation_expires_at=NULL WHERE owner=?1 AND operation_id=?2',
				operationId,
			),
		).pipe(Effect.asVoid),
	);
	replaceLibrary = Effect.fn('Store.replaceLibrary')(
		(library: Library, operationId: string, revision: number) =>
			Effect.gen({ self: this }, function* () {
				const now = Date.now();
				const guard = `EXISTS (SELECT 1 FROM libraries l WHERE l.owner=?1 AND l.operation_id=?2
				AND l.revision=?3 AND l.operation_expires_at>?4 AND ${noActiveJob} AND ${noPendingRequests})`;
				const results = yield* this.batch([
					this.sql(
						`DELETE FROM library_games WHERE owner=?1 AND ${guard}`,
						operationId,
						revision,
						now,
					),
					// One JSON parameter avoids D1's bound-parameter limit on large imports.
					this.sql(
						`INSERT INTO library_games(owner,appid,position,name,playtime_forever,playtime_2weeks,tags,reviewed)
					SELECT ?1,json_extract(value,'$.appid'),key,json_extract(value,'$.name'),
					json_extract(value,'$.playtime_forever'),json_extract(value,'$.playtime_2weeks'),
					json_extract(value,'$.tags'),json_extract(value,'$.reviewed') FROM json_each(?5) WHERE ${guard}`,
						operationId,
						revision,
						now,
						JSON.stringify(library.games),
					),
					this.sql(
						`UPDATE libraries SET steam_id=?5, revision=revision+1, operation_id=NULL, operation_expires_at=NULL
					WHERE owner=?1 AND ${guard}`,
						operationId,
						revision,
						now,
						library.steamId,
					),
				]);
				if (results.at(-1)?.meta.changes !== 1)
					return yield* Effect.fail(
						new HttpError(409, 'Library changed. Try again.'),
					);
			}),
	);
	saveTags = Effect.fn('Store.saveTags')((input: typeof TagsInput.Type) =>
		this.batch([
			this.sql(
				'UPDATE library_games SET tags=?3 WHERE owner=?1 AND appid=?2',
				input.appid,
				JSON.stringify(input.tags),
			),
			this.sql(
				'UPDATE libraries SET revision=revision+1 WHERE owner=?1 AND EXISTS (SELECT 1 FROM library_games WHERE owner=?1 AND appid=?2)',
				input.appid,
			),
		]).pipe(Effect.asVoid),
	);
	saveCriteria = Effect.fn('Store.saveCriteria')(
		(input: typeof CriteriaInput.Type) =>
			Effect.gen({ self: this }, function* () {
				yield* this.ensureLibrary();
				const result = yield* this.run(
					this.sql(
						`INSERT INTO category_criteria(owner,steam_id,criteria)
				SELECT l.owner,?3,?4 FROM libraries l WHERE l.owner=?1 AND l.steam_id IS ?5 AND ${idle}
				ON CONFLICT(owner,steam_id) DO UPDATE SET criteria=excluded.criteria`,
						Date.now(),
						input.steamId ?? 'offline',
						JSON.stringify(input.criteria),
						input.steamId,
					),
				);
				if (result.meta.changes !== 1) {
					yield* this.checkIdle();
					return yield* Effect.fail(
						new HttpError(
							409,
							'Steam account changed. Reload before saving categories.',
						),
					);
				}
			}),
	);
	startJob = Effect.fn('Store.startJob')(
		(id: string, input: typeof ClassifyInput.Type) =>
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
					const results = yield* this.batch([
						this.sql(
							`INSERT INTO classification_jobs(owner,id,status,total,completed,current,error,steam_id,ids,criteria,cancel)
						SELECT l.owner,?3,'queued',json_array_length(?4),0,NULL,NULL,l.steam_id,?4,
						COALESCE((SELECT criteria FROM category_criteria WHERE owner=l.owner AND steam_id=COALESCE(l.steam_id,'offline')),?5),0
						FROM libraries l WHERE l.owner=?1 AND l.revision=?6 AND l.steam_id IS ?7 AND ${idle}
						ON CONFLICT(owner) DO UPDATE SET id=excluded.id,status=excluded.status,total=excluded.total,
						completed=0,current=NULL,error=NULL,steam_id=excluded.steam_id,ids=excluded.ids,criteria=excluded.criteria,cancel=0`,
							Date.now(),
							id,
							JSON.stringify(ids),
							JSON.stringify(defaultCategoryCriteria),
							revision,
							input.steamId,
						),
						this.sql(
							`DELETE FROM classification_requests WHERE owner=?1 AND EXISTS
						(SELECT 1 FROM classification_jobs WHERE owner=?1 AND id=?2)`,
							id,
						),
					]);
					if (results[0]?.meta.changes === 1) return;
				}
				return yield* Effect.fail(
					new HttpError(409, 'Concurrent library update. Try again.'),
				);
			}),
	);
	cancelJob = Effect.fn('Store.cancelJob')(() =>
		this.run(
			this.sql(
				"UPDATE classification_jobs SET cancel=1 WHERE owner=?1 AND status IN ('queued','running')",
			),
		).pipe(Effect.asVoid),
	);
	beginBatch = Effect.fn('Store.beginBatch')((id: string, appid: number) =>
		Effect.gen({ self: this }, function* () {
			const result = yield* this.run(
				this.sql(
					`UPDATE classification_jobs SET
				status=CASE cancel WHEN 1 THEN 'cancelled' ELSE 'running' END,
				current=CASE cancel WHEN 1 THEN NULL ELSE (SELECT name FROM library_games WHERE owner=?1 AND appid=?3) END
				WHERE owner=?1 AND id=?2 AND status IN ('queued','running')`,
					id,
					appid,
				),
			);
			if (result.meta.changes === 0) return false;
			const job = yield* this.getJob();
			return job?.id === id && activeJob(job);
		}),
	);
	shouldClassify = Effect.fn('Store.shouldClassify')(
		(id: string, index: number) =>
			Effect.tryPromise(
				async () =>
					(await this.sql(
						`SELECT 1 FROM classification_jobs j WHERE j.owner=?1 AND j.id=?2
			AND j.status IN ('queued','running') AND j.cancel=0 AND NOT EXISTS
			(SELECT 1 FROM classification_requests r WHERE r.owner=?1 AND r.request_id=?2 || ':' || CAST(?3 AS INTEGER) AND r.completed=1)`,
						id,
						index,
					).first()) !== null,
			),
	);
	finishJob = Effect.fn('Store.finishJob')((id: string) =>
		this.run(
			this.sql(
				`UPDATE classification_jobs SET status=CASE cancel WHEN 1 THEN 'cancelled' ELSE 'complete' END,
			current=NULL WHERE owner=?1 AND id=?2 AND status IN ('queued','running')`,
				id,
			),
		).pipe(Effect.asVoid),
	);
	failJob = Effect.fn('Store.failJob')((id: string, error: string) =>
		this.run(
			this.sql(
				"UPDATE classification_jobs SET status='failed',current=NULL,error=?3 WHERE owner=?1 AND id=?2 AND status IN ('queued','running')",
				id,
				error,
			),
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
			Effect.gen({ self: this }, function* () {
				const now = Date.now();
				const result = yield* this.run(
					this.sql(
						`INSERT INTO classification_requests(owner,request_id,job_id,appid,operation_id,operation_expires_at)
			SELECT j.owner,?2 || ':' || CAST(?3 AS INTEGER),j.id,g.appid,?7,?8 FROM classification_jobs j
			JOIN libraries l ON l.owner=j.owner JOIN library_games g ON g.owner=j.owner
			WHERE j.owner=?1 AND j.id=?2 AND j.status IN ('queued','running') AND j.cancel=0
			AND json_extract(j.ids,'$[' || CAST(?3 AS INTEGER) || ']')=?4 AND g.appid=?4 AND g.name=?5
			AND l.steam_id IS ?6 AND j.steam_id IS l.steam_id
			AND (l.operation_expires_at IS NULL OR l.operation_expires_at<=?9)
			ON CONFLICT(owner,request_id) DO NOTHING`,
						input.jobId,
						input.index,
						input.appid,
						input.name,
						input.steamId,
						input.operationId,
						now + 120_000,
						now,
					),
				);
				if (result.meta.changes === 1) return true;
				const request = yield* this.getRequest(`${input.jobId}:${input.index}`);
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
	);
	saveResult = Effect.fn('Store.saveResult')(
		(requestId: string, operationId: string, tags: readonly string[]) =>
			Effect.gen({ self: this }, function* () {
				const result = yield* this.run(
					this.sql(
						`UPDATE classification_requests SET tags=?4
				WHERE owner=?1 AND request_id=?2 AND operation_id=?3 AND completed=0`,
						requestId,
						operationId,
						JSON.stringify(tags),
					),
				);
				if (result.meta.changes !== 1)
					return yield* Effect.fail(
						new HttpError(409, 'Classification lease lost.'),
					);
			}),
	);
	applyResult = Effect.fn('Store.applyResult')((requestId: string) => {
		const saved =
			'r.owner=?1 AND r.request_id=?2 AND r.completed=0 AND r.tags IS NOT NULL';
		const ready = `EXISTS (SELECT 1 FROM classification_requests r WHERE ${saved})`;
		// The completion marker is last: all updates see the same unapplied result.
		// Merge against the current game row, preserving concurrent manual edits and tag order.
		return this.batch([
			this.sql(
				`UPDATE library_games AS g SET reviewed=1,tags=(SELECT json_group_array(value) FROM (
				SELECT value FROM (
					SELECT value,key AS ordinal FROM json_each(g.tags)
					UNION ALL SELECT value,key+json_array_length(g.tags) FROM json_each(
						(SELECT r.tags FROM classification_requests r WHERE ${saved}))
				) GROUP BY value ORDER BY MIN(ordinal)
			)) WHERE g.owner=?1 AND g.appid=(SELECT r.appid FROM classification_requests r WHERE ${saved})`,
				requestId,
			),
			this.sql(
				`UPDATE classification_jobs SET completed=completed+1,current=NULL WHERE owner=?1
				AND id=(SELECT r.job_id FROM classification_requests r WHERE ${saved})`,
				requestId,
			),
			this.sql(
				`UPDATE libraries SET revision=revision+1 WHERE owner=?1 AND ${ready}`,
				requestId,
			),
			this.sql(
				`UPDATE classification_requests SET completed=1,tags=NULL,operation_id=NULL,operation_expires_at=NULL
				WHERE owner=?1 AND request_id=?2 AND completed=0 AND tags IS NOT NULL`,
				requestId,
			),
		]).pipe(Effect.asVoid);
	});
	releaseRequest = Effect.fn('Store.releaseRequest')(
		(requestId: string, operationId: string) =>
			this.run(
				this.sql(
					`UPDATE classification_requests SET operation_id=NULL,operation_expires_at=NULL
			WHERE owner=?1 AND request_id=?2 AND operation_id=?3`,
					requestId,
					operationId,
				),
			).pipe(Effect.asVoid),
	);
	recoverRequests = Effect.fn('Store.recoverRequests')((operationId: string) =>
		Effect.gen({ self: this }, function* () {
			yield* this.ensureLibrary();
			yield* this.checkIdle(true);
			const now = Date.now();
			const claim = yield* this.run(
				this.sql(
					`UPDATE libraries AS l SET operation_id=?3,operation_expires_at=?4
				WHERE l.owner=?1 AND ${noActiveJob} AND ${noActiveOperations}`,
					now,
					operationId,
					now + 120_000,
				),
			);
			if (claim.meta.changes !== 1)
				return yield* Effect.fail(
					new HttpError(409, 'An operation is active.'),
				);
			return yield* Effect.gen({ self: this }, function* () {
				const saved = yield* Effect.tryPromise(() =>
					this.sql(`SELECT request_id FROM classification_requests
					WHERE owner=?1 AND completed=0 AND tags IS NOT NULL`).all<{
						request_id: string;
					}>(),
				);
				for (const row of saved.results)
					yield* this.applyResult(row.request_id);
				yield* this.run(
					this.sql(
						`DELETE FROM classification_requests WHERE owner=?1 AND completed=0
					AND EXISTS (SELECT 1 FROM libraries WHERE owner=?1 AND operation_id=?2)`,
						operationId,
					),
				);
			}).pipe(
				Effect.ensuring(this.releaseLibrary(operationId).pipe(Effect.orDie)),
			);
		}),
	);
}
