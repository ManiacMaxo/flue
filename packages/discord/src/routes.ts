import type { Context, Env, Handler } from 'hono';
import type {
	DiscordCommandData,
	DiscordComponentData,
	DiscordDestinationRef,
	DiscordHandlerResult,
	DiscordInteraction,
	DiscordInteractionEnvelope,
	DiscordInteractionResponse,
	DiscordModalData,
	JsonValue,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_HANDLER_TIMEOUT_MS = 2_500;
const GUILD_CHANNEL_TYPES = new Set([0, 5]);
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
const encoder = new TextEncoder();

interface DiscordInteractionsHandlerOptions<E extends Env> {
	publicKey: Uint8Array;
	applicationId: string;
	bodyLimit?: number;
	handlerTimeoutMs?: number;
	interactions(input: { c: Context<E>; interaction: DiscordInteraction }): DiscordHandlerResult;
}

export function createDiscordInteractionsHandler<E extends Env>(
	options: DiscordInteractionsHandlerOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Discord route bodyLimit must be a positive integer.');
	}
	if (!Number.isSafeInteger(handlerTimeoutMs) || handlerTimeoutMs <= 0) {
		throw new TypeError('Discord route handlerTimeoutMs must be a positive integer.');
	}
	if (handlerTimeoutMs > DEFAULT_HANDLER_TIMEOUT_MS) {
		throw new TypeError('Discord route handlerTimeoutMs must not exceed 2500ms.');
	}

	return async (c) => {
		const request = c.req.raw;
		const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
		if (mediaType !== 'application/json') return response(415);

		const contentLength = request.headers.get('content-length');
		if (contentLength !== null) {
			if (!/^\d+$/.test(contentLength)) return response(400);
			if (Number(contentLength) > bodyLimit) return response(413);
		}

		let body: Uint8Array | undefined;
		try {
			body = await readBody(request, bodyLimit);
		} catch {
			return response(400);
		}
		if (!body) return response(413);

		const signature = parseHex(request.headers.get('x-signature-ed25519'), 64);
		const timestamp = request.headers.get('x-signature-timestamp');
		if (
			!signature ||
			timestamp === null ||
			timestamp.length === 0 ||
			!(await verifySignature(options.publicKey, timestamp, body, signature))
		) {
			return response(401);
		}

		const raw = parseJson(body);
		if (!isRecord(raw)) return response(400);
		const type = readInteger(raw, 'type');
		if (type === 1) return Response.json({ type: 1 });

		const applicationId = readString(raw, 'application_id');
		if (!applicationId) return response(400);
		if (applicationId !== options.applicationId) return response(403);

		const common = normalizeCommon(raw, applicationId);
		if (!common || type === undefined) return response(400);

		let interaction: DiscordInteraction;
		if (type === 2) {
			const data = normalizeCommandData(raw);
			if (!data) return response(400);
			interaction = { ...common, type: 'command', data, raw };
		} else if (type === 3) {
			const data = normalizeComponentData(raw);
			if (!data) return response(400);
			interaction = { ...common, type: 'component', data, raw };
		} else if (type === 5) {
			const data = normalizeModalData(raw);
			if (!data) return response(400);
			interaction = { ...common, type: 'modal', data, raw };
		} else {
			interaction = { ...common, type: 'unknown', interactionType: type, raw };
		}

		const outcome = await runHandler(
			() => options.interactions({ c, interaction }),
			handlerTimeoutMs,
		);
		if (outcome.type !== 'success') return response(500);
		if (outcome.value instanceof Response) return outcome.value;
		if (!isJsonValue(outcome.value)) return response(500);
		return Response.json(outcome.value);
	};
}

function normalizeCommon(
	raw: Record<string, unknown>,
	applicationId: string,
): Omit<DiscordInteractionEnvelope<string, never>, 'type' | 'data' | 'raw'> | undefined {
	const id = readString(raw, 'id');
	const token = readString(raw, 'token');
	const destination = normalizeDestination(raw);
	if (!id || !token || !destination) return undefined;
	return { id, applicationId, token, destination };
}

function normalizeDestination(raw: Record<string, unknown>): DiscordDestinationRef | undefined {
	const channelId = readString(raw, 'channel_id');
	const guildId = readOptionalString(raw, 'guild_id');
	const context = readInteger(raw, 'context');
	const channel = readRecord(raw, 'channel');
	const channelType = channel && readInteger(channel, 'type');
	const nestedChannelId = channel && readString(channel, 'id');
	if (!channelId || !nestedChannelId || nestedChannelId !== channelId) return undefined;

	if (guildId) {
		if (context !== undefined && context !== 0) return undefined;
		if (channelType === undefined) return undefined;
		if (!GUILD_CHANNEL_TYPES.has(channelType) && !THREAD_CHANNEL_TYPES.has(channelType)) {
			return undefined;
		}
		return {
			type: 'guild',
			guildId,
			channelId,
			channelKind: THREAD_CHANNEL_TYPES.has(channelType) ? 'thread' : 'channel',
		};
	}

	if (context !== undefined && context !== 1) return undefined;
	if (channelType !== 1) return undefined;
	return { type: 'dm', channelId };
}

