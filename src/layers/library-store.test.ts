import { NodeServices } from '@effect/platform-node';
import { assert, describe, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, FileSystem, Layer } from 'effect';

import { emptyLibrary, mergeLibrary } from '../domain/library.js';
import { LibraryStore } from '../services/library-store.js';
import { LibraryService, GameNotFoundError } from '../services/library.js';
import { FileLibraryStoreLayer } from './library-store.js';
import { LibraryLayer } from './library.js';

const layer = Layer.mergeAll(FileLibraryStoreLayer, LibraryLayer).pipe(
	Layer.provideMerge(NodeServices.layer),
);
const seed = mergeLibrary(
	emptyLibrary(),
	[{ appid: 620, name: 'Portal 2', playtime_forever: 480 }],
	null,
);

describe('LibraryStore', () => {
	it.effect('persists tags and releases the lock after each write', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();
			const file = `${directory}/nested/library.json`;
			const store = yield* LibraryStore;
			const libraryService = yield* LibraryService;
			assert.deepStrictEqual(yield* store.load(file), emptyLibrary());
			yield* store.modify(file, () => Effect.succeed(seed));
			assert.isFalse(yield* fs.exists(`${file}.lock`));
			assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
			yield* store.modify(file, (library) =>
				libraryService.updateGame(library, 620, (game) => ({
					...game,
					tags: ['Co-op'],
					reviewed: true,
				})),
			);
			assert.deepStrictEqual((yield* store.load(file)).games[0]?.tags, [
				'Co-op',
			]);
			assert.isTrue((yield* store.load(file)).games[0]?.reviewed);
			assert.deepStrictEqual(yield* fs.readDirectory(`${directory}/nested`), [
				'library.json',
			]);
		}).pipe(Effect.provide(layer)),
	);

	it.effect(
		'does not overwrite malformed data and cleans the lock on failure',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const directory = yield* fs.makeTempDirectoryScoped();
				const file = `${directory}/library.json`;
				yield* fs.writeFileString(file, 'not json');
				const store = yield* LibraryStore;
				const result = yield* store
					.modify(file, () => Effect.succeed(seed))
					.pipe(Effect.flip);
				assert.include(result.message, 'Invalid library file');
				assert.strictEqual(result._tag, 'InvalidLibraryError');
				assert.strictEqual(yield* fs.readFileString(file), 'not json');
				assert.isFalse(yield* fs.exists(`${file}.lock`));
			}).pipe(Effect.provide(layer)),
	);

	it.effect('rejects competing writers and preserves the first write', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();
			const file = `${directory}/library.json`;
			const store = yield* LibraryStore;
			const locked = yield* Deferred.make<void>();
			const finish = yield* Deferred.make<void>();
			const writer = yield* store
				.modify(
					file,
					Effect.fn(function* () {
						yield* Deferred.succeed(locked, undefined);
						yield* Deferred.await(finish);
						return seed;
					}),
				)
				.pipe(Effect.forkScoped);
			yield* Deferred.await(locked);
			const error = yield* store
				.modify(file, () => Effect.succeed(emptyLibrary()))
				.pipe(Effect.flip);
			assert.include(error.message, 'Library is locked');
			assert.strictEqual(error._tag, 'LibraryLockedError');
			yield* Deferred.succeed(finish, undefined);
			yield* Fiber.join(writer);
			assert.deepStrictEqual(yield* store.load(file), seed);
		}).pipe(Effect.provide(layer)),
	);

	it.effect('failed updates leave the previous library intact', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();
			const file = `${directory}/library.json`;
			const store = yield* LibraryStore;
			yield* store.modify(file, () => Effect.succeed(seed));
			const error = yield* store
				.modify(file, () =>
					Effect.fail(new GameNotFoundError({ message: 'No update' })),
				)
				.pipe(Effect.flip);
			assert.strictEqual(error._tag, 'GameNotFoundError');
			const platformError = yield* store
				.modify(file, () =>
					fs.readFileString(`${directory}/missing`).pipe(Effect.as(seed)),
				)
				.pipe(Effect.flip);
			assert.strictEqual(platformError._tag, 'PlatformError');
			assert.deepStrictEqual(yield* store.load(file), seed);
			assert.isFalse(yield* fs.exists(`${file}.lock`));
		}).pipe(Effect.provide(layer)),
	);

	it.effect('distinguishes filesystem read failures from write failures', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();
			const store = yield* LibraryStore;
			const readError = yield* store.load(directory).pipe(Effect.flip);
			assert.strictEqual(readError._tag, 'LibraryReadError');
			const blocker = `${directory}/blocking-file`;
			yield* fs.writeFileString(blocker, 'unchanged');
			const writeError = yield* store
				.modify(`${blocker}/library.json`, () => Effect.succeed(seed))
				.pipe(Effect.flip);
			assert.strictEqual(writeError._tag, 'LibraryWriteError');
			assert.strictEqual(yield* fs.readFileString(blocker), 'unchanged');
		}).pipe(Effect.provide(layer)),
	);
});
