import type { Context, Env, Handler } from 'hono';
import type {
	JsonValue,
	SlackActionEnvelope,
	SlackEvent,
	SlackEvents,
	SlackHandlerResult,
	SlackInteraction,
	SlackUnknownEvent,
	SlackUnknownInteraction,
	SlackViewSubmissionEnvelope,
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
	events(input: { c: Context<E>; event: SlackEvent }): SlackHandlerResult;
}

interface SlackInteractionsHandlerOptions<E extends Env> extends SharedRouteOptions {
	interactions(input: { c: Context<E>; interaction: SlackInteraction }): SlackHandlerResult;
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
			const appId = readString(raw, 'api_app_id');
			const teamId = readString(raw, 'team_id');
			if (challenge === undefined || !appId || !teamId) return response(400);
			if (appId !== options.appId || teamId !== options.teamId) return response(403);
			return Response.json({ challenge }, { status: 200 });
		}
		if (envelopeType !== 'event_callback') {
			const appId = readString(raw, 'api_app_id');
			const teamId = readString(raw, 'team_id');
			if (!appId || !teamId) return response(400);
			if (appId !== options.appId || teamId !== options.teamId) return response(403);
			const eventId = readOptionalString(raw, 'event_id');
			return invokeEvent(
				options.events,
				c,
				{
					type: 'unknown',
					eventType: envelopeType ?? 'unknown',
					...(eventId === undefined ? {} : { eventId }),
					appId,
					teamId,
					retry: readRetry(request.headers),
					raw,
				},
				route.handlerTimeoutMs,
			);
		}

		const appId = readString(raw, 'api_app_id');
		const teamId = readString(raw, 'team_id');
		const eventId = readString(raw, 'event_id');
		const event = readRecord(raw, 'event');
		if (!appId || !teamId || !eventId || !event) return response(400);
		if (appId !== options.appId || teamId !== options.teamId) return response(403);

		const eventType = readString(event, 'type');
		if (
			eventType === 'message' &&
			(Object.hasOwn(event, 'subtype') || Object.hasOwn(event, 'bot_id'))
		) {
			return response(200);
		}

		const normalized =
			eventType === 'app_mention' || eventType === 'message'
				? normalizeEvent(eventType, raw, event, request.headers)
				: ({
						type: 'unknown',
						eventType: eventType ?? 'unknown',
						eventId,
						appId,
						teamId,
						retry: readRetry(request.headers),
						raw,
					} satisfies SlackUnknownEvent);
		if (!normalized) return response(400);
		return invokeEvent(options.events, c, normalized, route.handlerTimeoutMs);
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

		const appId = readString(raw, 'api_app_id');
		const team = readRecord(raw, 'team');
		const teamId = team && readString(team, 'id');
		const user = readRecord(raw, 'user');
		const userId = user && readString(user, 'id');
		if (!appId || !teamId || !userId) return response(403);
		if (appId !== options.appId || teamId !== options.teamId) return response(403);

		const type = readString(raw, 'type');
		let interaction: SlackInteraction | undefined;
		if (type === 'block_actions') {
			interaction = normalizeAction(raw, appId, teamId, userId);
		} else if (type === 'view_submission') {
			interaction = normalizeView(raw, appId, teamId, userId);
		} else {
			interaction = {
				type: 'unknown',
				interactionType: type ?? 'unknown',
				appId,
				teamId,
				userId,
				raw,
			} satisfies SlackUnknownInteraction;
		}
		if (!interaction) return response(400);
		return invokeInteraction(options.interactions, c, interaction, route.handlerTimeoutMs);
	};
}

async function invokeEvent<E extends Env>(
	handler: (input: { c: Context<E>; event: SlackEvent }) => SlackHandlerResult,
	c: Context<E>,
	event: SlackEvent,
	timeoutMs: number,
): Promise<Response> {
	const outcome = await runHandler(() => handler({ c, event }), timeoutMs);
	if (outcome.type !== 'success') return response(500);
	return serializeHandlerResult(outcome.value);
}

