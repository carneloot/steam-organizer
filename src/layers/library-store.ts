import { Effect, FileSystem, Layer, Path, Predicate, Schema } from 'effect';

import { emptyLibrary, Library } from '../domain/library.js';
import {
	LibraryStore,
	LibraryReadError,
	InvalidLibraryError,
	LibraryLockedError,
	LibraryWriteError,
} from '../services/library-store.js';

export const FileLibraryStoreLayer = Layer.effect(
	LibraryStore,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const load = Effect.fn('LibraryStore.load')(function* (file: string) {
			const text = yield* fs.readFileString(file).pipe(
				Effect.catchReason('PlatformError', 'NotFound', () =>
					Effect.succeed(null),
				),
				Effect.mapError(
					(error) =>
						new LibraryReadError({
							message: `Cannot read ${file}: ${error.reason._tag}`,
						}),
				),
			);
			if (text === null) return emptyLibrary();
			return yield* Schema.decodeUnknownEffect(
				Library.pipe(Schema.fromJsonString),
			)(text).pipe(
				Effect.mapError(
					() =>
						new InvalidLibraryError({
							message: `Invalid library file ${file}. Fix it or choose another --file. It has not been overwritten.`,
						}),
				),
			);
		});

		const modify = Effect.fn('LibraryStore.modify')(function* <E, R>(
			file: string,
			update: (library: Library) => Effect.Effect<Library, E, R>,
		) {
			const target = path.resolve(file);
			const directory = path.dirname(target);
			yield* fs.makeDirectory(directory, { recursive: true }).pipe(
				Effect.mapError(
					(error) =>
						new LibraryWriteError({
							message: `Cannot save library: ${error.reason._tag}`,
						}),
				),
			);
			yield* Effect.acquireRelease(
				fs.makeDirectory(`${target}.lock`).pipe(
					Effect.mapError((error) =>
						Predicate.isTagged(error.reason, 'AlreadyExists')
							? new LibraryLockedError({
									message: `Library is locked: ${target}.lock. Wait for the other command. After a crash, remove this directory only when no writer is running.`,
								})
							: new LibraryWriteError({
									message: `Cannot lock library: ${error.reason._tag}`,
								}),
					),
				),
				() =>
					fs.remove(`${target}.lock`, { recursive: true }).pipe(Effect.orDie),
			);
			const next = yield* update(yield* load(target));
			const valid = yield* Schema.decodeUnknownEffect(Library)(next).pipe(
				Effect.mapError(
					() =>
						new InvalidLibraryError({
							message: 'The updated library is invalid. Nothing was written.',
						}),
				),
			);
			yield* Effect.gen(function* () {
				const temporary = yield* fs.makeTempFileScoped({
					directory,
					prefix: '.steam-categorizer-',
				});
				yield* fs.chmod(temporary, 0o600);
				yield* fs.writeFileString(
					temporary,
					`${JSON.stringify(valid, null, 2)}\n`,
				);
				yield* fs.rename(temporary, target);
			}).pipe(
				Effect.mapError(
					(error) =>
						new LibraryWriteError({
							message: `Cannot save library: ${error.reason._tag}`,
						}),
				),
			);
			return valid;
		}, Effect.scoped);

		return LibraryStore.of({ load, modify });
	}),
);
