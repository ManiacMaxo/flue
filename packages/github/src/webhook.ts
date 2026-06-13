import type { Context, Env, Handler } from 'hono';
import type {
	GitHubEvent,
	GitHubEvents,
	GitHubWebhookEvent,
	GitHubWebhookHandlerResult,
	JsonValue,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 25 * 1024 * 1024;
const encoder = new TextEncoder();

interface GitHubWebhookHandlerOptions<E extends Env> {
	webhookSecret: string;
	bodyLimit?: number;
	webhook(input: { c: Context<E>; event: GitHubEvent }): GitHubWebhookHandlerResult;
}

export function createGitHubWebhookHandler<E extends Env>(
	options: GitHubWebhookHandlerOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('GitHub webhook bodyLimit must be a positive integer.');
	}
	const secret = encoder.encode(options.webhookSecret);

	return async (c) => {
		const request = c.req.raw;
		const contentLength = request.headers.get('content-length');
		if (contentLength !== null) {
			if (!/^\d+$/.test(contentLength)) return new Response(null, { status: 400 });
			if (Number(contentLength) > bodyLimit) return new Response(null, { status: 413 });
		}

		const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
		if (mediaType !== 'application/json' && mediaType !== 'application/x-www-form-urlencoded') {
			return new Response(null, { status: 415 });
		}

		let body: Uint8Array | undefined;
		try {
			body = await readBody(request, bodyLimit);
		} catch {
			return new Response(null, { status: 400 });
		}
		if (!body) return new Response(null, { status: 413 });

		const signature = parseSignature(request.headers.get('x-hub-signature-256'));
		if (!signature || !(await verifySignature(secret, body, signature))) {
			return new Response(null, { status: 401 });
		}

		const raw = parsePayload(body, mediaType);
		if (!isRecord(raw)) return new Response(null, { status: 400 });

		const eventName = request.headers.get('x-github-event');
		const deliveryId = request.headers.get('x-github-delivery');
		if (!eventName || !deliveryId) return new Response(null, { status: 400 });
		if (eventName === 'ping') return new Response(null, { status: 200 });

		if (isSupportedBaseEvent(eventName) && typeof raw.action !== 'string') {
			return new Response(null, { status: 400 });
		}
		const action = readString(raw, 'action');
		const type = action ? `${eventName}.${action}` : undefined;
		const event = isGitHubEventName(type)
			? normalizeEvent(type, raw, request.headers, deliveryId)
			: normalizeUnknownEvent(eventName, action, raw, request.headers, deliveryId);
		if (!event) return new Response(null, { status: 400 });

		try {
			const result = await options.webhook({ c, event });
			return serializeHandlerResult(c, result);
		} catch {
			return new Response(null, { status: 500 });
		}
	};
}

