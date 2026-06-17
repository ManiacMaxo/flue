import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
	createGitLabChannel,
	type GitLabChannel,
	InvalidGitLabConversationKeyError,
} from '../src/index.ts';

const encoder = new TextEncoder();
const signingKey = encoder.encode('12345678901234567890123456789012');
const signingToken = `whsec_${base64(signingKey)}`;

describe('createGitLabChannel()', () => {
	it('invokes the webhook handler with a provider-native signed note payload', async () => {
		const webhook = vi.fn();
		const gitlab = createGitLabChannel({ signingToken, webhook });
		const raw = {
			object_kind: 'note',
			event_type: 'note',
			project_id: 5,
			project: { id: 5, path_with_namespace: 'acme/widgets' },
			object_attributes: {
				id: 1241,
				note: '@flue please review this issue',
				noteable_type: 'Issue',
				action: 'create',
			},
			issue: { id: 92, iid: 17, title: 'Investigate edge retries' },
			user: { id: 1, username: 'root' },
		};
		const body = ` {\n  "object_kind": "note",\n  "event_type": "note",\n  "project_id": 5,\n  "project": { "id": 5, "path_with_namespace": "acme/widgets" },\n  "object_attributes": { "id": 1241, "note": "@flue please review this issue", "noteable_type": "Issue", "action": "create" },\n  "issue": { "id": 92, "iid": 17, "title": "Investigate edge retries" },\n  "user": { "id": 1, "username": "root" }\n} `;

		const response = await channelApp(gitlab).request(
			await signedRequest({
				body,
				eventName: 'Note Hook',
				headers: {
					'idempotency-key': 'delivery-1',
					'x-gitlab-event-uuid': 'event-uuid-1',
					'x-gitlab-webhook-uuid': 'webhook-uuid-1',
					'x-gitlab-instance': 'https://gitlab.example.com',
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(webhook).toHaveBeenCalledOnce();
		expect(webhook.mock.calls[0]?.[0]).toMatchObject({
			c: expect.any(Object),
			delivery: {
				eventName: 'Note Hook',
				payload: raw,
				deliveryId: 'message-1',
				idempotencyKey: 'delivery-1',
				eventUuid: 'event-uuid-1',
				webhookUuid: 'webhook-uuid-1',
				instance: 'https://gitlab.example.com',
				signatureTimestamp: expect.any(String),
			},
		});
	});

	it('forwards grouped GitLab event families without filtering', async () => {
		const seen: string[] = [];
		const gitlab = createGitLabChannel({
			signingToken,
			webhook({ delivery }) {
				seen.push(
					`${delivery.eventName}:${delivery.payload.object_kind ?? delivery.payload.event_name}`,
				);
			},
		});
		const app = channelApp(gitlab);

		const mergeRequest = await app.request(
			await signedRequest({
				eventName: 'Merge Request Hook',
				body: JSON.stringify({
					object_kind: 'merge_request',
					object_attributes: { action: 'open', iid: 42 },
					project: { id: 5 },
				}),
			}),
		);
		const push = await app.request(
			await signedRequest({
				eventName: 'Push Hook',
				body: JSON.stringify({ object_kind: 'push', event_name: 'push', commits: [] }),
			}),
		);
		const future = await app.request(
			await signedRequest({
				eventName: 'Future Hook',
				body: JSON.stringify({ object_kind: 'future_event', custom: { nested: true } }),
			}),
		);

		expect(mergeRequest.status).toBe(200);
		expect(push.status).toBe(200);
		expect(future.status).toBe(200);
		expect(seen).toEqual([
			'Merge Request Hook:merge_request',
			'Push Hook:push',
			'Future Hook:future_event',
		]);
	});

	it('rejects tampered signed bytes stale timestamps and missing signed headers', async () => {
		const webhook = vi.fn();
		const app = channelApp(createGitLabChannel({ signingToken, webhook }));
		const body = JSON.stringify({ object_kind: 'note', object_attributes: { note: 'Current' } });
		const signed = await signedRequest({ body, eventName: 'Note Hook' });
		const tampered = new Request(signed.url, {
			method: 'POST',
			headers: signed.headers,
			body: body.replace('Current', 'Changed'),
		});
		const stale = await signedRequest({
			body,
			eventName: 'Note Hook',
			timestamp: Math.floor(Date.now() / 1000) - 301,
		});
		const missingId = await signedRequest({ body, eventName: 'Note Hook' });
		missingId.headers.delete('webhook-id');

		const responses = await Promise.all([
			app.request(tampered),
			app.request(stale),
			app.request(missingId),
		]);

		expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('accepts one valid signature among multiple signed signatures', async () => {
		const webhook = vi.fn();
		const gitlab = createGitLabChannel({ signingToken, webhook });
		const body = JSON.stringify({ object_kind: 'push', commits: [] });
		const timestamp = String(Math.floor(Date.now() / 1000));
		const valid = await signature('message-1', timestamp, body);

		const response = await channelApp(gitlab).request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'webhook-id': 'message-1',
					'webhook-timestamp': timestamp,
					'webhook-signature': `v1,invalid ${valid}`,
					'x-gitlab-event': 'Push Hook',
				},
				body,
			}),
		);

		expect(response.status).toBe(200);
		expect(webhook).toHaveBeenCalledOnce();
	});

	it('accepts legacy token deliveries when configured', async () => {
		const webhook = vi.fn();
		const gitlab = createGitLabChannel({ secretToken: 'legacy-secret', webhook });

		const response = await channelApp(gitlab).request(
			legacyRequest({
				secretToken: 'legacy-secret',
				eventName: 'Issue Hook',
				body: JSON.stringify({ object_kind: 'issue', object_attributes: { action: 'open' } }),
			}),
		);
		const invalid = await channelApp(gitlab).request(
			legacyRequest({
				secretToken: 'wrong',
				eventName: 'Issue Hook',
				body: JSON.stringify({ object_kind: 'issue' }),
			}),
		);

		expect(response.status).toBe(200);
		expect(invalid.status).toBe(401);
		expect(webhook).toHaveBeenCalledOnce();
	});

	it('uses signed verification before legacy fallback when both tokens are configured', async () => {
		const webhook = vi.fn();
		const app = channelApp(
			createGitLabChannel({ signingToken, secretToken: 'legacy-secret', webhook }),
		);
		const unsignedLegacy = legacyRequest({
			secretToken: 'legacy-secret',
			eventName: 'Issue Hook',
			body: JSON.stringify({ object_kind: 'issue' }),
		});
		const signed = await signedRequest({
			eventName: 'Issue Hook',
			body: JSON.stringify({ object_kind: 'issue', object_attributes: { action: 'open' } }),
			headers: { 'x-gitlab-token': 'legacy-secret' },
		});
		const invalidSigned = new Request(signed.url, {
			method: 'POST',
			headers: signed.headers,
			body: JSON.stringify({ object_kind: 'issue', object_attributes: { action: 'close' } }),
		});

		const legacyResponse = await app.request(unsignedLegacy);
		const invalidSignedResponse = await app.request(invalidSigned);

		expect(legacyResponse.status).toBe(200);
		expect(invalidSignedResponse.status).toBe(401);
		expect(webhook).toHaveBeenCalledOnce();
	});

	it('uses empty JSON and Hono responses without a custom response API', async () => {
		const empty = createGitLabChannel({ signingToken, webhook: () => undefined });
		const json = createGitLabChannel({ signingToken, webhook: () => ({ accepted: true }) });
		const hono = createGitLabChannel({
			signingToken,
			webhook: ({ c }) => c.json({ retry: true }, 202),
		});
		const request = () =>
			signedRequest({ eventName: 'Push Hook', body: JSON.stringify({ object_kind: 'push' }) });

		const emptyResponse = await channelApp(empty).request(await request());
		const jsonResponse = await channelApp(json).request(await request());
		const honoResponse = await channelApp(hono).request(await request());

		expect(emptyResponse.status).toBe(200);
		expect(await emptyResponse.text()).toBe('');
		expect(jsonResponse.status).toBe(200);
		expect(await jsonResponse.json()).toEqual({ accepted: true });
		expect(honoResponse.status).toBe(202);
		expect(await honoResponse.json()).toEqual({ retry: true });
	});

	it('lets the Hono error handler handle callback failures and JSON serialization failures', async () => {
		const failure = new Error('dispatch failed');
		const throwing = createGitLabChannel({
			signingToken,
			webhook() {
				throw failure;
			},
		});
		const invalid = createGitLabChannel({ signingToken, webhook: () => 1n as never });
		const request = () =>
			signedRequest({ eventName: 'Push Hook', body: JSON.stringify({ object_kind: 'push' }) });
		const throwingApp = channelApp(throwing);
		let received: unknown;
		throwingApp.onError((error, c) => {
			received = error;
			return c.text('handled', 503);
		});
		const invalidApp = channelApp(invalid);
		invalidApp.onError((_error, c) => c.text('handled', 503));

		const throwingResponse = await throwingApp.request(await request());
		const invalidResponse = await invalidApp.request(await request());

		expect(throwingResponse.status).toBe(503);
		expect(await throwingResponse.text()).toBe('handled');
		expect(received).toBe(failure);
		expect(invalidResponse.status).toBe(503);
	});

	it('rejects unsupported media oversized bodies malformed JSON and missing event names', async () => {
		const webhook = vi.fn();
		const app = channelApp(createGitLabChannel({ signingToken, bodyLimit: 64, webhook }));
		const media = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: '{}',
			}),
		);
		const oversized = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'content-length': '65' },
				body: '{}',
			}),
		);
		const malformed = await app.request(
			await signedRequest({ eventName: 'Push Hook', body: '{not-json}' }),
		);
		const missingEvent = await signedRequest({
			eventName: 'Push Hook',
			body: JSON.stringify({ object_kind: 'push' }),
		});
		missingEvent.headers.delete('x-gitlab-event');

		expect(media.status).toBe(415);
		expect(oversized.status).toBe(413);
		expect(malformed.status).toBe(400);
		expect((await app.request(missingEvent)).status).toBe(400);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('round-trips canonical issue and merge-request keys and rejects foreign keys', () => {
		const gitlab = createGitLabChannel({ signingToken, webhook: () => undefined });
		const issue = {
			type: 'issue' as const,
			instance: 'https://gitlab.example.com/root:group',
			projectId: 12,
			iid: 34,
		};
		const mergeRequest = {
			type: 'merge-request' as const,
			instance: 'https://gitlab.example.com',
			projectId: 12,
			iid: 7,
		};

		const issueKey = gitlab.conversationKey(issue);
		const mergeRequestKey = gitlab.conversationKey(mergeRequest);

		expect(issueKey).toBe(
			'gitlab:v1:instance:https%3A%2F%2Fgitlab.example.com%2Froot%3Agroup:project:12:issue:34',
		);
		expect(mergeRequestKey).toBe(
			'gitlab:v1:instance:https%3A%2F%2Fgitlab.example.com:project:12:merge-request:7',
		);
		expect(gitlab.parseConversationKey(issueKey)).toEqual(issue);
		expect(gitlab.parseConversationKey(mergeRequestKey)).toEqual(mergeRequest);
		expect(() => gitlab.parseConversationKey('github:v1:project:12:issue:34')).toThrow(
			InvalidGitLabConversationKeyError,
		);
	});

	it('validates constructor input and publishes only the provider webhook route', () => {
		expect(() => createGitLabChannel({ webhook: () => undefined })).toThrow(TypeError);
		expect(() =>
			createGitLabChannel({ signingToken: 'not-whsec', webhook: () => undefined }),
		).toThrow(TypeError);
		expect(() =>
			createGitLabChannel({ signingToken, secretToken: '', webhook: () => undefined }),
		).toThrow(TypeError);

		const gitlab = createGitLabChannel({ signingToken, webhook: () => undefined });
		expect(gitlab.routes).toEqual([
			{ method: 'POST', path: '/webhook', handler: expect.any(Function) },
		]);
	});
});

function channelApp(channel: GitLabChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

interface SignedRequestOptions {
	body: string;
	eventName: string;
	timestamp?: number;
	headers?: Record<string, string>;
}

async function signedRequest(options: SignedRequestOptions): Promise<Request> {
	const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
	return new Request('https://example.test/webhook', {
		method: 'POST',
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'webhook-id': 'message-1',
			'webhook-timestamp': timestamp,
			'webhook-signature': await signature('message-1', timestamp, options.body),
			'x-gitlab-event': options.eventName,
			...options.headers,
		},
		body: options.body,
	});
}

function legacyRequest(options: { secretToken: string; eventName: string; body: string }): Request {
	return new Request('https://example.test/webhook', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-gitlab-token': options.secretToken,
			'x-gitlab-event': options.eventName,
		},
		body: options.body,
	});
}

async function signature(messageId: string, timestamp: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		toArrayBuffer(signingKey),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const message = encoder.encode(`${messageId}.${timestamp}.${body}`);
	const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
	return `v1,${base64(bytes)}`;
}

function base64(bytes: Uint8Array): string {
	let text = '';
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}
