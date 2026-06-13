import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
	createSlackChannel,
	DuplicateSlackHandlerError,
	InvalidSlackConversationKeyError,
	InvalidSlackInputError,
	SlackApiError,
	SlackRateLimitError,
	SlackTimeoutError,
} from '../src/index.ts';

const encoder = new TextEncoder();

describe('createSlackChannel()', () => {
	it('returns the challenge when a signed URL verification request is valid', async () => {
		const slack = createChannel();
		const body = JSON.stringify({
			type: 'url_verification',
			token: 'legacy-token',
			challenge: 'challenge-value',
		});

		const response = await slack.routes.events()(
			await signedRequest({ body, contentType: 'application/json' }),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ challenge: 'challenge-value' });
	});

	it('invokes the app_mention handler when a signed event callback matches identity', async () => {
		const slack = createChannel();
		const handler = vi.fn();
		slack.on('app_mention', handler);
		const raw = eventCallback({
			type: 'app_mention',
			channel: 'C1',
			ts: '1717971234.0012',
			thread_ts: '1717971200.0001',
			text: '<@UAPP> help',
			user: 'U1',
		});

		const response = await slack.routes.events()(
			await signedRequest({
				body: JSON.stringify(raw),
				contentType: 'application/json',
				headers: {
					'x-slack-retry-num': '2',
					'x-slack-retry-reason': 'http_timeout',
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(handler).toHaveBeenCalledWith({
			type: 'app_mention',
			eventId: 'Ev1',
			appId: 'A1',
			teamId: 'T1',
			retry: { number: 2, reason: 'http_timeout' },
			payload: {
				channelId: 'C1',
				messageTs: '1717971234.0012',
				threadTs: '1717971200.0001',
				text: '<@UAPP> help',
				userId: 'U1',
			},
			raw,
		});
	});

	it('invokes the message handler when a plain user message is received', async () => {
		const slack = createChannel();
		const handler = vi.fn();
		slack.on('message', handler);
		const raw = eventCallback({
			type: 'message',
			channel: 'C1',
			ts: '1717971234.0012',
			text: 'hello',
			user: 'U1',
		});

		const response = await slack.routes.events()(
			await signedRequest({ body: JSON.stringify(raw), contentType: 'application/json' }),
		);

		expect(response.status).toBe(200);
		expect(handler).toHaveBeenCalledWith({
			type: 'message',
			eventId: 'Ev1',
			appId: 'A1',
			teamId: 'T1',
			payload: {
				channelId: 'C1',
				messageTs: '1717971234.0012',
				text: 'hello',
				userId: 'U1',
			},
			raw,
		});
	});

	it('acknowledges without invoking handlers when a message subtype or bot event is received', async () => {
		const slack = createChannel();
		const handler = vi.fn();
		slack.on('message', handler);

		const subtypeResponse = await slack.routes.events()(
			await signedRequest({
				body: JSON.stringify(
					eventCallback({
						type: 'message',
						subtype: 'message_changed',
						channel: 'C1',
						ts: '1717971234.0012',
					}),
				),
				contentType: 'application/json',
			}),
		);
		const botResponse = await slack.routes.events()(
			await signedRequest({
				body: JSON.stringify(
					eventCallback({
						type: 'message',
						bot_id: 'B1',
						channel: 'C1',
						ts: '1717971234.0013',
					}),
				),
				contentType: 'application/json',
			}),
		);

		expect(subtypeResponse.status).toBe(200);
		expect(botResponse.status).toBe(200);
		expect(handler).not.toHaveBeenCalled();
	});

	it('invokes the handler again when an identical valid delivery is replayed', async () => {
		const slack = createChannel();
		const handler = vi.fn();
		slack.on('app_mention', handler);
		const body = JSON.stringify(
			eventCallback({
				type: 'app_mention',
				channel: 'C1',
				ts: '1',
				text: 'x',
				user: 'U1',
			}),
		);

		const first = await slack.routes.events()(
			await signedRequest({ body, contentType: 'application/json' }),
		);
		const second = await slack.routes.events()(
			await signedRequest({ body, contentType: 'application/json' }),
		);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(handler).toHaveBeenCalledTimes(2);
	});

	it('rejects before invoking handlers when the signed app or workspace identity mismatches', async () => {
		const slack = createChannel();
		const handler = vi.fn();
		slack.on('app_mention', handler);

		const wrongApp = await slack.routes.events()(
			await signedRequest({
				body: JSON.stringify(
					eventCallback(
						{ type: 'app_mention', channel: 'C1', ts: '1', text: 'x', user: 'U1' },
						{ appId: 'A2' },
					),
				),
				contentType: 'application/json',
			}),
		);
		const wrongTeam = await slack.routes.events()(
			await signedRequest({
				body: JSON.stringify(
					eventCallback(
						{ type: 'app_mention', channel: 'C1', ts: '1', text: 'x', user: 'U1' },
						{ teamId: 'T2' },
					),
				),
				contentType: 'application/json',
			}),
		);

		expect(wrongApp.status).toBe(403);
		expect(wrongTeam.status).toBe(403);
		expect(handler).not.toHaveBeenCalled();
	});

	it('returns failure when an event handler throws or exceeds its deadline', async () => {
		const throwing = createChannel();
		throwing.on('app_mention', () => {
			throw new Error('dispatch failed');
		});
		const slow = createChannel();
		slow.on('app_mention', async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
		});
		const body = JSON.stringify(
			eventCallback({
				type: 'app_mention',
				channel: 'C1',
				ts: '1',
				text: 'x',
				user: 'U1',
			}),
		);

		const thrownResponse = await throwing.routes.events()(
			await signedRequest({ body, contentType: 'application/json' }),
		);
		const timeoutResponse = await slow.routes.events({ handlerTimeoutMs: 5 })(
			await signedRequest({ body, contentType: 'application/json' }),
		);

		expect(thrownResponse.status).toBe(500);
		expect(timeoutResponse.status).toBe(500);
	});

	it('acknowledges a block action when its one response owner returns ack', async () => {
		const slack = createChannel();
		const handler = vi.fn(() => ({ type: 'ack' as const }));
		slack.onAction('approve', handler);
		const raw = blockAction();

		const response = await slack.routes.interactions()(
			await signedFormPayload(raw),
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('');
		expect(handler).toHaveBeenCalledWith({
			type: 'action',
			appId: 'A1',
			teamId: 'T1',
			userId: 'U1',
			actionId: 'approve',
			channelId: 'C1',
			messageTs: '1717971234.0012',
			threadTs: '1717971200.0001',
			payload: raw.actions[0],
			raw,
		});
	});

	it('rejects an action when it is not backed by a message destination', async () => {
		const slack = createChannel();
		const handler = vi.fn(() => ({ type: 'ack' as const }));
		slack.onAction('approve', handler);
		const raw = blockAction();
		delete raw.channel;
		delete raw.message;
		raw.container = { type: 'view' };

		const response = await slack.routes.interactions()(await signedFormPayload(raw));

		expect(response.status).toBe(400);
		expect(handler).not.toHaveBeenCalled();
	});

	it('serializes view validation errors when a view handler rejects fields', async () => {
		const slack = createChannel();
		const handler = vi.fn(() => ({
			type: 'validation_errors' as const,
			errors: { email: 'Enter a valid email.' },
		}));
		slack.onView('feedback', handler);
		const raw = viewSubmission();

		const response = await slack.routes.interactions()(await signedFormPayload(raw));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			response_action: 'errors',
			errors: { email: 'Enter a valid email.' },
		});
		expect(handler).toHaveBeenCalledWith({
			type: 'view_submission',
			appId: 'A1',
			teamId: 'T1',
			userId: 'U1',
			viewId: 'V1',
			callbackId: 'feedback',
			privateMetadata: 'case-42',
			values: { email: { input: { type: 'plain_text_input', value: 'bad' } } },
			raw,
		});
	});

	it('returns failure when an interaction handler is missing or returns an invalid response', async () => {
		const missing = createChannel();
		const invalid = createChannel();
		invalid.onAction('approve', () => ({ type: 'message' }) as never);

		const missingResponse = await missing.routes.interactions()(
			await signedFormPayload(blockAction()),
		);
		const invalidResponse = await invalid.routes.interactions()(
			await signedFormPayload(blockAction()),
		);

		expect(missingResponse.status).toBe(404);
		expect(invalidResponse.status).toBe(500);
	});

	it('returns failure when an interaction handler exceeds its deadline', async () => {
		const slack = createChannel();
		slack.onAction('approve', async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return { type: 'ack' };
		});

		const response = await slack.routes.interactions({ handlerTimeoutMs: 5 })(
			await signedFormPayload(blockAction()),
		);

		expect(response.status).toBe(500);
	});

	it('rejects route setup when a handler deadline exceeds the Slack response budget', () => {
		const slack = createChannel();

		expect(() => slack.routes.events({ handlerTimeoutMs: 2_501 })).toThrow(
			'handlerTimeoutMs must not exceed 2500ms',
		);
		expect(() => slack.routes.interactions({ handlerTimeoutMs: 3_000 })).toThrow(
			'handlerTimeoutMs must not exceed 2500ms',
		);
	});

	it('rejects an interaction when app, workspace, or org-install identity is unsupported', async () => {
		const slack = createChannel();
		const handler = vi.fn(() => ({ type: 'ack' as const }));
		slack.onAction('approve', handler);
		const wrongApp = blockAction();
		wrongApp.api_app_id = 'A2';
		const wrongTeam = blockAction();
		wrongTeam.team = { id: 'T2' };
		const orgInstall = blockAction();
		orgInstall.team = null;

		const responses = await Promise.all([
			slack.routes.interactions()(await signedFormPayload(wrongApp)),
			slack.routes.interactions()(await signedFormPayload(wrongTeam)),
			slack.routes.interactions()(await signedFormPayload(orgInstall)),
		]);

		expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
		expect(handler).not.toHaveBeenCalled();
	});

	it('rejects a block action when its message destination fields conflict', async () => {
		const slack = createChannel();
		const handler = vi.fn(() => ({ type: 'ack' as const }));
		slack.onAction('approve', handler);
		const raw = blockAction();
		raw.container.channel_id = 'C2';

		const response = await slack.routes.interactions()(await signedFormPayload(raw));

		expect(response.status).toBe(400);
		expect(handler).not.toHaveBeenCalled();
	});

	it('rejects duplicate owners when an event action or view key is already registered', () => {
		const slack = createChannel();
		const unsubscribeEvent = slack.on('app_mention', () => {});
		const unsubscribeAction = slack.onAction('approve', () => ({ type: 'ack' }));
		const unsubscribeView = slack.onView('feedback', () => ({ type: 'ack' }));

		expect(() => slack.on('app_mention', () => {})).toThrow(DuplicateSlackHandlerError);
		expect(() => slack.onAction('approve', () => ({ type: 'ack' }))).toThrow(
			DuplicateSlackHandlerError,
		);
		expect(() => slack.onView('feedback', () => ({ type: 'ack' }))).toThrow(
			DuplicateSlackHandlerError,
		);

		unsubscribeEvent();
		unsubscribeEvent();
		unsubscribeAction();
		unsubscribeAction();
		unsubscribeView();
		unsubscribeView();
		expect(() => slack.on('app_mention', () => {})).not.toThrow();
		expect(() => slack.onAction('approve', () => ({ type: 'ack' }))).not.toThrow();
		expect(() => slack.onView('feedback', () => ({ type: 'ack' }))).not.toThrow();
	});

	it('rejects a request when its signature or timestamp freshness is invalid', async () => {
		const slack = createChannel();
		const body = JSON.stringify({ type: 'url_verification', challenge: 'value' });
		const missing = await slack.routes.events()(
			new Request('https://example.test/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			}),
		);
		const invalid = await slack.routes.events()(
			await signedRequest({
				body,
				contentType: 'application/json',
				signature: `v0=${'0'.repeat(64)}`,
			}),
		);
		const stale = await slack.routes.events()(
			await signedRequest({
				body,
				contentType: 'application/json',
				timestamp: Math.floor(Date.now() / 1000) - 301,
			}),
		);

		expect(missing.status).toBe(401);
		expect(invalid.status).toBe(401);
		expect(stale.status).toBe(401);
	});

	it('verifies the exact timestamp header text when its numeric freshness is valid', async () => {
		const slack = createChannel();
		const body = JSON.stringify({ type: 'url_verification', challenge: 'value' });
		const timestamp = `0${Math.floor(Date.now() / 1000)}`;

		const response = await slack.routes.events()(
			await signedRequest({ body, contentType: 'application/json', timestamp }),
		);

		expect(response.status).toBe(200);
	});

	it('returns protocol errors when route method path content type or body is unsupported', async () => {
		const slack = createChannel();
		const events = slack.routes.events({ bodyLimit: 4 });

		const method = await events(new Request('https://example.test/', { method: 'GET' }));
		const path = await events(new Request('https://example.test/nested', { method: 'POST' }));
		const contentType = await events(
			new Request('https://example.test/', {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: '{}',
			}),
		);
		const oversized = await events(
			new Request('https://example.test/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '12345',
			}),
		);

		expect(method.status).toBe(405);
		expect(method.headers.get('allow')).toBe('POST');
		expect(path.status).toBe(404);
		expect(contentType.status).toBe(415);
		expect(oversized.status).toBe(413);
	});

	it('returns 400 when body-parsing middleware already consumed the request', async () => {
		const slack = createChannel();
		const request = await signedRequest({
			body: JSON.stringify({ type: 'url_verification', challenge: 'value' }),
			contentType: 'application/json',
		});
		await request.text();

		const response = await slack.routes.events()(request);

		expect(response.status).toBe(400);
	});

	it('rejects before invoking handlers when a signed payload is malformed', async () => {
		const slack = createChannel();
		const handler = vi.fn();
		slack.on('app_mention', handler);

		const malformedJson = await slack.routes.events()(
			await signedRequest({ body: '{', contentType: 'application/json' }),
		);
		const malformedForm = await slack.routes.interactions()(
			await signedRequest({
				body: 'payload=%7B',
				contentType: 'application/x-www-form-urlencoded',
			}),
		);

		expect(malformedJson.status).toBe(400);
		expect(malformedForm.status).toBe(400);
		expect(handler).not.toHaveBeenCalled();
	});

	it('invokes a shared registration when Hono rewrites a mounted route prefix', async () => {
		const slack = createChannel();
		const handler = vi.fn();
		slack.on('app_mention', handler);
		const app = new Hono();
		app.mount('/webhooks/slack/events', slack.routes.events());

		const response = await app.fetch(
			await signedRequest({
				url: 'https://example.test/webhooks/slack/events?source=slack',
				body: JSON.stringify(
					eventCallback({
						type: 'app_mention',
						channel: 'C1',
						ts: '1',
						text: 'x',
						user: 'U1',
					}),
				),
				contentType: 'application/json',
			}),
		);

		expect(response.status).toBe(200);
		expect(handler).toHaveBeenCalledOnce();
	});

	it('keeps signing identity fixed when the caller mutates the options object', async () => {
		const options = {
			signingSecret: 'original-secret',
			botToken: 'original-token',
			appId: 'A1',
			teamId: 'T1',
		};
		const slack = createSlackChannel(options);
		options.signingSecret = 'mutated-secret';
		options.appId = 'A2';
		options.teamId = 'T2';

		const response = await slack.routes.events()(
			await signedRequest({
				secret: 'original-secret',
				body: JSON.stringify({
					type: 'url_verification',
					challenge: 'challenge-value',
				}),
				contentType: 'application/json',
			}),
		);

		expect(response.status).toBe(200);
	});

	it('round-trips a canonical URL-path-safe thread reference when parsed', () => {
		const slack = createChannel();
		const ref = { teamId: 'T:1', channelId: 'C/2?#', threadTs: '1234.5' };
		const key = slack.conversationKey(ref);

		expect(key).toBe('slack:v1:T%3A1:C%2F2%3F%23:1234.5');
		expect(slack.parseConversationKey(key)).toEqual(ref);
	});

	it('rejects a conversation key when it is non-canonical or foreign', () => {
		const slack = createChannel();

		expect(() => slack.parseConversationKey('github:v1:T1:C1:123')).toThrow(
			InvalidSlackConversationKeyError,
		);
		expect(() => slack.parseConversationKey('slack:v1:T%31:C1:123')).toThrow(
			InvalidSlackConversationKeyError,
		);
	});
});

