import { Schema } from 'effect';

import { CategoryCriteria } from '../src/domain/classification.js';
import { AppId, Category, Library, SteamId } from '../src/domain/library.js';

export const Job = Schema.Struct({
	id: Schema.String,
	status: Schema.Literals([
		'queued',
		'running',
		'complete',
		'failed',
		'cancelled',
	]),
	total: Schema.Natural,
	completed: Schema.Natural,
	current: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
});
export type Job = Schema.Schema.Type<typeof Job>;

export const AppState = Schema.Struct({
	identity: Schema.NonEmptyString,
	library: Library,
	criteria: CategoryCriteria,
	job: Schema.NullOr(Job),
	configured: Schema.Struct({ sync: Schema.Boolean, classify: Schema.Boolean }),
});
export type AppState = Schema.Schema.Type<typeof AppState>;

export const ImportInput = Schema.Struct({
	text: Schema.String,
	confirm: Schema.Literal(true),
});
export const SyncInput = Schema.Struct({
	steamId: SteamId,
	confirm: Schema.Literal(true),
});
export const TagsInput = Schema.Struct({
	appid: AppId,
	tags: Schema.Array(Category).check(Schema.isUnique()),
});
export const ClassifyInput = Schema.Struct({
	steamId: Schema.NullOr(SteamId),
	search: Schema.String,
	category: Schema.String,
	all: Schema.Boolean,
});
export const ApiError = Schema.Struct({ message: Schema.String });
export const CriteriaInput = Schema.Struct({
	steamId: Schema.NullOr(SteamId),
	criteria: CategoryCriteria,
});
export const RecoveryInput = Schema.Struct({ confirm: Schema.Literal(true) });
