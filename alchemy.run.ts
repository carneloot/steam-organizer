import * as zeroTrust from '@distilled.cloud/cloudflare/zero-trust';
import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import * as Namespace from 'alchemy/Namespace';
import { Config, Effect } from 'effect';

export default Alchemy.Stack(
	'steam-organizer',
	{
		providers: Cloudflare.providers(),
		state: Cloudflare.state(),
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
		// Read the account's existing organization without managing its settings.
		const organization = yield* Effect.gen(function* () {
			const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
			return yield* zeroTrust.listOrganizationsForAccount({ accountId });
		}).pipe(Effect.provide(Cloudflare.CloudflareApiLive()), Effect.orDie);
		if (!organization.authDomain) {
			return yield* Effect.die(
				new Error('The existing Zero Trust organization has no authDomain.'),
			);
		}
		// Match the formerly implicit application's namespace and logical ID.
		const access = yield* Cloudflare.Access.Application('Access', {
			type: 'self_hosted',
			allowedIdps: [login.identityProviderId],
			policies: [
				{
					name: 'Friends',
					decision: 'allow',
					include: emails.map((email) => ({ email })),
				},
			],
		}).pipe(Namespace.push('Web'));
		const site = yield* Cloudflare.Website.Foldkit('Web', {
			rootDir: './web',
			main: 'server/worker.ts',
			domain: 'steam-organizer.carneloot.com',
			compatibility: { date: '2026-10-07', flags: ['nodejs_compat'] },
			assets: { runWorkerFirst: true },
			access,
			env: {
				DB: database,
				COORDINATOR: coordinator,
				CLASSIFICATION: workflow,
				ACCESS_TEAM_DOMAIN: `https://${organization.authDomain}`,
				ACCESS_AUD: access.aud,
				...(steamKey ? { STEAM_API_KEY: steamKey } : {}),
				...(classifierKey ? { TYPESAFE_API_KEY: classifierKey } : {}),
			},
		});
		return { url: site.url };
	}),
);
