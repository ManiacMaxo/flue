import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createSlackChannel } from '../src/index.ts';

const encoder = new TextEncoder();

describe('@flue/slack workerd ingress', () => {
	it('verifies exact mounted event bytes when a signed mention is received', async () => {
		const slack = createSlackChannel({
			signingSecret: 'secret',
			botToken: 'token',
			appId: 'A1',
			teamId: 'T1',
		});
		const handler = vi.fn();
		slack.on('app_mention', handler);
		const app = new Hono();
		app.mount('/webhooks/slack/events', slack.routes.events());
		const timestamp = String(Math.floor(Date.now() / 1_000));
		const body = ` {\n "type":"event_callback","api_app_id":"A1","team_id":"T1","event_id":"Ev1",\n "event":{"type":"app_mention","channel":"C1","ts":"1","text":"Unicode café","user":"U1"}\n} `;
		const signature = await hmac('secret', `v0:${timestamp}:${body}`);

		const response = await app.request(
			new Request('https://example.test/webhooks/slack/events?source=workerd', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-slack-request-timestamp': timestamp,
					'x-slack-signature': `v0=${signature}`,
				},
				body,
			}),
		);
		const changed = await app.request(
			new Request('https://example.test/webhooks/slack/events', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-slack-request-timestamp': timestamp,
					'x-slack-signature': `v0=${signature}`,
				},
				body: body.replace('café', 'cafe'),
			}),
		);

		expect(response.status).toBe(200);
		expect(changed.status).toBe(401);
		expect(handler).toHaveBeenCalledOnce();
	});
});

async function hmac(secret: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
	return toHex(signature);
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
