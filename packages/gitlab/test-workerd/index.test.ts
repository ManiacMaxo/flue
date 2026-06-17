import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createGitLabChannel } from '../src/index.ts';

const encoder = new TextEncoder();
const signingKey = encoder.encode('12345678901234567890123456789012');
const signingToken = `whsec_${base64(signingKey)}`;

describe('@flue/gitlab workerd ingress', () => {
	it('verifies exact signed webhook bytes through the discovered route handler shape', async () => {
		const webhook = vi.fn();
		const gitlab = createGitLabChannel({ signingToken, webhook });
		const app = new Hono();
		for (const route of gitlab.routes) app.on(route.method, route.path, route.handler);
		const body = ` {\n "object_kind":"note",\n "object_attributes":{"note":"Unicode café","noteable_type":"Issue"},\n "issue":{"iid":42}\n} `;
		const timestamp = String(Math.floor(Date.now() / 1000));
		const headers = {
			'content-type': 'application/json',
			'webhook-id': 'message-1',
			'webhook-timestamp': timestamp,
			'webhook-signature': await signature('message-1', timestamp, body),
			'x-gitlab-event': 'Note Hook',
		};

		const response = await app.request(
			new Request('https://example.test/webhook?source=workerd', {
				method: 'POST',
				headers,
				body,
			}),
		);
		const changed = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers,
				body: body.replace('café', 'cafe'),
			}),
		);

		expect(response.status).toBe(200);
		expect(changed.status).toBe(401);
		expect(webhook).toHaveBeenCalledOnce();
	});

	it('verifies legacy X-Gitlab-Token deliveries in workerd', async () => {
		const webhook = vi.fn();
		const gitlab = createGitLabChannel({ secretToken: 'legacy-secret', webhook });
		const app = new Hono();
		for (const route of gitlab.routes) app.on(route.method, route.path, route.handler);

		const response = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-gitlab-token': 'legacy-secret',
					'x-gitlab-event': 'Push Hook',
				},
				body: JSON.stringify({ object_kind: 'push', commits: [] }),
			}),
		);

		expect(response.status).toBe(200);
		expect(webhook).toHaveBeenCalledOnce();
	});
});

async function signature(messageId: string, timestamp: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		signingKey.slice().buffer,
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
