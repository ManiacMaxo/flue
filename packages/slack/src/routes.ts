import type { Context, Env, Handler } from 'hono';
import type {
	JsonValue,
	SlackEventsApiPayload,
	SlackHandlerResult,
	SlackInteractionPayload,
	SlackSlashCommandPayload,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_HANDLER_TIMEOUT_MS = 2_500;
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;
const encoder = new TextEncoder();

interface SharedRouteOptions {
	signingSecret: string;
	appId: string;
	teamId: string;
	bodyLimit?: number;
	handlerTimeoutMs?: number;
}

interface SlackEventsHandlerOptions<E extends Env> extends SharedRouteOptions {
	events(input: { c: Context<E>; payload: SlackEventsApiPayload }): SlackHandlerResult;
}

interface SlackInteractionsHandlerOptions<E extends Env> extends SharedRouteOptions {
	interactions(input: { c: Context<E>; payload: SlackInteractionPayload }): SlackHandlerResult;
}

interface SlackCommandsHandlerOptions<E extends Env> extends SharedRouteOptions {
	commands(input: { c: Context<E>; payload: SlackSlashCommandPayload }): SlackHandlerResult;
}

export function createSlackEventsHandler<E extends Env>(
	options: SlackEventsHandlerOptions<E>,
): Handler<E> {
	const route = prepareRoute(options);

	return async (c) => {
		const request = c.req.raw;
		const verified = await route.verify(request, 'application/json');
		if (verified instanceof Response) return verified;
		const raw = parseJson(verified.body);
		if (!isRecord(raw)) return response(400);

		const envelopeType = readString(raw, 'type');
		if (envelopeType === 'url_verification') {
			const challenge = readString(raw, 'challenge');
			if (challenge === undefined) return response(400);
			return Response.json({ challenge }, { status: 200 });
		}
		const appId = readString(raw, 'api_app_id');
		const teamId = readString(raw, 'team_id');
		if (!envelopeType || !appId || !teamId) return response(400);
		if (appId !== options.appId || teamId !== options.teamId) return response(403);
		if (isEnterpriseInstall(raw)) return response(403);

		if (envelopeType === 'event_callback') {
			const eventId = readString(raw, 'event_id');
			const event = readRecord(raw, 'event');
			if (!eventId || !event || !readString(event, 'type')) return response(400);
		}

		return invokeHandler(
			() => options.events({ c, payload: raw as unknown as SlackEventsApiPayload }),
			route.handlerTimeoutMs,
		);
	};
}

export function createSlackInteractionsHandler<E extends Env>(
	options: SlackInteractionsHandlerOptions<E>,
): Handler<E> {
	const route = prepareRoute(options);

	return async (c) => {
		const request = c.req.raw;
		const verified = await route.verify(request, 'application/x-www-form-urlencoded');
		if (verified instanceof Response) return verified;
		const raw = parseFormPayload(verified.body);
		if (!isRecord(raw)) return response(400);

		const payloadAppId = raw.api_app_id;
		if (payloadAppId !== undefined && typeof payloadAppId !== 'string') return response(400);
		const team = readRecord(raw, 'team');
		const teamId = team && readString(team, 'id');
		const user = readRecord(raw, 'user');
		const userId = user && readString(user, 'id');
		const type = readString(raw, 'type');
		if (!type || !teamId || !userId) return response(400);
		if (typeof payloadAppId === 'string' && payloadAppId !== options.appId) return response(403);
		if (teamId !== options.teamId || isEnterpriseInstall(raw)) return response(403);
		return invokeHandler(
			() => options.interactions({ c, payload: raw as unknown as SlackInteractionPayload }),
			route.handlerTimeoutMs,
		);
	};
}

export function createSlackCommandsHandler<E extends Env>(
	options: SlackCommandsHandlerOptions<E>,
): Handler<E> {
	const route = prepareRoute(options);

	return async (c) => {
		const request = c.req.raw;
		const verified = await route.verify(request, 'application/x-www-form-urlencoded');
		if (verified instanceof Response) return verified;
		const form = parseForm(verified.body);
		if (!form) return response(400);

		const appId = readRequiredFormValue(form, 'api_app_id');
		const teamId = readRequiredFormValue(form, 'team_id');
		const channelId = readRequiredFormValue(form, 'channel_id');
		const userId = readRequiredFormValue(form, 'user_id');
		const commandName = readRequiredFormValue(form, 'command');
		const text = readRequiredFormValue(form, 'text', true);
		const triggerId = readRequiredFormValue(form, 'trigger_id');
		const responseUrl = readRequiredFormValue(form, 'response_url');
		const enterpriseInstall = readOptionalFormBoolean(form, 'is_enterprise_install');
		if (
			!appId ||
			!teamId ||
			!channelId ||
			!userId ||
			!commandName ||
			text === undefined ||
			!triggerId ||
			!responseUrl ||
			enterpriseInstall === null
		) {
			return response(400);
		}
		if (appId !== options.appId || teamId !== options.teamId || enterpriseInstall === true) {
			return response(403);
		}

		return invokeHandler(
			() =>
				options.commands({
					c,
					payload: formToRecord(form) as unknown as SlackSlashCommandPayload,
				}),
			route.handlerTimeoutMs,
		);
	};
}

async function invokeHandler(
	handler: () => SlackHandlerResult,
	timeoutMs: number,
): Promise<Response> {
	const outcome = await runHandler(handler, timeoutMs);
	if (outcome.type !== 'success') return response(500);
	return serializeHandlerResult(outcome.value);
}

function prepareRoute(options: SharedRouteOptions): {
	handlerTimeoutMs: number;
	verify(request: Request, expectedMediaType: string): Promise<{ body: Uint8Array } | Response>;
} {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Slack route bodyLimit must be a positive integer.');
	}
	if (!Number.isSafeInteger(handlerTimeoutMs) || handlerTimeoutMs <= 0) {
		throw new TypeError('Slack route handlerTimeoutMs must be a positive integer.');
	}
	if (handlerTimeoutMs > DEFAULT_HANDLER_TIMEOUT_MS) {
		throw new TypeError('Slack route handlerTimeoutMs must not exceed 2500ms.');
	}
	const secret = encoder.encode(options.signingSecret);

	return {
		handlerTimeoutMs,
		async verify(request, expectedMediaType) {
			const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
			if (mediaType !== expectedMediaType) return response(415);

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

			const timestampText = request.headers.get('x-slack-request-timestamp');
			const timestamp = parseTimestamp(timestampText);
			const signature = parseSignature(request.headers.get('x-slack-signature'));
			if (
				timestampText === null ||
				timestamp === undefined ||
				Math.abs(Math.floor(Date.now() / 1000) - timestamp) > MAX_SIGNATURE_AGE_SECONDS ||
				!signature ||
				!(await verifySignature(secret, timestampText, body, signature))
			) {
				return response(401);
			}
			return { body };
		},
	};
}