describe('SlackClient', () => {
	it('posts a thread reply with fixed Slack authentication when inputs are valid', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => Response.json({ ok: true, channel: 'C1', ts: '2' }),
		);
		const slack = createChannel({ fetch });

		await slack.client.postMessage(
			{ teamId: 'T1', channelId: 'C1', threadTs: '1' },
			{ text: 'Hello', blocks: [{ type: 'section' }] },
		);

		expect(fetch).toHaveBeenCalledOnce();
		const [input, init] = fetch.mock.calls[0] ?? [];
		expect(String(input)).toBe('https://slack.com/api/chat.postMessage');
		expect(init?.method).toBe('POST');
		expect(init?.redirect).toBe('manual');
		const headers = new Headers(init?.headers);
		expect(headers.get('authorization')).toBe('Bearer xoxb-test-token');
		expect(headers.get('content-type')).toBe('application/json; charset=utf-8');
		expect(init?.body).toBe(
			JSON.stringify({
				channel: 'C1',
				thread_ts: '1',
				text: 'Hello',
				blocks: [{ type: 'section' }],
			}),
		);
	});

	it('adds a reaction to the bound thread root when inputs are valid', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
		const slack = createChannel({ fetch });

		await slack.client.addReaction(
			{ teamId: 'T1', channelId: 'C1', threadTs: '1' },
			'eyes',
		);

		expect(String(fetch.mock.calls[0]?.[0])).toBe('https://slack.com/api/reactions.add');
		expect(fetch.mock.calls[0]?.[1]?.body).toBe(
			JSON.stringify({ channel: 'C1', timestamp: '1', name: 'eyes' }),
		);
	});

	it('rejects without a provider request when a destination workspace or input is invalid', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const slack = createChannel({ fetch });

		await expect(
			slack.client.postMessage(
				{ teamId: 'T2', channelId: 'C1', threadTs: '1' },
				{ text: 'Hello' },
			),
		).rejects.toBeInstanceOf(InvalidSlackInputError);
		await expect(
			slack.client.addReaction(
				{ teamId: 'T1', channelId: 'C1', threadTs: '1' },
				'',
			),
		).rejects.toBeInstanceOf(InvalidSlackInputError);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('surfaces a structured Slack API error when HTTP succeeds but ok is false', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				Response.json(
					{
						ok: false,
						error: 'channel_not_found',
						response_metadata: { messages: ['credential leaked: xoxb-test-token'] },
					},
					{ headers: { 'x-slack-req-id': 'req-1' } },
				),
		);
		const slack = createChannel({ fetch });

		const error = await slack.client
			.postMessage(
				{ teamId: 'T1', channelId: 'C1', threadTs: '1' },
				{ text: 'Hello' },
			)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(SlackApiError);
		expect(error).toMatchObject({
			status: 200,
			code: 'channel_not_found',
			requestId: 'req-1',
			responseMessage: 'credential leaked: [REDACTED]',
		});
		expect(String(error)).not.toContain('xoxb-test-token');
	});

	it('surfaces a structured rate-limit error when Slack returns Retry-After', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				Response.json(
					{ ok: false, error: 'ratelimited' },
					{ status: 429, headers: { 'retry-after': '30' } },
				),
		);
		const slack = createChannel({ fetch });

		const error = await slack.client
			.addReaction({ teamId: 'T1', channelId: 'C1', threadTs: '1' }, 'eyes')
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(SlackRateLimitError);
		expect(error).toMatchObject({
			status: 429,
			code: 'ratelimited',
			retryAfterSeconds: 30,
		});
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('does not forward credentials when a redirect leaves the Slack HTTPS origin', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(null, {
					status: 307,
					headers: { location: 'https://attacker.example/collect' },
				}),
		);
		const slack = createChannel({ fetch });

		await expect(
			slack.client.postMessage(
				{ teamId: 'T1', channelId: 'C1', threadTs: '1' },
				{ text: 'Hello' },
			),
		).rejects.toMatchObject({ status: 307 });
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('does not replay a write when Slack returns a non-preserving redirect', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(null, {
					status: 303,
					headers: { location: 'https://slack.com/api/chat.postMessage.next' },
				}),
		);
		const slack = createChannel({ fetch });

		await expect(
			slack.client.postMessage(
				{ teamId: 'T1', channelId: 'C1', threadTs: '1' },
				{ text: 'Hello' },
			),
		).rejects.toMatchObject({ status: 303 });
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('follows a bounded same-origin HTTPS redirect when Slack redirects a write', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 307,
					headers: { location: 'https://slack.com/api/chat.postMessage.next' },
				}),
			)
			.mockResolvedValueOnce(Response.json({ ok: true }));
		const slack = createChannel({ fetch });

		await slack.client.postMessage(
			{ teamId: 'T1', channelId: 'C1', threadTs: '1' },
			{ text: 'Hello' },
		);

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(String(fetch.mock.calls[1]?.[0])).toBe(
			'https://slack.com/api/chat.postMessage.next',
		);
		expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
			'Bearer xoxb-test-token',
		);
	});

	it('stops replaying a write when same-origin redirects exceed the bound', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(null, {
					status: 307,
					headers: { location: 'https://slack.com/api/chat.postMessage.next' },
				}),
		);
		const slack = createChannel({ fetch });

		await expect(
			slack.client.postMessage(
				{ teamId: 'T1', channelId: 'C1', threadTs: '1' },
				{ text: 'Hello' },
			),
		).rejects.toMatchObject({ status: 307 });
		expect(fetch).toHaveBeenCalledTimes(4);
	});

	it('surfaces a structured timeout when the provider response stalls', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
						once: true,
					});
				}),
		);
		const slack = createChannel({ fetch, requestTimeoutMs: 5 });

		await expect(
			slack.client.postMessage(
				{ teamId: 'T1', channelId: 'C1', threadTs: '1' },
				{ text: 'Hello' },
			),
		).rejects.toEqual(new SlackTimeoutError(5));
	});

	it('surfaces a structured timeout when the provider response body stalls', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode('{"ok":'));
					init?.signal?.addEventListener(
						'abort',
						() => controller.error(init.signal?.reason),
						{ once: true },
					);
				},
			});
			return new Response(body, { status: 500 });
		});
		const slack = createChannel({ fetch, requestTimeoutMs: 5 });

		await expect(
			slack.client.postMessage(
				{ teamId: 'T1', channelId: 'C1', threadTs: '1' },
				{ text: 'Hello' },
			),
		).rejects.toEqual(new SlackTimeoutError(5));
	});

	it('propagates the caller reason when the caller cancels a request', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
						once: true,
					});
				}),
		);
		const slack = createChannel({ fetch });
		const controller = new AbortController();
		const reason = new DOMException('Cancelled.', 'AbortError');

		const request = slack.client.postMessage(
			{ teamId: 'T1', channelId: 'C1', threadTs: '1' },
			{ text: 'Hello' },
			controller.signal,
		);
		controller.abort(reason);

		await expect(request).rejects.toBe(reason);
	});

	it('keeps the configured token fixed when the caller mutates the options object', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
		const options = {
			signingSecret: 'secret',
			botToken: 'original-token',
			appId: 'A1',
			teamId: 'T1',
			fetch,
		};
		const slack = createSlackChannel(options);
		options.botToken = 'mutated-token';

		await slack.client.postMessage(
			{ teamId: 'T1', channelId: 'C1', threadTs: '1' },
			{ text: 'Hello' },
		);

		expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
			'Bearer original-token',
		);
	});
});

