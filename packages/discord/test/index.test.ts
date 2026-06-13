import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
	createDiscordChannel,
	type DiscordChannel,
	InvalidDiscordConversationKeyError,
} from '../src/index.ts';

const encoder = new TextEncoder();
const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
	'sign',
	'verify',
])) as CryptoKeyPair;
const publicKey = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)));

describe('createDiscordChannel()', () => {
	it('declares one fixed interactions route without invoking the callback eagerly', () => {
		const interactions = vi.fn(() => ({ type: 4 }));
		const discord = createDiscordChannel({ publicKey, applicationId: 'A1', interactions });

		expect(discord.routes).toEqual([
			{ method: 'POST', path: '/interactions', handler: expect.any(Function) },
		]);
		expect(interactions).not.toHaveBeenCalled();
	});

	it('returns PONG for a signed PING without invoking the callback', async () => {
		const interactions = vi.fn(() => ({ type: 4 }));
		const discord = createDiscordChannel({ publicKey, applicationId: 'A1', interactions });

		const response = await channelApp(discord).request(await signedRequest({ type: 1 }));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 1 });
		expect(interactions).not.toHaveBeenCalled();
	});

	it('invokes one callback with a normalized command interaction', async () => {
		const shared = { content: 'Accepted.' };
		const interactions = vi.fn((_input: unknown) => ({
			type: 4,
			data: { first: shared, second: shared },
		}));
		const discord = createDiscordChannel({ publicKey, applicationId: 'A1', interactions });
		const raw = commandInteraction({
			data: { type: 1, name: 'ask', options: [{ name: 'question', value: 'hello' }] },
		});

		const response = await channelApp(discord).request(await signedRequest(raw));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			type: 4,
			data: {
				first: { content: 'Accepted.' },
				second: { content: 'Accepted.' },
			},
		});
		expect(
			(interactions.mock.calls[0]?.[0] as { interaction: unknown } | undefined)?.interaction,
		).toMatchObject({
			type: 'command',
			id: 'I1',
			applicationId: 'A1',
			token: 'interaction-token',
			destination: {
				type: 'guild',
				guildId: 'G1',
				channelId: 'C1',
				channelKind: 'channel',
			},
			data: {
				name: 'ask',
				options: [{ name: 'question', value: 'hello' }],
			},
			raw,
		});
	});

	it('normalizes component and modal interactions through the same callback', async () => {
		const seen: string[] = [];
		const discord = createDiscordChannel({
			publicKey,
			applicationId: 'A1',
			interactions({ interaction }) {
				seen.push(interaction.type);
				return { type: 4, data: { content: 'ok' } };
			},
		});
		const app = channelApp(discord);

		const component = await app.request(
			await signedRequest(
				commandInteraction({
					type: 3,
					data: { custom_id: 'approve', component_type: 2, values: ['yes'] },
				}),
			),
		);
		const modal = await app.request(
			await signedRequest(
				commandInteraction({
					type: 5,
					data: {
						custom_id: 'approval',
						components: [{ type: 4, custom_id: 'reason', value: 'because' }],
					},
				}),
			),
		);

		expect(component.status).toBe(200);
		expect(modal.status).toBe(200);
		expect(seen).toEqual(['component', 'modal']);
	});

	it('forwards unsupported verified interaction types as unknown', async () => {
		const interactions = vi.fn((_input: unknown) => ({ type: 4 }));
		const discord = createDiscordChannel({ publicKey, applicationId: 'A1', interactions });

		const response = await channelApp(discord).request(
			await signedRequest(commandInteraction({ type: 99, data: undefined })),
		);

		expect(response.status).toBe(200);
		expect(
			(interactions.mock.calls[0]?.[0] as { interaction: unknown } | undefined)?.interaction,
		).toMatchObject({ type: 'unknown', interactionType: 99 });
	});

	it('passes ordinary Hono responses through unchanged', async () => {
		const discord = createDiscordChannel({
			publicKey,
			applicationId: 'A1',
			interactions: ({ c }) => c.json({ accepted: true }, 202),
		});

		const response = await channelApp(discord).request(await signedRequest(commandInteraction()));

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ accepted: true });
	});

	it('returns 500 for thrown handlers invalid JSON and deadline expiry', async () => {
		const throwing = createDiscordChannel({
			publicKey,
			applicationId: 'A1',
			interactions() {
				throw new Error('failed');
			},
		});
		const invalid = createDiscordChannel({
			publicKey,
			applicationId: 'A1',
			interactions: () => ({ type: Number.NaN }),
		});
		const timeout = createDiscordChannel({
			publicKey,
			applicationId: 'A1',
			handlerTimeoutMs: 5,
			interactions: () => new Promise(() => {}),
		});

		expect(
			(await channelApp(throwing).request(await signedRequest(commandInteraction()))).status,
		).toBe(500);
		expect(
			(await channelApp(invalid).request(await signedRequest(commandInteraction()))).status,
		).toBe(500);
		expect(
			(await channelApp(timeout).request(await signedRequest(commandInteraction()))).status,
		).toBe(500);
	});

	it('rejects invalid signatures and signed application mismatches', async () => {
		const interactions = vi.fn((_input: unknown) => ({ type: 4 }));
		const discord = createDiscordChannel({ publicKey, applicationId: 'A1', interactions });
		const signed = await signedRequest(commandInteraction());
		const changed = new Request(signed.url, {
			method: 'POST',
			headers: signed.headers,
			body: JSON.stringify(commandInteraction({ id: 'changed' })),
		});
		const mismatch = await signedRequest(commandInteraction({ application_id: 'A2' }));

		expect((await channelApp(discord).request(changed)).status).toBe(401);
		expect((await channelApp(discord).request(mismatch)).status).toBe(403);
		expect(interactions).not.toHaveBeenCalled();
	});

	it('classifies guild threads and bot DMs while rejecting unsupported destinations', async () => {
		const destinations: unknown[] = [];
		const discord = createDiscordChannel({
			publicKey,
			applicationId: 'A1',
			interactions({ interaction }) {
				destinations.push(interaction.destination);
				return { type: 4 };
			},
		});
		const app = channelApp(discord);

		const thread = await app.request(
			await signedRequest(
				commandInteraction({
					channel_id: 'T1',
					channel: { id: 'T1', type: 11 },
				}),
			),
		);
		const dm = await app.request(
			await signedRequest(
				commandInteraction({
					guild_id: undefined,
					context: 1,
					channel_id: 'D1',
					channel: { id: 'D1', type: 1 },
				}),
			),
		);
		const groupDm = await app.request(
			await signedRequest(
				commandInteraction({
					guild_id: undefined,
					context: 1,
					channel_id: 'D2',
					channel: { id: 'D2', type: 3 },
				}),
			),
		);

		expect(thread.status).toBe(200);
		expect(dm.status).toBe(200);
		expect(groupDm.status).toBe(400);
		expect(destinations).toEqual([
			{ type: 'guild', guildId: 'G1', channelId: 'T1', channelKind: 'thread' },
			{ type: 'dm', channelId: 'D1' },
		]);
	});

	it('round-trips canonical destination references', () => {
		const discord = createDiscordChannel({
			publicKey,
			applicationId: 'A1',
			interactions: () => ({ type: 4 }),
		});
		const ref = {
			type: 'guild' as const,
			guildId: 'G:1',
			channelId: 'C/1?#',
			channelKind: 'thread' as const,
		};
		const key = discord.conversationKey(ref);

		expect(discord.parseConversationKey(key)).toEqual(ref);
		expect(() => discord.parseConversationKey(`slack:${key}`)).toThrow(
			InvalidDiscordConversationKeyError,
		);
	});
});

function channelApp(channel: DiscordChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

function commandInteraction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: 2,
		id: 'I1',
		application_id: 'A1',
		token: 'interaction-token',
		guild_id: 'G1',
		context: 0,
		channel_id: 'C1',
		channel: { id: 'C1', type: 0 },
		data: { type: 1, name: 'ask', options: [] },
		...overrides,
	};
}

async function signedRequest(raw: unknown): Promise<Request> {
	const timestamp = '1717971234';
	const body = JSON.stringify(raw);
	const signature = await sign(keyPair.privateKey, timestamp, body);
	return new Request('https://example.test/interactions', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-signature-ed25519': signature,
			'x-signature-timestamp': timestamp,
		},
		body,
	});
}

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