function normalizeCommandData(raw: Record<string, unknown>): DiscordCommandData | undefined {
	const data = readRecord(raw, 'data');
	const name = data && readString(data, 'name');
	const commandType = data && readInteger(data, 'type');
	if (!data || !name || commandType !== 1) return undefined;
	const options = data.options;
	if (options !== undefined && !Array.isArray(options)) return undefined;
	return { name, options: options ?? [] };
}

function normalizeComponentData(raw: Record<string, unknown>): DiscordComponentData | undefined {
	const data = readRecord(raw, 'data');
	const customId = data && readString(data, 'custom_id');
	const componentType = data && readInteger(data, 'component_type');
	if (!data || !customId || componentType === undefined) return undefined;
	const values = data.values;
	if (
		values !== undefined &&
		(!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
	) {
		return undefined;
	}
	return { customId, componentType, ...(values === undefined ? {} : { values }) };
}

function normalizeModalData(raw: Record<string, unknown>): DiscordModalData | undefined {
	const data = readRecord(raw, 'data');
	const customId = data && readString(data, 'custom_id');
	const components = data?.components;
	if (!data || !customId || !Array.isArray(components)) return undefined;
	return { customId, components, fields: collectModalFields(components) };
}

function collectModalFields(components: readonly unknown[]): Array<{
	customId: string;
	type: number;
	value?: string;
}> {
	const fields: Array<{ customId: string; type: number; value?: string }> = [];
	for (const component of components) {
		if (!isRecord(component)) continue;
		const customId = readString(component, 'custom_id');
		const type = readInteger(component, 'type');
		const value = readAnyString(component, 'value');
		if (customId && type !== undefined) {
			fields.push({ customId, type, ...(value === undefined ? {} : { value }) });
		}
		const children = component.components;
		if (Array.isArray(children)) fields.push(...collectModalFields(children));
		if (isRecord(component.component)) fields.push(...collectModalFields([component.component]));
	}
	return fields;
}

type HandlerOutcome<T> = { type: 'success'; value: T } | { type: 'failure' } | { type: 'timeout' };

async function runHandler<T>(
	handler: () => T | Promise<T>,
	timeoutMs: number,
): Promise<HandlerOutcome<T>> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const handlerPromise = Promise.resolve()
		.then(handler)
		.then(
			(value): HandlerOutcome<T> => ({ type: 'success', value }),
			(): HandlerOutcome<T> => ({ type: 'failure' }),
		);
	const timeoutPromise = new Promise<HandlerOutcome<T>>((resolve) => {
		timeout = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
	});
	const outcome = await Promise.race([handlerPromise, timeoutPromise]);
	if (timeout !== undefined) clearTimeout(timeout);
	return outcome;
}

function isJsonValue(
	value: unknown,
	seen = new Set<object>(),
): value is JsonValue | DiscordInteractionResponse {
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

async function readBody(request: Request, bodyLimit: number): Promise<Uint8Array | undefined> {
	if (!request.body) return new Uint8Array();
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
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function parseHex(value: string | null, byteLength: number): Uint8Array | undefined {
	const expression = new RegExp(`^[0-9a-fA-F]{${byteLength * 2}}$`);
	if (!expression.test(value ?? '')) return undefined;
	const bytes = new Uint8Array(byteLength);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt((value ?? '').slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

async function verifySignature(
	publicKey: Uint8Array,
	timestamp: string,
	body: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	try {
		const prefix = encoder.encode(timestamp);
		const signed = new Uint8Array(prefix.byteLength + body.byteLength);
		signed.set(prefix);
		signed.set(body, prefix.byteLength);
		const key = await crypto.subtle.importKey(
			'raw',
			toArrayBuffer(publicKey),
			{ name: 'Ed25519' },
			false,
			['verify'],
		);
		return crypto.subtle.verify('Ed25519', key, toArrayBuffer(signature), toArrayBuffer(signed));
	} catch {
		return false;
	}
}

function parseJson(body: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
	} catch {
		return undefined;
	}
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

function response(status: number): Response {
	return new Response(null, { status });
}

function readRecord(
	value: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const field = value[key];
	return isRecord(field) ? field : undefined;
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
	return readString(value, key);
}

function readAnyString(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === 'string' ? field : undefined;
}

function readInteger(value: Record<string, unknown>, key: string): number | undefined {
	const field = value[key];
	return typeof field === 'number' && Number.isSafeInteger(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
