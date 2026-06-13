import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
	createSlackChannel,
	InvalidSlackConversationKeyError,
	type SlackChannel,
} from '../src/index.ts';

const encoder = new TextEncoder();

describe('createSlackChannel()', () => {
	it('publishes only configured provider surfaces', () => {
		const events = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			events() {},
		});
		const interactions = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			interactions() {},
		});

		expect(events.routes.map(({ method, path }) => ({ method, path }))).toEqual([
			{ method: 'POST', path: '/events' },
		]);
		expect(interactions.routes.map(({ method, path }) => ({ method, path }))).toEqual([
			{ method: 'POST', path: '/interactions' },
		]);
	});

	it('rejects configuration without an events or interactions handler', () => {
		expect(() =>
			createSlackChannel({
				signingSecret: 'secret',
				appId: 'A123',
				teamId: 'T123',
			}),
		).toThrow('requires an events or interactions handler');
	});

	it('invokes one events callback with normalized retry metadata', async () => {
		const events = vi.fn();
		const slack = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			events,
		});
		const raw = {
			type: 'event_callback',
			api_app_id: 'A123',
			team_id: 'T123',
			event_id: 'Ev123',
			event: {
				type: 'app_mention',
				channel: 'C123',
				ts: '1717971234.0012',
				text: '<@U1> hello',
				user: 'U2',
			},
		};

		const response = await channelApp(slack).request(
			await signedJsonRequest('/events', raw, {
				'x-slack-retry-num': '1',
				'x-slack-retry-reason': 'http_timeout',
			}),
		);

		expect(response.status).toBe(200);
		expect(events.mock.calls[0]?.[0]).toMatchObject({
			c: expect.any(Object),
			event: {
				type: 'app_mention',
				eventId: 'Ev123',
				appId: 'A123',
				teamId: 'T123',
				retry: { number: 1, reason: 'http_timeout' },
				payload: {
					channelId: 'C123',
					messageTs: '1717971234.0012',
					text: '<@U1> hello',
					userId: 'U2',
				},
			},
		});
	});

	it('forwards unsupported Events API events through the unknown variant', async () => {
		const events = vi.fn();
		const slack = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			events,
		});

		const response = await channelApp(slack).request(
			await signedJsonRequest('/events', {
				type: 'event_callback',
				api_app_id: 'A123',
				team_id: 'T123',
				event_id: 'Ev999',
				event: { type: 'reaction_added' },
			}),
		);

		expect(response.status).toBe(200);
		expect(events.mock.calls[0]?.[0].event).toMatchObject({
			type: 'unknown',
			eventType: 'reaction_added',
			eventId: 'Ev999',
		});
	});

	it('handles URL verification internally', async () => {
		const events = vi.fn();
		const slack = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			events,
		});

		const response = await channelApp(slack).request(
			await signedJsonRequest('/events', {
				type: 'url_verification',
				api_app_id: 'A123',
				team_id: 'T123',
				challenge: 'challenge-value',
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ challenge: 'challenge-value' });
		expect(events).not.toHaveBeenCalled();
	});

	it('requires trusted identity on URL verification and unsupported envelopes', async () => {
		const events = vi.fn();
		const slack = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			events,
		});
		const app = channelApp(slack);

		const challengeMismatch = await app.request(
			await signedJsonRequest('/events', {
				type: 'url_verification',
				api_app_id: 'A123',
				team_id: 'WRONG',
				challenge: 'challenge-value',
			}),
		);
		const missingIdentity = await app.request(
			await signedJsonRequest('/events', { type: 'app_rate_limited' }),
		);
		const unsupported = await app.request(
			await signedJsonRequest('/events', {
				type: 'app_rate_limited',
				api_app_id: 'A123',
				team_id: 'T123',
			}),
		);

		expect(challengeMismatch.status).toBe(403);
		expect(missingIdentity.status).toBe(400);
		expect(unsupported.status).toBe(200);
		expect(events).toHaveBeenCalledOnce();
		expect(events.mock.calls[0]?.[0].event).toEqual({
			type: 'unknown',
			eventType: 'app_rate_limited',
			appId: 'A123',
			teamId: 'T123',
			retry: undefined,
			raw: {
				type: 'app_rate_limited',
				api_app_id: 'A123',
				team_id: 'T123',
			},
		});
	});

	it('invokes one interactions callback for actions and returns JSON directly', async () => {
		const shared = { accepted: true };
		const interactions = vi.fn((_input: unknown) => ({ first: shared, second: shared }));
		const slack = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			interactions,
		});
		const payload = {
			type: 'block_actions',
			api_app_id: 'A123',
			team: { id: 'T123' },
			user: { id: 'U123' },
			channel: { id: 'C123' },
			message: { ts: '1717971234.0012' },
			container: { type: 'message', channel_id: 'C123', message_ts: '1717971234.0012' },
			actions: [{ action_id: 'approve', value: 'yes' }],
		};

		const response = await channelApp(slack).request(
			await signedFormRequest('/interactions', payload),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			first: { accepted: true },
			second: { accepted: true },
		});
		expect(
			(interactions.mock.calls[0]?.[0] as { interaction: unknown } | undefined)?.interaction,
		).toMatchObject({
			type: 'action',
			actionId: 'approve',
			value: 'yes',
			channelId: 'C123',
			messageTs: '1717971234.0012',
			threadTs: '1717971234.0012',
		});
	});

	it('returns provider-native view validation JSON without translation', async () => {
		const slack = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			interactions: ({ interaction }) => {
				if (interaction.type !== 'view_submission') return;
				return {
					response_action: 'errors',
					errors: { email: 'Enter a valid email address.' },
				};
			},
		});

		const response = await channelApp(slack).request(
			await signedFormRequest('/interactions', {
				type: 'view_submission',
				api_app_id: 'A123',
				team: { id: 'T123' },
				user: { id: 'U123' },
				view: {
					id: 'V123',
					callback_id: 'settings',
					state: { values: {} },
				},
			}),
		);

		expect(await response.json()).toEqual({
			response_action: 'errors',
			errors: { email: 'Enter a valid email address.' },
		});
	});

	it('uses empty 200 defaults and passes Hono responses through', async () => {
		const defaultChannel = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			events() {},
		});
		const responseChannel = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			events: ({ c }) => c.text('accepted', 202),
		});
		const payload = {
			type: 'event_callback',
			api_app_id: 'A123',
			team_id: 'T123',
			event_id: 'Ev123',
			event: {
				type: 'message',
				channel: 'C123',
				ts: '1717971234.0012',
				text: 'hello',
				user: 'U2',
			},
		};

		const defaultResponse = await channelApp(defaultChannel).request(
			await signedJsonRequest('/events', payload),
		);
		const response = await channelApp(responseChannel).request(
			await signedJsonRequest('/events', payload),
		);

		expect(defaultResponse.status).toBe(200);
		expect(await defaultResponse.text()).toBe('');
		expect(response.status).toBe(202);
		expect(await response.text()).toBe('accepted');
	});

	it('rejects stale signatures and signed identity mismatches', async () => {
		const events = vi.fn();
		const slack = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			events,
		});
		const payload = {
			type: 'event_callback',
			api_app_id: 'WRONG',
			team_id: 'T123',
			event_id: 'Ev123',
			event: { type: 'reaction_added' },
		};

		const stale = await channelApp(slack).request(
			await signedJsonRequest('/events', payload, {}, Math.floor(Date.now() / 1000) - 301),
		);
		const mismatch = await channelApp(slack).request(await signedJsonRequest('/events', payload));

		expect(stale.status).toBe(401);
		expect(mismatch.status).toBe(403);
		expect(events).not.toHaveBeenCalled();
	});

	it('returns 500 when a callback throws or exceeds its deadline', async () => {
		const throwing = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			events() {
				throw new Error('failed');
			},
		});
		const timeout = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			handlerTimeoutMs: 5,
			events: () => new Promise(() => {}),
		});
		const payload = {
			type: 'event_callback',
			api_app_id: 'A123',
			team_id: 'T123',
			event_id: 'Ev123',
			event: { type: 'reaction_added' },
		};

		expect(
			(await channelApp(throwing).request(await signedJsonRequest('/events', payload))).status,
		).toBe(500);
		expect(
			(await channelApp(timeout).request(await signedJsonRequest('/events', payload))).status,
		).toBe(500);
		expect(
			(
				await channelApp(timeout).request(
					await signedJsonRequest('/events', {
						type: 'app_rate_limited',
						api_app_id: 'A123',
						team_id: 'T123',
					}),
				)
			).status,
		).toBe(500);
	});

	it('round-trips canonical thread references', () => {
		const slack = createSlackChannel({
			signingSecret: 'secret',
			appId: 'A123',
			teamId: 'T123',
			events() {},
		});
		const ref = { teamId: 'T:123', channelId: 'C/123', threadTs: '1717.00?#' };
		const key = slack.conversationKey(ref);

		expect(slack.parseConversationKey(key)).toEqual(ref);
		expect(() => slack.parseConversationKey(`github:v1:${key}`)).toThrow(
			InvalidSlackConversationKeyError,
		);
	});
});

function channelApp(channel: SlackChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

async function signedJsonRequest(
	path: string,
	payload: unknown,
	headers: Record<string, string> = {},
	timestamp = Math.floor(Date.now() / 1000),
): Promise<Request> {
	return signedRequest(path, JSON.stringify(payload), 'application/json', headers, timestamp);
}

async function signedFormRequest(path: string, payload: unknown): Promise<Request> {
	return signedRequest(
		path,
		new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
		'application/x-www-form-urlencoded',
	);
}

async function signedRequest(
	path: string,
	body: string,
	contentType: string,
	headers: Record<string, string> = {},
	timestamp = Math.floor(Date.now() / 1000),
): Promise<Request> {
	const signed = `v0:${timestamp}:${body}`;
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode('secret'),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(signed)));
	const hex = Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return new Request(`https://example.test${path}`, {
		method: 'POST',
		headers: {
			'content-type': contentType,
			'x-slack-request-timestamp': String(timestamp),
			'x-slack-signature': `v0=${hex}`,
			...headers,
		},
		body,
	});
}
