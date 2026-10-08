import {
	makeWorkerBridge,
	makeWorkflowBridge,
} from 'alchemy/Cloudflare/Bridge';
import {
	DurableObject,
	WorkerEntrypoint,
	WorkflowEntrypoint,
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

const meta = {
	stack: { name: 'steam-organizer', stage: 'production' },
	entrypoint: Application,
};

// Keep the deployed class export and binding names while Alchemy owns the runtime.
export const ClassificationWorkflow = makeWorkflowBridge(
	// beta.81 types constructor arguments as unknown; Cloudflare narrows the context.
	WorkflowEntrypoint as Parameters<typeof makeWorkflowBridge>[0],
	// The shared bridge build supplies Application's provider requirements at runtime.
	meta as unknown as Parameters<typeof makeWorkflowBridge>[1],
)('CLASSIFICATION');
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

export default makeWorkerBridge(WorkerEntrypoint, meta);
