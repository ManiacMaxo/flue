import {
	InvalidSlackInputError,
	SlackApiError,
	SlackRateLimitError,
	SlackTimeoutError,
} from './errors.ts';
import type { SlackChannelOptions, SlackClient, SlackMessage, SlackThreadRef } from './index.ts';

const API_ORIGIN = 'https://slack.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

export function createSlackClient(options: SlackChannelOptions): SlackClient {
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	const botToken = options.botToken;
	const teamId = options.teamId;

	return {
		async postMessage(ref, message, signal) {
			assertThreadRef(ref, teamId);
			assertMessage(message);
			await request(
				'/api/chat.postMessage',
				{
					channel: ref.channelId,
					thread_ts: ref.threadTs,
					text: message.text,
					...(message.blocks === undefined ? {} : { blocks: message.blocks }),
				},
				signal,
			);
		},
		async addReaction(ref, name, signal) {
			assertThreadRef(ref, teamId);
			if (typeof name !== 'string' || name.length === 0 || name.trim() !== name) {
				throw new InvalidSlackInputError('reaction name');
			}
			await request(
				'/api/reactions.add',
				{ channel: ref.channelId, timestamp: ref.threadTs, name },
				signal,
			);
		},
	};

	async function request(
		path: string,
		body: Record<string, unknown>,
		callerSignal?: AbortSignal,
	): Promise<void> {
		let url = new URL(path, API_ORIGIN);
		let redirects = 0;
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const signal = callerSignal
			? AbortSignal.any([callerSignal, timeoutSignal])
			: timeoutSignal;

		try {
			while (true) {
				const response = await fetchImplementation(url, {
					method: 'POST',
					headers: {
						Accept: 'application/json',
						Authorization: `Bearer ${botToken}`,
						'Content-Type': 'application/json; charset=utf-8',
						'User-Agent': '@flue/slack',
					},
					body: JSON.stringify(body),
					redirect: 'manual',
					signal,
				});

				if (isRedirect(response.status)) {
					const location = response.headers.get('location');
					if (!location || redirects >= MAX_REDIRECTS) {
						throw await createApiError(response, botToken);
					}
					const nextUrl = new URL(location, url);
					if (nextUrl.protocol !== 'https:' || nextUrl.origin !== API_ORIGIN) {
						throw await createApiError(response, botToken);
					}
					void response.body?.cancel();
					url = nextUrl;
					redirects += 1;
					continue;
				}

				const payload = await readResponsePayload(response, botToken);
				if (response.ok && isRecord(payload) && payload.ok === true) return;
				throw toApiError(response, payload);
			}
		} catch (error) {
			if (timeoutSignal.aborted && !callerSignal?.aborted) {
				throw new SlackTimeoutError(timeoutMs);
			}
			throw error;
		}
	}
}

function assertThreadRef(ref: SlackThreadRef, teamId: string): void {
	if (!ref || typeof ref !== 'object') throw new InvalidSlackInputError('ref');
	if (ref.teamId !== teamId) throw new InvalidSlackInputError('teamId');
	assertIdentifier(ref.channelId, 'channelId');
	assertIdentifier(ref.threadTs, 'threadTs');
}

function assertMessage(message: SlackMessage): void {
	if (!message || typeof message !== 'object') throw new InvalidSlackInputError('message');
	if (typeof message.text !== 'string' || message.text.length === 0) {
		throw new InvalidSlackInputError('message text');
	}
	if (message.blocks !== undefined && !Array.isArray(message.blocks)) {
		throw new InvalidSlackInputError('message blocks');
	}
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new InvalidSlackInputError(field);
	}
}

function isRedirect(status: number): boolean {
	return status === 307 || status === 308;
}

async function createApiError(response: Response, token: string): Promise<SlackApiError> {
	const payload = await readResponsePayload(response, token);
	return toApiError(response, payload);
}

function toApiError(response: Response, payload: unknown): SlackApiError {
	const code =
		isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'http_error';
	const responseMessage =
		isRecord(payload) &&
		isRecord(payload.response_metadata) &&
		Array.isArray(payload.response_metadata.messages)
			? payload.response_metadata.messages
					.filter((message): message is string => typeof message === 'string')
					.join('; ')
					.slice(0, 1_000) || undefined
			: undefined;
	const retryAfterSeconds = parseNonNegativeInteger(response.headers.get('retry-after'));
	const options = {
		status: response.status,
		code,
		requestId: response.headers.get('x-slack-req-id') ?? undefined,
		responseMessage,
		retryAfterSeconds,
	};
	return response.status === 429 || code === 'ratelimited' || retryAfterSeconds !== undefined
		? new SlackRateLimitError(options)
		: new SlackApiError(options);
}

async function readResponsePayload(response: Response, token: string): Promise<unknown> {
	const bytes = await readBoundedBody(response, MAX_RESPONSE_BODY_BYTES);
	if (bytes.byteLength === 0) return undefined;
	const text = new TextDecoder().decode(bytes);
	try {
		const payload: unknown = JSON.parse(text);
		return redactStrings(payload, token);
	} catch {
		return { error: 'invalid_response' };
	}
}

function redactStrings(value: unknown, token: string): unknown {
	if (typeof value === 'string') return value.split(token).join('[REDACTED]');
	if (Array.isArray(value)) return value.map((item) => redactStrings(item, token));
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, redactStrings(item, token)]),
	);
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const remaining = limit - total;
			const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
			chunks.push(chunk);
			total += chunk.byteLength;
			if (value.byteLength >= remaining) {
				void reader.cancel();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function parseNonNegativeInteger(value: string | null): number | undefined {
	if (value === null || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
