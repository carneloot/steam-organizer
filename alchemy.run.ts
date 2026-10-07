import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import { Config, Effect } from 'effect';

export default Alchemy.Stack(
	'steam-organizer',
	{
		providers: Cloudflare.providers(),
		state: Alchemy.localState(),
	},
	Effect.gen(function* () {
		const emails = (yield* Config.String('ACCESS_EMAILS'))
			.split(',')
			.map((email) => email.trim().toLowerCase())
			.filter(Boolean);
		if (!emails.length || emails.some((email) => !email.includes('@'))) {
			return yield* Effect.die(
				new Error('ACCESS_EMAILS must contain explicit email addresses.'),
			);
		}
		const steamKey = yield* Config.Redacted('STEAM_API_KEY').pipe(
			Config.withDefault(null),
		);
		const classifierKey = yield* Config.Redacted('TYPESAFE_API_KEY').pipe(
			Config.withDefault(null),
		);
		const database = yield* Cloudflare.D1.Database('Library', {
			migrations: './web/migrations',
		});
		const coordinator = Cloudflare.DurableObject('Coordinator', {
			className: 'ApiCoordinator',
		});
		const workflow = Cloudflare.Workflow('Classification', {
			className: 'ClassificationWorkflow',
		});
		const login = yield* Cloudflare.Access.IdentityProvider('EmailLogin', {
			name: 'Email PIN',
			type: 'onetimepin',
			config: {},
		});
		const site = yield* Cloudflare.Website.Foldkit('Web', {
			rootDir: './web',
			main: 'server/worker.ts',
			compatibility: { date: '2026-10-07', flags: ['nodejs_compat'] },
			assets: { runWorkerFirst: true },
			access: {
				allowedIdps: [login.identityProviderId],
				policies: [
					{
						name: 'Friends',
						decision: 'allow',
						include: emails.map((email) => ({ email })),
					},
				],
			},
			env: {
				DB: database,
				COORDINATOR: coordinator,
				CLASSIFICATION: workflow,
				...(steamKey ? { STEAM_API_KEY: steamKey } : {}),
				...(classifierKey ? { TYPESAFE_API_KEY: classifierKey } : {}),
			},
		});
		return { url: site.url };
	}),
);
