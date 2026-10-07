import * as Bundle from 'alchemy/Bundle';
import { Effect } from 'effect';
import { fileURLToPath } from 'node:url';

export const buildWorker = () =>
	Effect.runPromise(
		Bundle.build(
			{
				input: 'web/server/worker.ts',
				external: ['cloudflare:*', 'node:*', 'lightningcss', 'fsevents'],
				checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
			},
			{
				dir: 'web/.worker',
				entryFileNames: 'worker.js',
				format: 'esm',
				minify: true,
				codeSplitting: false,
			},
		),
	);

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildWorker();
