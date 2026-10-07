import { Schema } from 'effect';

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
	env: { LOCAL_DEV?: string },
	ctx: { access?: { getIdentity(): Promise<{ email?: string } | undefined> } },
) {
	const url = new URL(request.url);
	if (
		env.LOCAL_DEV === 'true' &&
		['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
	)
		return 'local@example.test';
	if (!ctx.access) throw new HttpError(403, 'Authentication required.');
	const identity = await ctx.access.getIdentity().catch(() => {
		throw new HttpError(403, 'Authentication unavailable.');
	});
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