async function invokeInteraction<E extends Env>(
	handler: (input: { c: Context<E>; interaction: SlackInteraction }) => SlackHandlerResult,
	c: Context<E>,
	interaction: SlackInteraction,
	timeoutMs: number,
): Promise<Response> {
	const outcome = await runHandler(() => handler({ c, interaction }), timeoutMs);
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

function normalizeEvent(
	type: keyof SlackEvents,
	raw: Record<string, unknown>,
	event: Record<string, unknown>,
	headers: Headers,
): SlackEvents[keyof SlackEvents] | undefined {
	const appId = readString(raw, 'api_app_id');
	const teamId = readString(raw, 'team_id');
	const eventId = readString(raw, 'event_id');
	const channelId = readString(event, 'channel');
	const messageTs = readString(event, 'ts');
	const threadTs = readOptionalString(event, 'thread_ts');
	const text = readString(event, 'text');
	const userId = readString(event, 'user');
	if (!appId || !teamId || !eventId || !channelId || !messageTs || text === undefined || !userId) {
		return undefined;
	}
	const common = {
		type,
		eventId,
		appId,
		teamId,
		retry: readRetry(headers),
		raw,
	};
	return {
		...common,
		type,
		payload: { channelId, messageTs, threadTs, text, userId },
	};
}

function normalizeAction(
	raw: Record<string, unknown>,
	appId: string,
	teamId: string,
	userId: string,
): SlackActionEnvelope | undefined {
	const actions = raw.actions;
	if (!Array.isArray(actions) || actions.length !== 1 || !isRecord(actions[0])) return undefined;
	const action = actions[0];
	const actionId = readString(action, 'action_id');
	if (!actionId) return undefined;
	const value = readOptionalString(action, 'value');
	const channel = readRecord(raw, 'channel');
	const message = readRecord(raw, 'message');
	const container = readRecord(raw, 'container');
	if (!container || readString(container, 'type') !== 'message') return undefined;
	const channelId =
		(channel && readOptionalString(channel, 'id')) ?? readOptionalString(container, 'channel_id');
	const messageTs =
		(message && readOptionalString(message, 'ts')) ?? readOptionalString(container, 'message_ts');
	const threadTs =
		(message && readOptionalString(message, 'thread_ts')) ??
		readOptionalString(container, 'thread_ts') ??
		messageTs;
	if (!channelId || !messageTs || !threadTs) return undefined;
	return {
		type: 'action',
		appId,
		teamId,
		userId,
		actionId,
		...(value === undefined ? {} : { value }),
		channelId,
		messageTs,
		threadTs,
		payload: action,
		raw,
	};
}

function normalizeView(
	raw: Record<string, unknown>,
	appId: string,
	teamId: string,
	userId: string,
): SlackViewSubmissionEnvelope | undefined {
	const view = readRecord(raw, 'view');
	const viewId = view && readString(view, 'id');
	const callbackId = view && readString(view, 'callback_id');
	const state = view && readRecord(view, 'state');
	if (!viewId || !callbackId || !state || !Object.hasOwn(state, 'values')) return undefined;
	return {
		type: 'view_submission',
		appId,
		teamId,
		userId,
		viewId,
		callbackId,
		privateMetadata: readOptionalString(view, 'private_metadata'),
		values: state.values,
		raw,
	};
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

function readRetry(headers: Headers): { number: number; reason?: string } | undefined {
	const number = parseNonNegativeInteger(headers.get('x-slack-retry-num'));
	if (number === undefined) return undefined;
	const reason = headers.get('x-slack-retry-reason') ?? undefined;
	return { number, reason };
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
		const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
		const form = new URLSearchParams(text);
		const payloads = form.getAll('payload');
		if (payloads.length !== 1) return undefined;
		return JSON.parse(payloads[0] ?? '');
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
	return typeof field === 'string' ? field : undefined;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
	const field = readString(value, key);
	return field && field.length > 0 ? field : undefined;
}

function parseNonNegativeInteger(value: string | null): number | undefined {
	if (value === null || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
