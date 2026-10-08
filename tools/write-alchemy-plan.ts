import * as Alchemist from 'alchemy/Alchemist';
import { Effect } from 'effect';
import { writeFile } from 'node:fs/promises';

const [outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error('Usage: write-alchemy-plan.ts <output-path>');

// Alchemy beta.81 exposes unknown errors; orDie terminates this CLI on failure.
const snapshot = await Effect.runPromise(
	// @effect-diagnostics-next-line anyUnknownInErrorContext:off
	Alchemist.Stack.plan({
		target: { entrypoint: 'alchemy.run.ts', stage: 'production' },
		operation: 'deploy',
		updateStateStore: false,
	}).pipe(Effect.provide(Alchemist.layer()), Effect.scoped, Effect.orDie),
);

// Keep resource properties and outputs out of the comment snapshot.
await writeFile(
	outputPath,
	JSON.stringify({
		resources: snapshot.resources.map((resource) => ({
			fqn: resource.fqn,
			action: resource.action,
			bindings: resource.bindings.map((binding) => ({
				sid: binding.sid,
				action: binding.action,
			})),
		})),
		actions: snapshot.actions.map((action) => ({
			fqn: action.fqn,
			action: action.action,
		})),
	}),
);
