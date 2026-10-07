import { makeWorkerBridge } from 'alchemy/Cloudflare/Bridge';
import {
	DurableObject,
	WorkerEntrypoint,
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers';
import { Schema } from 'effect';

import Application from './application.js';
import {
	updateLimit,
	LimitStateSchema,
	LimitInputSchema,
	type LimitState,
} from './rate-limit.js';
import { json } from './security.js';
import { type Env } from './services.js';
import { runClassification, workflowServices } from './workflow.js';

export class ClassificationWorkflow extends WorkflowEntrypoint<
	Env,
	{ owner: string; id: string }
> {
	async run(
		event: WorkflowEvent<{ owner: string; id: string }>,
		step: WorkflowStep,
	) {
		await runClassification(
			step,
			event.payload.id,
			workflowServices(this.env, event.payload.owner),
		);
	}
}
export class ApiCoordinator extends DurableObject<Env> {
	async fetch(request: Request) {
		try {
			const input = Schema.decodeSync(Schema.fromJsonString(LimitInputSchema))(
				await request.text(),
			);
			const result = await this.ctx.storage.transaction(async (transaction) => {
				const state: LimitState = Schema.decodeUnknownSync(LimitStateSchema)(
					(await transaction.get(input.key)) ?? {},
				);
				const result = updateLimit(state, input, Date.now());
				await transaction.put(input.key, state);
				return result;
			});
			return json(result);
		} catch {
			return json({ message: 'Rate limit storage unavailable.' }, 503);
		}
	}
}

// Keep the native Workflow and Durable Object exports in the same entry module.
export default makeWorkerBridge(WorkerEntrypoint, {
	stack: { name: 'steam-organizer', stage: 'production' },
	entrypoint: Application,
});