describe('Slack tools', () => {
	it('exposes only message text when a reply destination is pre-bound', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
		const slack = createChannel({ fetch });
		const ref = { teamId: 'T1', channelId: 'C1', threadTs: '1' };
		const tool = slack.tools.replyInThread(ref);
		ref.channelId = 'C2';

		expect(tool.parameters).toEqual({
			type: 'object',
			properties: { text: { type: 'string', minLength: 1 } },
			required: ['text'],
			additionalProperties: false,
		});
		await expect(tool.execute({ text: 'Hello' })).resolves.toBe('Reply posted.');
		expect(fetch.mock.calls[0]?.[1]?.body).toBe(
			JSON.stringify({ channel: 'C1', thread_ts: '1', text: 'Hello' }),
		);
	});

	it('exposes only a reaction name when a root-reaction destination is pre-bound', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
		const slack = createChannel({ fetch });
		const tool = slack.tools.addReaction({
			teamId: 'T1',
			channelId: 'C1',
			threadTs: '1',
		});

		expect(tool.parameters).toEqual({
			type: 'object',
			properties: { name: { type: 'string', minLength: 1 } },
			required: ['name'],
			additionalProperties: false,
		});
		await expect(tool.execute({ name: 'eyes' })).resolves.toBe('Reaction added.');
	});

	it('rejects setup when a trusted tool destination belongs to another workspace', () => {
		const slack = createChannel();

		expect(() =>
			slack.tools.replyInThread({ teamId: 'T2', channelId: 'C1', threadTs: '1' }),
		).toThrow(InvalidSlackInputError);
	});
});

