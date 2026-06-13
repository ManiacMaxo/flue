import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createDiscordChannel } from '../src/index.ts';

const encoder = new TextEncoder();

describe('@flue/discord workerd ingress', () => {
	it('verifies exact interaction bytes through the discovered route shape', async () => {
		const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
			'sign',
			'verify',
		])) as CryptoKeyPair;
		const publicKey = toHex(
			new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)),
		);
		const interactions = vi.fn((_input: unknown) => ({
			type: 4,
			data: { content: 'Accepted.' },
		}));
		const discord = createDiscordChannel({ publicKey, applicationId: 'A1', interactions });
		const app = new Hono();
		for (const route of discord.routes) app.on(route.method, route.path, route.handler);
		const timestamp = '1717971234';
		const body = ` {\n "type":2,"id":"I1","application_id":"A1","token":"interaction-token",\n "guild_id":"G1","context":0,"channel_id":"C1","channel":{"id":"C1","type":0},\n "member":{"user":{"id":"U1"}},"locale":"en-US","authorizing_integration_owners":{"0":"G1"},\n "data":{"type":1,"name":"ask","options":[{"value":"café"}]}\n} `;
		const signature = await sign(keyPair.privateKey, timestamp, body);
		const headers = {
			'content-type': 'application/json',
			'x-signature-ed25519': signature,
			'x-signature-timestamp': timestamp,
		};

		const response = await app.request(
			new Request('https://example.test/interactions?source=workerd', {
				method: 'POST',
				headers,
				body,
			}),
		);
		const changed = await app.request(
			new Request('https://example.test/interactions', {
				method: 'POST',
				headers,
				body: body.replace('café', 'cafe'),
			}),
		);

		expect(response.status).toBe(200);
		expect(changed.status).toBe(401);
		expect(interactions).toHaveBeenCalledOnce();
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
