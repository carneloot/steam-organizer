import { Effect, ManagedRuntime } from 'effect';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach } from 'vitest';

import { type Library } from '../../src/domain/library.js';
import { Store } from './store.js';

export const seedLibrary = Effect.fnUntraced(function* (
	store: Store['Service'],
	library: Library,
) {
	const { revision } = yield* store.claimLibrary('seed');
	yield* store.replaceLibrary(library, 'seed', revision);
});

const databases: DatabaseSync[] = [];
const runtimes: { dispose(): Promise<void> }[] = [];
export const testStore = Effect.fnUntraced(function* (
	db: D1Database,
	owner: string,
) {
	const runtime = ManagedRuntime.make(Store.layer(db, owner));
	runtimes.push(runtime);
	return yield* Effect.promise(() => runtime.runPromise(Store));
});
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
	for (const database of databases.splice(0)) database.close();
});

// Execute real SQL rather than teaching a fake about each production query.
export function testDb() {
	const sqlite = new DatabaseSync(':memory:');
	databases.push(sqlite);
	sqlite.exec(readFileSync('web/migrations/0001_state.sql', 'utf8'));
	const execute = new WeakMap<object, () => unknown>();
	const queries: string[] = [];
	function prepare(sql: string, values: SQLInputValue[] = []) {
		const run = () => {
			queries.push(sql);
			const statement = sqlite.prepare(sql);
			const reads = statement.columns().length > 0;
			const results = reads ? statement.all(...values) : [];
			const changes = reads ? 0 : Number(statement.run(...values).changes);
			return { results, success: true, meta: { changes } };
		};
		const statement = {
			bind(...args: SQLInputValue[]): object {
				return prepare(sql, args);
			},
			run: async () => run(),
			all: async () => run(),
			first: async () => run().results[0] ?? null,
		};
		execute.set(statement, run);
		return statement;
	}
	const db = {
		prepare,
		batch: async (statements: object[]) => {
			sqlite.exec('BEGIN');
			try {
				const results = statements.map((statement) => {
					const run = execute.get(statement);
					if (!run) throw new Error('Unknown statement');
					return run();
				});
				sqlite.exec('COMMIT');
				return results;
			} catch (error) {
				sqlite.exec('ROLLBACK');
				throw error;
			}
		},
	} as unknown as D1Database;
	return { db, sqlite, queries };
}
