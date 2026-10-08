import { it } from '@effect/vitest';
import * as Cloudflare from 'alchemy/Cloudflare';
import * as Output from 'alchemy/Output';
import { Stack } from 'alchemy/Stack';
import { Config, ConfigProvider, Effect, Layer, Redacted } from 'effect';
import { expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	stack: vi.fn(),
	organization: vi.fn(),
}));

vi.mock('alchemy', () => ({
	Stack: mocks.stack,
}));
vi.mock('@distilled.cloud/cloudflare/zero-trust', async (importOriginal) => ({
	...(await importOriginal<object>()),
	listOrganizationsForAccount: mocks.organization,
}));
vi.mock('alchemy/Cloudflare', async (importOriginal) => {
	const actual = await importOriginal<typeof Cloudflare>();
	return {
		...actual,
		CloudflareApiLive: () =>
			Layer.succeed(
				actual.CloudflareEnvironment,
				Effect.succeed({
					type: 'apiToken' as const,
					apiToken: Redacted.make('test-token'),
					accountId: 'test-account',
					source: { type: 'env' as const },
				}),
			),
	};
});

await import('../alchemy.run.js');
const declaration: Effect.Effect<unknown, Config.ConfigError, Stack> =
	mocks.stack.mock.calls[0]?.[2];

it.effect(
	'derives verification settings and preserves Access enrollment identity',
	() =>
		Effect.gen(function* () {
			mocks.organization.mockReturnValue(
				Effect.succeed({ authDomain: 'existing-team.cloudflareaccess.com' }),
			);
			const stack = Stack.of({
				name: 'steam-organizer',
				stage: 'production',
				resources: {},
				bindings: {},
				actions: {},
			});
			yield* declaration.pipe(
				Effect.provideService(Stack, stack),
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown({ ACCESS_EMAILS: 'friend@example.com' }),
				),
			);
			expect(mocks.organization).toHaveBeenCalledWith({
				accountId: 'test-account',
			});
			const access = stack.resources['Web/Access'];
			expect(access).toMatchObject({
				Type: 'Cloudflare.Access.Application',
				LogicalId: 'Access',
				Namespace: { Id: 'Web' },
				Props: {
					type: 'self_hosted',
					policies: [
						{ name: 'Friends', include: [{ email: 'friend@example.com' }] },
					],
				},
			});
			const props = stack.resources.Web?.Props;
			expect(props.env.CLASSIFICATION).toMatchObject({
				name: 'Classification',
				className: 'ClassificationWorkflow',
			});
			expect(stack.resources.Classification).toMatchObject({
				Type: 'Cloudflare.Workflow',
				LogicalId: 'Classification',
				Props: { className: 'ClassificationWorkflow' },
			});
			expect(props.access === access).toBe(true);
			expect(props.env.ACCESS_TEAM_DOMAIN).toBe(
				'https://existing-team.cloudflareaccess.com',
			);
			const audience = props.env.ACCESS_AUD;
			expect(Output.isOutput(audience)).toBe(true);
			expect(audience.identifier).toBe('aud');
			expect(Object.keys(Output.upstream(audience))).toEqual(['Web/Access']);
			const enrollment = stack.bindings['Web/Access'];
			expect(enrollment?.map((binding) => binding.sid)).toEqual(['enroll:Web']);
			expect(
				enrollment?.[0]?.data.destinations.map(
					(destination: { type: string }) => destination.type,
				),
			).toEqual(['worker', 'preview_worker']);
		}),
);