function createChannel(
	overrides: Partial<Parameters<typeof createSlackChannel>[0]> = {},
) {
	return createSlackChannel({
		signingSecret: 'secret',
		botToken: 'xoxb-test-token',
		appId: 'A1',
		teamId: 'T1',
		...overrides,
	});
}

function eventCallback(
	event: Record<string, unknown>,
	options: { appId?: string; teamId?: string } = {},
) {
	return {
		type: 'event_callback',
		api_app_id: options.appId ?? 'A1',
		team_id: options.teamId ?? 'T1',
		event_id: 'Ev1',
		event_time: 1_717_971_234,
		event,
	};
}

function blockAction(): Record<string, any> {
	return {
		type: 'block_actions',
		api_app_id: 'A1',
		team: { id: 'T1' },
		user: { id: 'U1', team_id: 'T1' },
		channel: { id: 'C1' },
		message: { ts: '1717971234.0012', thread_ts: '1717971200.0001' },
		container: {
			type: 'message',
			channel_id: 'C1',
			message_ts: '1717971234.0012',
			thread_ts: '1717971200.0001',
		},
		actions: [{ action_id: 'approve', block_id: 'approval', type: 'button', value: 'yes' }],
	};
}

function viewSubmission(): Record<string, any> {
	return {
		type: 'view_submission',
		api_app_id: 'A1',
		team: { id: 'T1' },
		user: { id: 'U1', team_id: 'T1' },
		view: {
			id: 'V1',
			callback_id: 'feedback',
			private_metadata: 'case-42',
			state: {
				values: { email: { input: { type: 'plain_text_input', value: 'bad' } } },
			},
		},
	};
}

interface SignedRequestOptions {
	body: string;
	contentType: string;
	secret?: string;
	timestamp?: number | string;
	signature?: string;
	headers?: Record<string, string>;
	url?: string;
}

async function signedRequest(options: SignedRequestOptions): Promise<Request> {
	const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
	const signature =
		options.signature ??
		(await signSlack(options.secret ?? 'secret', timestamp, options.body));
	return new Request(options.url ?? 'https://example.test/', {
		method: 'POST',
		headers: {
			'content-type': options.contentType,
			'x-slack-request-timestamp': String(timestamp),
			'x-slack-signature': signature,
			...options.headers,
		},
		body: options.body,
	});
}

async function signedFormPayload(payload: unknown): Promise<Request> {
	const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
	return signedRequest({
		body,
		contentType: 'application/x-www-form-urlencoded; charset=utf-8',
	});
}

async function signSlack(
	secret: string,
	timestamp: number | string,
	body: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign('HMAC', key, encoder.encode(`v0:${timestamp}:${body}`)),
	);
	const hex = Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `v0=${hex}`;
}
