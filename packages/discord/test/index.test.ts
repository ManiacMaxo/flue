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
			user: { id: 'U1' },
			context: 0,
			locale: 'en-US',
			guildLocale: 'en-GB',
			authorizingIntegrationOwners: { guildId: 'G1' },
			capabilities: { token: 'interaction-token' },
			destination: {
				type: 'guild',
				guildId: 'G1',
				channelId: 'C1',
				channelKind: 'channel',
			},
			data: {
				commandType: 1,
				name: 'ask',
				options: [{ name: 'question', value: 'hello' }],
			},
			raw,
		});
	});

	it('normalizes every application command type and autocomplete', async () => {
		const seen: unknown[] = [];
		const discord = createDiscordChannel({
			publicKey,
			applicationId: 'A1',
			interactions({ interaction }) {
				seen.push(interaction);
				return interaction.type === 'autocomplete'
					? { type: 8, data: { choices: [] } }
					: { type: 4 };
			},
		});
		const app = channelApp(discord);

		const userCommand = await app.request(
			await signedRequest(
				commandInteraction({
					data: {
						type: 2,
						name: 'inspect-user',
						target_id: 'U2',
						resolved: { users: { U2: { id: 'U2' } } },
					},
				}),
			),
		);
		const messageCommand = await app.request(
			await signedRequest(
				commandInteraction({
					data: {
						type: 3,
						name: 'inspect-message',
						target_id: 'M1',
						resolved: { messages: { M1: { id: 'M1' } } },
					},
				}),
			),
		);
		const entryPoint = await app.request(
			await signedRequest(
				commandInteraction({
					data: { type: 4, name: 'launch' },
				}),
			),
		);
		const autocomplete = await app.request(
			await signedRequest(
				commandInteraction({
					type: 4,
					data: {
						type: 1,
						name: 'ask',
						options: [{ type: 3, name: 'topic', value: 'flu', focused: true }],
					},
				}),
			),
		);

		expect([
			userCommand.status,
			messageCommand.status,
			entryPoint.status,
			autocomplete.status,
		]).toEqual([200, 200, 200, 200]);
		expect(seen).toEqual([
			expect.objectContaining({
				type: 'command',
				data: expect.objectContaining({
					commandType: 2,
					targetId: 'U2',
					resolved: { users: { U2: { id: 'U2' } } },
				}),
			}),
			expect.objectContaining({
				type: 'command',
				data: expect.objectContaining({ commandType: 3, targetId: 'M1' }),
			}),
			expect.objectContaining({
				type: 'command',
				data: { commandType: 4, name: 'launch', options: [] },
			}),
			expect.objectContaining({
				type: 'autocomplete',
				data: {
					name: 'ask',
					options: [{ type: 3, name: 'topic', value: 'flu', focused: true }],
				},
			}),
		]);
	});

	it('normalizes component and destination-free modal interactions through the same callback', async () => {
		const seen: string[] = [];
		const modals: unknown[] = [];
		const discord = createDiscordChannel({
			publicKey,
			applicationId: 'A1',
			interactions({ interaction }) {
				seen.push(interaction.type);
				if (interaction.type === 'modal') modals.push(interaction);
				return { type: 4, data: { content: 'ok' } };
			},
		});
		const app = channelApp(discord);

		const component = await app.request(
			await signedRequest(
				commandInteraction({
					type: 3,
					data: { custom_id: 'approve', component_type: 3, values: ['yes'] },
					message: { id: 'M1', content: 'Approve?' },
				}),
			),
		);
		const modal = await app.request(
			await signedRequest(
				commandInteraction({
					type: 5,
					guild_id: undefined,
					context: undefined,
					channel_id: undefined,
					channel: undefined,
					data: {
						custom_id: 'approval',
						components: [
							{
								type: 1,
								components: [{ type: 4, custom_id: 'reason', value: 'because' }],
							},
							{
								type: 18,
								component: {
									type: 6,
									custom_id: 'reviewers',
									values: ['U2', 'U3'],
								},
							},
							{
								type: 18,
								component: { type: 23, custom_id: 'notify', value: true },
							},
						],
					},
				}),
			),
		);

		expect(component.status).toBe(200);
		expect(modal.status).toBe(200);
		expect(seen).toEqual(['component', 'modal']);
		expect((modals[0] as { destination?: unknown }).destination).toBeUndefined();
		expect(modals[0]).toMatchObject({
			type: 'modal',
			data: {
				fields: [
					{ type: 4, customId: 'reason', value: 'because' },
					{ type: 6, customId: 'reviewers', values: ['U2', 'U3'] },
					{ type: 23, customId: 'notify', value: true },
				],
			},
		});
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

	it('classifies guild, bot-DM, and private-channel destinations', async () => {
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
					context: 2,
					channel_id: 'D2',
					channel: { id: 'D2', type: 3 },
				}),
			),
		);

		expect(thread.status).toBe(200);
		expect(dm.status).toBe(200);
		expect(groupDm.status).toBe(200);
		expect(destinations).toEqual([
			{ type: 'guild', guildId: 'G1', channelId: 'T1', channelKind: 'thread' },
			{ type: 'dm', channelId: 'D1' },
			{ type: 'private', channelId: 'D2' },
		]);
	});

	it('rejects contradictory invocation identity before calling the handler', async () => {
		const interactions = vi.fn((_input: unknown) => ({ type: 4 }));
		const discord = createDiscordChannel({ publicKey, applicationId: 'A1', interactions });
		const app = channelApp(discord);

		const mismatchedChannel = await app.request(
			await signedRequest(
				commandInteraction({
					channel_id: 'C1',
					channel: { id: 'C2', type: 0 },
				}),
			),
		);
		const mismatchedContext = await app.request(
			await signedRequest(commandInteraction({ context: 2 })),
		);
		const mismatchedUser = await app.request(
			await signedRequest(
				commandInteraction({
					user: { id: 'U2' },
				}),
			),
		);

		expect([mismatchedChannel.status, mismatchedContext.status, mismatchedUser.status]).toEqual([
			400, 400, 400,
		]);
		expect(interactions).not.toHaveBeenCalled();
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
		expect(
			discord.parseConversationKey(discord.conversationKey({ type: 'private', channelId: 'P:1' })),
		).toEqual({ type: 'private', channelId: 'P:1' });
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
		member: { user: { id: 'U1' } },
		locale: 'en-US',
		guild_locale: 'en-GB',
		authorizing_integration_owners: { 0: 'G1' },
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
