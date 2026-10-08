import { Schema, Stream } from 'effect';
import { Subscription } from 'foldkit';

import { activeJob, Message, type Model } from './model.js';

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
	job: entry(
		{ identity: Schema.String, jobId: Schema.String },
		{
			modelToDependencies: (model) => ({
				identity: model.state?.identity ?? '',
				jobId: activeJob(model) ? model.state!.job!.id : '',
			}),
			dependenciesToStream: ({ jobId }) =>
				jobId
					? Stream.tick('2 seconds').pipe(Stream.map(() => Message.Poll()))
					: Stream.empty,
		},
	),
}));