function isEnterpriseInstall(raw: Record<string, unknown>): boolean {
	if (raw.is_enterprise_install === true) return true;
	if (!Array.isArray(raw.authorizations)) return false;
	return raw.authorizations.some(
		(authorization) => isRecord(authorization) && authorization.is_enterprise_install === true,
	);
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

function serializeHandlerResult(value: unknown): Response {
	const fetchResponse = normalizeFetchResponse(value);
	if (fetchResponse) return fetchResponse;
	if (Object.prototype.toString.call(value) === '[object Response]') return response(500);
	if (value === undefined) return response(200);
	if (!isJsonValue(value)) return response(500);
	return Response.json(value);
}

function normalizeFetchResponse(value: unknown): Response | undefined {
	if (value instanceof globalThis.Response) return value;
	if (Object.prototype.toString.call(value) !== '[object Response]') return undefined;
	if (typeof value !== 'object' || value === null) return undefined;
	try {
		const response = value as Response;
		if (
			!Number.isInteger(response.status) ||
			response.status < 200 ||
			response.status > 599 ||
			typeof response.statusText !== 'string' ||
			typeof response.headers?.entries !== 'function' ||
			(response.body !== null && typeof response.body !== 'object')
		) {
			return undefined;
		}
		return new globalThis.Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: new globalThis.Headers(response.headers),
		});
	} catch {
		return undefined;
	}
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

function parseTimestamp(value: string | null): number | undefined {
	return parseNonNegativeInteger(value);
}

function parseSignature(value: string | null): Uint8Array | undefined {
	const match = /^v0=([0-9a-fA-F]{64})$/.exec(value ?? '');
	if (!match?.[1]) return undefined;
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(match[1].slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

async function verifySignature(
	secret: Uint8Array,
	timestamp: string,
	body: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	const prefix = encoder.encode(`v0:${timestamp}:`);
	const signed = new Uint8Array(prefix.byteLength + body.byteLength);
	signed.set(prefix);
	signed.set(body, prefix.byteLength);
	const key = await crypto.subtle.importKey(
		'raw',
		toArrayBuffer(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	);
	return crypto.subtle.verify('HMAC', key, toArrayBuffer(signature), toArrayBuffer(signed));
}

function parseJson(body: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
	} catch {
		return undefined;
	}
}

function parseFormPayload(body: Uint8Array): unknown {
	try {
		const form = parseForm(body);
		if (!form) return undefined;
		const payloads = form.getAll('payload');
		if (payloads.length !== 1) return undefined;
		return JSON.parse(payloads[0] ?? '');
	} catch {
		return undefined;
	}
}

function parseForm(body: Uint8Array): URLSearchParams | undefined {
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
		return new URLSearchParams(text);
	} catch {
		return undefined;
	}
}

function readRequiredFormValue(
	form: URLSearchParams,
	key: string,
	allowEmpty = false,
): string | undefined {
	const values = form.getAll(key);
	if (values.length !== 1) return undefined;
	const value = values[0];
	if (value === undefined || (!allowEmpty && value.length === 0)) return undefined;
	return value;
}

function readOptionalFormBoolean(
	form: URLSearchParams,
	key: string,
): boolean | undefined | null {
	const values = form.getAll(key);
	if (values.length === 0) return undefined;
	if (values.length !== 1) return null;
	if (values[0] === 'true') return true;
	if (values[0] === 'false') return false;
	return null;
}

function formToRecord(form: URLSearchParams): Record<string, string | string[]> {
	const record: Record<string, string | string[]> = {};
	for (const key of new Set(form.keys())) {
		const values = form.getAll(key);
		record[key] = values.length === 1 && values[0] !== undefined ? values[0] : values;
	}
	return record;
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
	return typeof field === 'string' ? field : undefined;
}

function parseNonNegativeInteger(value: string | null): number | undefined {
	if (value === null || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