function serializeHandlerResult<E extends Env>(_c: Context<E>, value: unknown): Response {
	if (value instanceof Response) return value;
	if (value === undefined) return new Response(null, { status: 200 });
	if (!isJsonValue(value)) return new Response(null, { status: 500 });
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

function parseSignature(value: string | null): Uint8Array | undefined {
	const match = /^sha256=([0-9a-fA-F]{64})$/.exec(value ?? '');
	if (!match) return undefined;
	const hex = match[1];
	if (!hex) return undefined;
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

async function verifySignature(
	secret: Uint8Array,
	body: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	const key = await crypto.subtle.importKey(
		'raw',
		toArrayBuffer(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	);
	return crypto.subtle.verify('HMAC', key, toArrayBuffer(signature), toArrayBuffer(body));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

function parsePayload(body: Uint8Array, mediaType: string): unknown {
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
		if (mediaType === 'application/json') return JSON.parse(text);
		const form = new URLSearchParams(text);
		const payloads = form.getAll('payload');
		if (payloads.length !== 1) return undefined;
		return JSON.parse(payloads[0] ?? '');
	} catch {
		return undefined;
	}
}

function isGitHubEventName(value: string | undefined): value is keyof GitHubEvents {
	return (
		value === 'issues.opened' ||
		value === 'issue_comment.created' ||
		value === 'pull_request.opened'
	);
}

function isSupportedBaseEvent(value: string): boolean {
	return value === 'issues' || value === 'issue_comment' || value === 'pull_request';
}

function normalizeUnknownEvent(
	event: string,
	action: string | undefined,
	raw: Record<string, unknown>,
	headers: Headers,
	deliveryId: string,
): GitHubEvent {
	return {
		type: 'unknown',
		event,
		...(action === undefined ? {} : { action }),
		deliveryId,
		hookId: readOptionalHeader(headers, 'x-github-hook-id'),
		installationTarget: readInstallationTarget(headers),
		installationId: readInstallationId(raw) ?? undefined,
		raw,
	};
}

function normalizeEvent(
	type: keyof GitHubEvents,
	raw: Record<string, unknown>,
	headers: Headers,
	deliveryId: string,
): GitHubEvents[keyof GitHubEvents] | undefined {
	const repository = readRecord(raw, 'repository');
	const owner = repository && readRecord(repository, 'owner');
	const repositoryId = repository && readPositiveInteger(repository, 'id');
	const repositoryName = repository && readNonEmptyString(repository, 'name');
	const ownerLogin = owner && readNonEmptyString(owner, 'login');
	if (!repositoryId || !repositoryName || !ownerLogin) return undefined;

	const installationId = readInstallationId(raw);
	if (installationId === null) return undefined;
	const common = {
		type,
		deliveryId,
		hookId: readOptionalHeader(headers, 'x-github-hook-id'),
		installationTarget: readInstallationTarget(headers),
		installationId,
		repository: { id: repositoryId, owner: ownerLogin, name: repositoryName },
		raw,
	};

	if (type === 'issues.opened') {
		const issue = readRecord(raw, 'issue');
		const number = issue && readPositiveInteger(issue, 'number');
		const title = issue && readString(issue, 'title');
		const body = issue && readNullableString(issue, 'body');
		if (!number || title === undefined || body === undefined) return undefined;
		return {
			...common,
			type,
			payload: { issue: { number, title, body } },
		} satisfies GitHubWebhookEvent<'issues.opened', GitHubEvents['issues.opened']['payload']>;
	}

	if (type === 'issue_comment.created') {
		const issue = readRecord(raw, 'issue');
		const comment = readRecord(raw, 'comment');
		const issueNumber = issue && readPositiveInteger(issue, 'number');
		const commentId = comment && readPositiveInteger(comment, 'id');
		const body = comment && readString(comment, 'body');
		if (!issueNumber || !commentId || body === undefined) return undefined;
		return {
			...common,
			type,
			payload: {
				issue: { number: issueNumber },
				comment: { id: commentId, body },
			},
		} satisfies GitHubWebhookEvent<
			'issue_comment.created',
			GitHubEvents['issue_comment.created']['payload']
		>;
	}

	const pullRequest = readRecord(raw, 'pull_request');
	const number = pullRequest && readPositiveInteger(pullRequest, 'number');
	const title = pullRequest && readString(pullRequest, 'title');
	const body = pullRequest && readNullableString(pullRequest, 'body');
	if (!number || title === undefined || body === undefined) return undefined;
	return {
		...common,
		type,
		payload: { pullRequest: { number, title, body } },
	} satisfies GitHubWebhookEvent<
		'pull_request.opened',
		GitHubEvents['pull_request.opened']['payload']
	>;
}

function readInstallationTarget(headers: Headers): { id: string; type: string } | undefined {
	const id = readOptionalHeader(headers, 'x-github-hook-installation-target-id');
	const type = readOptionalHeader(headers, 'x-github-hook-installation-target-type');
	return id && type ? { id, type } : undefined;
}

function readInstallationId(raw: Record<string, unknown>): number | undefined | null {
	if (!Object.hasOwn(raw, 'installation') || raw.installation === null) return undefined;
	const installation = readRecord(raw, 'installation');
	if (!installation) return null;
	return readPositiveInteger(installation, 'id') ?? null;
}

function readOptionalHeader(headers: Headers, name: string): string | undefined {
	const value = headers.get(name);
	return value && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function readNonEmptyString(value: Record<string, unknown>, key: string): string | undefined {
	const field = readString(value, key);
	return field && field.length > 0 ? field : undefined;
}

function readNullableString(
	value: Record<string, unknown>,
	key: string,
): string | null | undefined {
	const field = value[key];
	return field === null || typeof field === 'string' ? field : undefined;
}

function readPositiveInteger(value: Record<string, unknown>, key: string): number | undefined {
	const field = value[key];
	return Number.isSafeInteger(field) && (field as number) > 0 ? (field as number) : undefined;
}
