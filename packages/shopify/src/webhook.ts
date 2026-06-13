import type { Env, Handler } from 'hono';
import { isSafeNumber, parse } from 'lossless-json';
import type { JsonValue, ShopifyChannelOptions, ShopifyWebhookEvent } from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_HANDLER_TIMEOUT_MS = 4_500;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createShopifyWebhookHandler<E extends Env>(
	options: ShopifyChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Shopify webhook bodyLimit must be a positive integer.');
	}
	if (
		!Number.isSafeInteger(handlerTimeoutMs) ||
		handlerTimeoutMs <= 0 ||
		handlerTimeoutMs > DEFAULT_HANDLER_TIMEOUT_MS
	) {
		throw new TypeError('Shopify webhook handlerTimeoutMs must be between 1 and 4500.');
	}

	const keyPromises = [options.clientSecret, options.previousClientSecret]
		.filter((secret): secret is string => secret !== undefined)
		.map((secret) => importHmacKey(secret));

	return (c) =>
		runRoute(async () => {
			const request = c.req.raw;
			if (!isJsonRequest(request)) return response(415);

			const contentLength = request.headers.get('content-length');
			if (contentLength !== null && !/^\d+$/.test(contentLength)) return response(400);
			if (contentLength !== null && Number(contentLength) > bodyLimit) return response(413);

			const signature = parseSignature(request.headers.get('x-shopify-hmac-sha256'));
			if (!signature) return response(401);

			const metadata = readMetadata(request.headers);
			if (!metadata) return response(400);

			const body = await readBody(request, bodyLimit);
			if (body.type === 'too-large') return response(413);
			if (body.type === 'invalid') return response(400);

			if (!(await verifyAnySignature(keyPromises, body.value, signature))) {
				return response(401);
			}

			let rawBody: string;
			try {
				rawBody = decoder.decode(body.value);
			} catch {
				return response(400);
			}

			let payload: JsonValue;
			try {
				payload = parse(rawBody, null, {
					parseNumber: (value) => (isSafeNumber(value) ? Number(value) : value),
				}) as JsonValue;
			} catch {
				return response(400);
			}

			const event: ShopifyWebhookEvent = {
				...metadata,
				payload,
				rawBody,
			};
			return serializeHandlerResult(await options.webhook({ c, event }));
		}, handlerTimeoutMs);
}

function readMetadata(
	headers: Headers,
): Omit<ShopifyWebhookEvent, 'payload' | 'rawBody'> | undefined {
	const topic = readRequiredHeader(headers, 'x-shopify-topic');
	const shopDomain = readRequiredHeader(headers, 'x-shopify-shop-domain');
	const apiVersion = readRequiredHeader(headers, 'x-shopify-api-version');
	const webhookId = readRequiredHeader(headers, 'x-shopify-webhook-id');
	if (!topic || !shopDomain || !apiVersion || !webhookId) return undefined;

	const eventId = readOptionalHeader(headers, 'x-shopify-event-id');
	const triggeredAt = readOptionalHeader(headers, 'x-shopify-triggered-at');
	const name = readOptionalHeader(headers, 'x-shopify-name');
	const subTopic = readOptionalHeader(headers, 'x-shopify-sub-topic');
	if (eventId === false || triggeredAt === false || name === false || subTopic === false) {
		return undefined;
	}

	return {
		topic,
		shopDomain,
		apiVersion,
		webhookId,
		...(eventId ? { eventId } : {}),
		...(triggeredAt ? { triggeredAt } : {}),
		...(name ? { name } : {}),
		...(subTopic ? { subTopic } : {}),
	};
}

function readRequiredHeader(headers: Headers, name: string): string | undefined {
	const value = headers.get(name);
	return value && value.trim() === value ? value : undefined;
}

function readOptionalHeader(headers: Headers, name: string): string | false | undefined {
	const value = headers.get(name);
	if (value === null) return undefined;
	return value.length > 0 && value.trim() === value ? value : false;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	);
}

async function verifyAnySignature(
	keyPromises: Promise<CryptoKey>[],
	body: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	try {
		const keys = await Promise.all(keyPromises);
		const signatureBuffer = copyArrayBuffer(signature);
		const bodyBuffer = copyArrayBuffer(body);
		const results = await Promise.all(
			keys.map((key) => crypto.subtle.verify('HMAC', key, signatureBuffer, bodyBuffer)),
		);
		return results.some(Boolean);
	} catch {
		return false;
	}
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function parseSignature(value: string | null): Uint8Array | undefined {
	if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined;
	try {
		const binary = atob(value);
		if (binary.length !== 32) return undefined;
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return undefined;
	}
}

async function runRoute(route: () => Promise<Response>, timeoutMs: number): Promise<Response> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const routePromise = Promise.resolve()
		.then(route)
		.catch(() => response(500));
	const timeoutPromise = new Promise<Response>((resolve) => {
		timeout = setTimeout(() => resolve(response(500)), timeoutMs);
	});
	const outcome = await Promise.race([routePromise, timeoutPromise]);
	if (timeout !== undefined) clearTimeout(timeout);
	return outcome;
}

function serializeHandlerResult(value: unknown): Response {
	if (value instanceof Response) return value;
	if (value === undefined) return response(200);
	if (!isJsonValue(value)) return response(500);
	return Response.json(value);
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object') return false;
	if (seen.has(value)) return false;
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
	seen.add(value);
	try {
		return Array.isArray(value)
			? value.every((item) => isJsonValue(item, seen))
			: Object.values(value).every((item) => isJsonValue(item, seen));
	} finally {
		seen.delete(value);
	}
}

function isJsonRequest(request: Request): boolean {
	return (
		request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
		'application/json'
	);
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

function response(status: number): Response {
	return new Response(null, { status });
}
