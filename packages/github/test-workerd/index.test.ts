import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createGitHubChannel } from '../src/index.ts';

const encoder = new TextEncoder();

describe('@flue/github workerd ingress', () => {
	it('verifies exact mounted webhook bytes when a signed issue is received', async () => {
		const github = createGitHubChannel({ webhookSecret: 'secret', token: 'token' });
		const handler = vi.fn();
		github.on('issues.opened', handler);
		const app = new Hono();
		app.mount('/webhooks/github', github.routes.webhook());
		const body = ` {\n "action":"opened",\n "repository":{"id":12,"name":"widgets","owner":{"login":"acme"}},\n "issue":{"number":42,"title":"Unicode café","body":null}\n} `;
		const signature = await hmac('secret', body);

		const response = await app.request(
			new Request('https://example.test/webhooks/github?source=workerd', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-github-delivery': 'delivery-1',
					'x-github-event': 'issues',
					'x-hub-signature-256': `sha256=${signature}`,
				},
				body,
			}),
		);
		const changed = await app.request(
			new Request('https://example.test/webhooks/github', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-github-delivery': 'delivery-1',
					'x-github-event': 'issues',
					'x-hub-signature-256': `sha256=${signature}`,
				},
				body: body.replace('café', 'cafe'),
			}),
		);

		expect(response.status).toBe(204);
		expect(changed.status).toBe(401);
		expect(handler).toHaveBeenCalledOnce();
	});
});

async function hmac(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
	return toHex(signature);
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
