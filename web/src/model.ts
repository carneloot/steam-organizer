import { Schema } from 'effect';
import { defineMessageUnion } from 'foldkit/message';

import { CategoryCriteria } from '../../src/domain/classification.js';
import { AppId } from '../../src/domain/library.js';
import { AppState } from '../shared.js';

export const Model = Schema.Struct({
	state: Schema.NullOr(AppState),
	loading: Schema.Boolean,
	pending: Schema.String,
	polling: Schema.Boolean,
	error: Schema.String,
	notice: Schema.String,
	search: Schema.String,
	category: Schema.String,
	sort: Schema.String,
	selected: Schema.NullOr(AppId),
	tags: Schema.String,
	panel: Schema.String,
	text: Schema.String,
	steamId: Schema.String,
	criteria: Schema.String,
	confirmed: Schema.Boolean,
	recoveryConfirmed: Schema.Boolean,
	all: Schema.Boolean,
});
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({
	Changed: { field: Schema.String, value: Schema.String },
	ToggledConfirm: {},
	ToggledAll: {},
	ToggledRecovery: {},
	Downloaded: {},
	Selected: { appid: AppId },
	Opened: { panel: Schema.String },
	Submitted: { action: Schema.String },
	Reloaded: {},
	Poll: {},
	Received: { state: AppState, action: Schema.String },
	ReceivedCriteria: { criteria: CategoryCriteria },
	FileSelected: { files: Schema.Array(Schema.instanceOf(File)) },
	FileRead: { text: Schema.String },
	Failed: { message: Schema.String, action: Schema.String },
});
export type Message = typeof Message.Type;
export const initialModel: Model = {
	state: null,
	loading: true,
	pending: '',
	polling: false,
	error: '',
	notice: '',
	search: '',
	category: '',
	sort: 'name',
	selected: null,
	tags: '',
	panel: '',
	text: '',
	steamId: '',
	criteria: '',
	confirmed: false,
	recoveryConfirmed: false,
	all: false,
};
export const activeJob = (model: Model) =>
	!!model.state?.job && ['queued', 'running'].includes(model.state.job.status);
