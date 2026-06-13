import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createDiscordChannel } from '../src/index.ts';

const encoder = new TextEncoder();

describe('@flue/discord workerd ingress', () => {
	it('verifies exact mounted interaction bytes with a raw Ed25519 key', async () => {
		const keyPair = (await crypto.subtle.generateKey(
			{ name: 'Ed25519' },
			true,
			['sign', 'verify'],
		)) as CryptoKeyPair;
		const publicKey = toHex(
			new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)),
		);
		const discord = createDiscordChannel({
			publicKey,
			applicationId: 'A1',
			botToken: 'token',
		});
		const handler = vi.fn(() => ({
			type: 'message' as const,
			message: { content: 'Accepted.' },
			ephemeral: true,
		}));
		discord.onCommand('ask', handler);
		const app = new Hono();
		app.mount('/webhooks/discord', discord.routes.interactions());
		const timestamp = '1717971234';
		const body = ` {\n "type":2,"id":"I1","application_id":"A1","token":"interaction-token",\n "guild_id":"G1","context":0,"channel_id":"C1","channel":{"id":"C1","type":0},\n "data":{"type":1,"name":"ask","options":[{"value":"café"}]}\n} `;
		const signature = await sign(keyPair.privateKey, timestamp, body);

		const response = await app.request(
			new Request('https://example.test/webhooks/discord?source=workerd', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-signature-ed25519': signature,
					'x-signature-timestamp': timestamp,
				},
				body,
			}),
		);
		const changed = await app.request(
			new Request('https://example.test/webhooks/discord', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-signature-ed25519': signature,
					'x-signature-timestamp': timestamp,
				},
				body: body.replace('café', 'cafe'),
			}),
		);

		expect(response.status).toBe(200);
		expect(changed.status).toBe(401);
		expect(handler).toHaveBeenCalledOnce();
	});
});

async function sign(privateKey: CryptoKey, timestamp: string, body: string): Promise<string> {
	const prefix = encoder.encode(timestamp);
	const bytes = encoder.encode(body);
	const signed = new Uint8Array(prefix.byteLength + bytes.byteLength);
	signed.set(prefix);
	signed.set(bytes, prefix.byteLength);
	return toHex(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, signed)));
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
