import { Effect, Schema } from 'effect';
import { Command } from 'foldkit';

import { CategoryCriteria } from '../../src/domain/classification.js';
import { CollectionsLayer } from '../../src/layers/collections.js';
import { Collections } from '../../src/services/collections.js';
import { AppState, ApiError } from '../shared.js';
import { Message } from './model.js';

export const errorText = (error: unknown) =>
	error instanceof Error
		? error.message
		: 'Operation failed. Please try again.';
export const Api = Command.define('Api', {
	args: { path: Schema.String, body: Schema.String, action: Schema.String },
	messages: [Message.Received, Message.Failed],
	execute: ({ path, body, action }) =>
		Effect.gen(function* () {
			const response = yield* Effect.tryPromise({
				try: () =>
					fetch(`/api/${path}`, {
						method: body ? 'POST' : 'GET',
						credentials: 'same-origin',
						headers: body
							? {
									'Content-Type': 'application/json',
									'X-Requested-With': 'steam-organizer',
								}
							: {},
						...(body ? { body } : {}),
					}),
				catch: errorText,
			});
			if (response.status === 401 || response.status === 403)
				return yield* Effect.fail(
					'Your session expired or access was denied. Reload and sign in again.',
				);
			const data: unknown = yield* Effect.tryPromise({
				try: () => response.json(),
				catch: errorText,
			});
			if (!response.ok) {
				const error = yield* Schema.decodeUnknownEffect(ApiError)(data);
				return yield* Effect.fail(error.message);
			}
			const state = yield* Schema.decodeUnknownEffect(AppState)(data);
			return Message.Received({ state, action });
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(
					Message.Failed({
						message:
							typeof error === 'string'
								? error
								: 'The server returned an invalid response. Reload your session.',
						action,
					}),
				),
			),
		),
});
export const ParseCollections = Command.define('ParseCollections', {
	args: { text: Schema.String },
	messages: [Message.ReceivedCriteria, Message.Failed],
	execute: ({ text }) =>
		Effect.gen(function* () {
			const service = yield* Collections;
			return Message.ReceivedCriteria({
				criteria: yield* service.extractCategoryCriteria(text),
			});
		}).pipe(
			Effect.provide(CollectionsLayer),
			Effect.catch((error) =>
				Effect.succeed(
					Message.Failed({ message: error.message, action: 'collections' }),
				),
			),
		),
});
export const decodeCriteria = (text: string) =>
	Schema.decodeUnknownSync(CategoryCriteria)(JSON.parse(text));
export const DownloadCriteria = Command.define('DownloadCriteria', {
	args: { text: Schema.String },
	messages: [Message.Downloaded, Message.Failed],
	execute: ({ text }) =>
		Effect.try({
			try: () => {
				const criteria = decodeCriteria(text);
				const url = URL.createObjectURL(
					new Blob([JSON.stringify(criteria, null, 2)], {
						type: 'application/json',
					}),
				);
				const downloadAnchor = document.createElement('a');
				downloadAnchor.href = url;
				downloadAnchor.download = 'category-criteria.json';
				downloadAnchor.click();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
				return Message.Downloaded();
			},
			catch: errorText,
		}).pipe(
			Effect.catch((message) =>
				Effect.succeed(Message.Failed({ message, action: 'download' })),
			),
		),
});
export const ReadFile = Command.define('ReadFile', {
	args: { file: Schema.instanceOf(File) },
	messages: [Message.FileRead, Message.Failed],
	execute: ({ file }) =>
		Effect.tryPromise({
			try: async () => {
				if (file.size > 1024 * 1024)
					throw new Error('Choose a JSON file smaller than 1 MB.');
				return Message.FileRead({ text: await file.text() });
			},
			catch: errorText,
		}).pipe(
			Effect.catch((message) =>
				Effect.succeed(Message.Failed({ message, action: 'file' })),
			),
		),
});
export const api = (path: string, body?: unknown, action = path) =>
	Api({ path, body: body === undefined ? '' : JSON.stringify(body), action });
