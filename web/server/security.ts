import { Schema } from 'effect';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const AccessIdentity = Schema.Struct({ email: Schema.String });
let accessKeys:
	| { issuer: string; jwks: ReturnType<typeof createRemoteJWKSet> }
	| undefined;

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}
export const requestError = (error: unknown) =>
	error instanceof HttpError
		? error
		: new HttpError(400, 'Request failed. Please try again.');
export async function authorize(
	request: Request,
	env: { LOCAL_DEV?: string; ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string },
	ctx: { access?: { getIdentity(): Promise<{ email?: string } | undefined> } },
) {
	const url = new URL(request.url);
	if (
		env.LOCAL_DEV === 'true' &&
		['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
	)
		return 'local@example.test';
	let identity: { email?: string } | undefined;
	if (ctx.access) {
		identity = await ctx.access.getIdentity().catch(() => {
			throw new HttpError(403, 'Authentication unavailable.');
		});
	} else {
		// Cloudflare's Static Assets router does not forward ctx.access.
		const token = request.headers.get('cf-access-jwt-assertion');
		if (!token) throw new HttpError(403, 'Authentication required.');
		if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)
			throw new HttpError(403, 'Authentication unavailable.');
		try {
			if (accessKeys?.issuer !== env.ACCESS_TEAM_DOMAIN) {
				accessKeys = {
					issuer: env.ACCESS_TEAM_DOMAIN,
					jwks: createRemoteJWKSet(
						new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
					),
				};
			}
			const { payload } = await jwtVerify(token, accessKeys.jwks, {
				issuer: env.ACCESS_TEAM_DOMAIN,
				audience: env.ACCESS_AUD,
				algorithms: ['RS256'],
				requiredClaims: ['exp', 'sub'],
			});
			identity = Schema.decodeUnknownSync(AccessIdentity)(payload);
		} catch {
			throw new HttpError(403, 'Access denied.');
		}
	}
	if (!identity?.email?.trim()) throw new HttpError(403, 'Access denied.');
	return identity.email.trim().toLowerCase();
}
export async function readBody(request: Request) {
	if (
		request.headers.get('origin') !== new URL(request.url).origin ||
		request.headers.get('x-requested-with') !== 'steam-organizer' ||
		request.headers.get('content-type')?.split(';')[0]?.trim() !==
			'application/json'
	)
		throw new HttpError(403, 'Invalid mutation request.');
	const limit = 2 * 1024 * 1024;
	if (Number(request.headers.get('content-length')) > limit)
		throw new HttpError(413, 'Upload too large.');
	const reader = request.body?.getReader();
	if (!reader) throw new HttpError(400, 'JSON body required.');
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw new HttpError(413, 'Upload too large.');
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	try {
		return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
			new TextDecoder().decode(bytes),
		);
	} catch {
		throw new HttpError(400, 'Invalid JSON.');
	}
}
export function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
		},
	});
}
