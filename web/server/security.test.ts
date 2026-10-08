import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { authorize } from './security.js';

const issuer = 'https://test-team.cloudflareaccess.com';
const env = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: 'expected-application' };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let wrongKeys: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async () => {
	keys = await generateKeyPair('RS256', { extractable: true });
	wrongKeys = await generateKeyPair('RS256');
	const publicKey = {
		...(await exportJWK(keys.publicKey)),
		kid: 'fixture',
		alg: 'RS256',
		use: 'sig',
	};
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
		expect(url).toBe(`${issuer}/cdn-cgi/access/certs`);
		return Response.json({ keys: [publicKey] });
	});
});
afterAll(() => vi.restoreAllMocks());

const signedToken = (claims: JWTPayload = {}, key = keys.privateKey) =>
	new SignJWT({
		iss: issuer,
		aud: env.ACCESS_AUD,
		sub: 'verified-user',
		email: ' Friend@Test ',
		exp: Math.floor(Date.now() / 1000) + 300,
		...claims,
	})
		.setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
		.sign(key);

const request = (token: string) =>
	new Request('https://app.test/api/state', {
		headers: {
			'cf-access-jwt-assertion': token,
			'cf-access-authenticated-user-email': 'attacker@test',
		},
	});

it('accepts a signed Access JWT without ctx.access and ignores the raw email header', async () => {
	expect(await authorize(request(await signedToken()), env, {})).toBe(
		'friend@test',
	);
});

it.each([
	['wrong issuer', { iss: 'https://attacker.cloudflareaccess.com' }],
	['wrong audience', { aud: 'another-application' }],
	['expired', { exp: Math.floor(Date.now() / 1000) - 60 }],
	['not active yet', { nbf: Math.floor(Date.now() / 1000) + 600 }],
	['missing email', { email: undefined }],
	['empty email', { email: ' ' }],
	['non-string email', { email: 42 }],
] satisfies Array<[string, JWTPayload]>)(
	'rejects %s claims',
	async (_name, claims) => {
		await expect(
			authorize(request(await signedToken(claims)), env, {}),
		).rejects.toThrow('Access denied.');
	},
);

it('rejects forged signatures, unsigned tokens, and tokens without expiration', async () => {
	const forged = await signedToken({}, wrongKeys.privateKey);
	const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"email":"attacker@test"}').toString('base64url')}.`;
	const noExpiration = await new SignJWT({
		iss: issuer,
		aud: env.ACCESS_AUD,
		sub: 'verified-user',
		email: 'friend@test',
	})
		.setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
		.sign(keys.privateKey);
	for (const token of [forged, unsigned, noExpiration]) {
		await expect(authorize(request(token), env, {})).rejects.toThrow(
			'Access denied.',
		);
	}
});

it('fails closed without the assertion or trusted issuer/audience configuration', async () => {
	await expect(
		authorize(
			new Request('https://app.test', {
				headers: { 'cf-access-authenticated-user-email': 'attacker@test' },
			}),
			env,
			{},
		),
	).rejects.toThrow('Authentication required.');
	const validRequest = request(await signedToken());
	for (const config of [
		{},
		{ ACCESS_TEAM_DOMAIN: issuer },
		{ ACCESS_AUD: env.ACCESS_AUD },
	]) {
		await expect(authorize(validRequest, config, {})).rejects.toThrow(
			'Authentication unavailable.',
		);
	}
});
