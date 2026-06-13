import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createSlackChannel } from '../src/index.ts';

const encoder = new TextEncoder();

describe('@flue/slack workerd ingress', () => {
	it('verifies exact Events API bytes through the discovered route shape', async () => {
		const events = vi.fn();
		const slack = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			events,
		});
		const app = new Hono();
		for (const route of slack.routes) app.on(route.method, route.path, route.handler);
		const body = ` {"type":"event_callback","api_app_id":"A123","team_id":"T123","event_id":"Ev1","event":{"type":"app_mention","channel":"C1","ts":"1.1","text":"café","user":"U1"}} `;
		const timestamp = Math.floor(Date.now() / 1000);
		const signature = await hmac(`v0:${timestamp}:${body}`);
		const headers = {
			'content-type': 'application/json',
			'x-slack-request-timestamp': String(timestamp),
			'x-slack-signature': `v0=${signature}`,
		};

		const response = await app.request(
			new Request('https://example.test/events', { method: 'POST', headers, body }),
		);
		const changed = await app.request(
			new Request('https://example.test/events', {
				method: 'POST',
				headers,
				body: body.replace('café', 'cafe'),
			}),
		);

		expect(response.status).toBe(200);
		expect(changed.status).toBe(401);
		expect(events).toHaveBeenCalledOnce();
	});
});

async function hmac(value: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode('secret'),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
	return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
