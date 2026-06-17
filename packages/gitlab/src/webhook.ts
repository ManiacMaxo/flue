import type { Env, Handler } from 'hono';
import type { GitLabChannelOptions, GitLabWebhookPayload } from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createGitLabWebhookHandler<E extends Env>(
	options: GitLabChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('GitLab webhook bodyLimit must be a positive integer.');
	}
	const signingKey = options.signingToken ? decodeSigningToken(options.signingToken) : undefined;
	const expectedLegacyDigest = options.secretToken ? digest(options.secretToken) : undefined;

	return async (c) => {
		const request = c.req.raw;
		const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
		if (mediaType !== 'application/json') return response(415);

		const contentLength = request.headers.get('content-length');
		if (contentLength !== null) {
			if (!/^\d+$/.test(contentLength)) return response(400);
			if (Number(contentLength) > bodyLimit) return response(413);
		}

		const body = await readBody(request, bodyLimit);
		if (body.type === 'too-large') return response(413);
		if (body.type === 'invalid') return response(400);

		const signed = request.headers.get('webhook-signature') !== null;
		let signatureTimestamp: string | undefined;
		if (signed && signingKey) {
			const signatureResult = await verifySignedRequest(request.headers, body.value, signingKey);
			if (!signatureResult.ok) return response(401);
			signatureTimestamp = signatureResult.timestamp;
		} else if (expectedLegacyDigest) {
			const actualDigest = await digest(request.headers.get('x-gitlab-token') ?? '');
			if (!secureEqual(await expectedLegacyDigest, actualDigest)) return response(401);
		} else {
			return response(401);
		}

		const raw = parseJson(body.value);
		if (!isRecord(raw)) return response(400);
		const eventName = request.headers.get('x-gitlab-event');
		if (!eventName) return response(400);

		return serializeHandlerResult(
			await options.webhook({
				c,
				delivery: {
					eventName,
					payload: raw as GitLabWebhookPayload,
					deliveryId: readOptionalHeader(request.headers, 'webhook-id'),
					idempotencyKey: readOptionalHeader(request.headers, 'idempotency-key'),
					eventUuid: readOptionalHeader(request.headers, 'x-gitlab-event-uuid'),
					webhookUuid: readOptionalHeader(request.headers, 'x-gitlab-webhook-uuid'),
					instance: readOptionalHeader(request.headers, 'x-gitlab-instance'),
					...(signatureTimestamp === undefined ? {} : { signatureTimestamp }),
				},
			}),
		);
	};
}

async function verifySignedRequest(
	headers: Headers,
	body: Uint8Array,
	signingKey: Uint8Array,
): Promise<{ ok: true; timestamp: string } | { ok: false }> {
	const messageId = headers.get('webhook-id');
	const timestamp = headers.get('webhook-timestamp');
	const signatures = parseSignatures(headers.get('webhook-signature'));
	if (!messageId || !timestamp || signatures.length === 0) return { ok: false };
	const timestampSeconds = parseTimestamp(timestamp);
	if (
		timestampSeconds === undefined ||
		Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > MAX_SIGNATURE_AGE_SECONDS
	) {
		return { ok: false };
	}
	const message = signedMessage(messageId, timestamp, body);
	for (const signature of signatures) {
		if (await verifySignature(signingKey, message, signature)) return { ok: true, timestamp };
	}
	return { ok: false };
}

function parseTimestamp(value: string): number | undefined {
	if (!/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) return undefined;
	return parsed;
}

function parseSignatures(value: string | null): Uint8Array[] {
	if (!value) return [];
	const signatures: Uint8Array[] = [];
	for (const part of value.split(/\s+/)) {
		if (!part) continue;
		const encoded = /^v1,([A-Za-z0-9+/=_-]+)$/.exec(part)?.[1];
		if (!encoded) return [];
		try {
			signatures.push(decodeBase64(encoded));
		} catch {
			return [];
		}
	}
	return signatures;
}

function signedMessage(messageId: string, timestamp: string, body: Uint8Array): Uint8Array {
	const prefix = encoder.encode(`${messageId}.${timestamp}.`);
	const message = new Uint8Array(prefix.byteLength + body.byteLength);
	message.set(prefix);
	message.set(body, prefix.byteLength);
	return message;
}

async function verifySignature(
	keyBytes: Uint8Array,
	message: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	const key = await crypto.subtle.importKey(
		'raw',
		toArrayBuffer(keyBytes),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	);
	return crypto.subtle.verify('HMAC', key, toArrayBuffer(signature), toArrayBuffer(message));
}

function serializeHandlerResult(value: unknown): Response {
	if (value === undefined) return response(200);
	if (Object.prototype.toString.call(value) === '[object Response]') return value as Response;
	return Response.json(value);
}

async function readBody(
	request: Request,
	bodyLimit: number,
): Promise<{ type: 'success'; value: Uint8Array } | { type: 'too-large' } | { type: 'invalid' }> {
	if (!request.body) return { type: 'success', value: new Uint8Array() };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > bodyLimit) {
				void reader.cancel();
				return { type: 'too-large' };
			}
			chunks.push(value);
		}
	} catch {
		return { type: 'invalid' };
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { type: 'success', value: body };
}

function parseJson(body: Uint8Array): unknown {
	try {
		return JSON.parse(decoder.decode(body));
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalHeader(headers: Headers, name: string): string | undefined {
	const value = headers.get(name);
	return value && value.length > 0 ? value : undefined;
}

function decodeSigningToken(token: string): Uint8Array {
	return decodeBase64(token.slice('whsec_'.length));
}

function decodeBase64(encoded: string): Uint8Array {
	const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

function secureEqual(expected: Uint8Array, actual: Uint8Array): boolean {
	let difference = 0;
	for (let index = 0; index < expected.length; index += 1) {
		difference |= (expected[index] as number) ^ (actual[index] as number);
	}
	return difference === 0;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

function response(status: number): Response {
	return new Response(null, { status });
}
