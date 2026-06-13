import { Hono } from 'hono';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
	createShopifyChannel,
	type ShopifyChannel,
	type ShopifyWebhookHandlerInput,
} from '../src/index.ts';

const encoder = new TextEncoder();
const CLIENT_SECRET = 'flue-shopify-current-secret';
const PREVIOUS_CLIENT_SECRET = 'flue-shopify-previous-secret';

describe('createShopifyChannel()', () => {
	it('delivers a verified JSON event when exact request bytes match', async () => {
		const webhook = vi.fn();
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				webhook,
			}),
		);
		const body = ` {\n "id": 940721724,\n "name": "#1001",\n "customer": {"id": 115310627314723954}\n} `;
		const headers = await shopifyHeaders(body, {
			topic: 'orders/create',
			webhookId: '3f884e50-7f2f-48b1-a85b-1f5f1d499173',
			eventId: '9f66d8cb-82e2-4fd7-b70d-369ec19ddc2e',
			triggeredAt: '2026-06-13T23:45:10.123456Z',
			name: 'new-orders',
			subTopic: 'online-store',
		});

		const response = await app.request(jsonRequest(body, headers));
		const tampered = await app.request(jsonRequest(body.replace('#1001', '#changed'), headers));

		expect(response.status).toBe(200);
		expect(tampered.status).toBe(401);
		expect(webhook).toHaveBeenCalledOnce();
		expect(webhook.mock.calls[0]?.[0]).toMatchObject({
			c: expect.any(Object),
			event: {
				topic: 'orders/create',
				shopDomain: 'flue-fixtures.myshopify.com',
				apiVersion: '2026-04',
				webhookId: '3f884e50-7f2f-48b1-a85b-1f5f1d499173',
				eventId: '9f66d8cb-82e2-4fd7-b70d-369ec19ddc2e',
				triggeredAt: '2026-06-13T23:45:10.123456Z',
				name: 'new-orders',
				subTopic: 'online-store',
				payload: {
					id: 940721724,
					name: '#1001',
					customer: { id: '115310627314723954' },
				},
				rawBody: body,
			},
		});
	});

	it('accepts the previous client secret during a rotation overlap', async () => {
		const webhook = vi.fn();
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				previousClientSecret: PREVIOUS_CLIENT_SECRET,
				webhook,
			}),
		);
		const body = JSON.stringify({ shop_id: 7123498765 });

		const previousResponse = await app.request(
			jsonRequest(
				body,
				await shopifyHeaders(body, {
					secret: PREVIOUS_CLIENT_SECRET,
					topic: 'shop/redact',
					webhookId: 'e5f7ce08-306f-4cd4-95d7-d85815f45d5b',
				}),
			),
		);
		const currentResponse = await app.request(
			jsonRequest(
				body,
				await shopifyHeaders(body, {
					topic: 'shop/redact',
					webhookId: '3330580b-7200-44ae-92f9-83b5482a2e46',
				}),
			),
		);

		expect(previousResponse.status).toBe(200);
		expect(currentResponse.status).toBe(200);
		expect(webhook).toHaveBeenCalledTimes(2);
	});

	it('preserves future and compliance topics without requiring a closed payload schema', async () => {
		const webhook = vi.fn();
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				webhook,
			}),
		);
		const deliveries = [
			{
				topic: 'customers/data_request',
				body: JSON.stringify({
					shop_id: 954889,
					shop_domain: 'flue-fixtures.myshopify.com',
					customer: { id: 191167 },
					orders_requested: ['gid://shopify/Order/299938'],
				}),
			},
			{
				topic: 'inventory_forecasts/recalculated',
				body: JSON.stringify({ forecast: [1, 2, 3], source: null }),
			},
		];

		for (const [index, delivery] of deliveries.entries()) {
			const response = await app.request(
				jsonRequest(
					delivery.body,
					await shopifyHeaders(delivery.body, {
						topic: delivery.topic,
						webhookId: `delivery-${index}`,
					}),
				),
			);
			expect(response.status).toBe(200);
		}

		expect(webhook.mock.calls.map(([input]) => input.event.topic)).toEqual([
			'customers/data_request',
			'inventory_forecasts/recalculated',
		]);
		expect(webhook.mock.calls[1]?.[0].event.payload).toEqual({
			forecast: [1, 2, 3],
			source: null,
		});
	});

	it('rejects missing, malformed, and incorrect authentication', async () => {
		const webhook = vi.fn();
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				webhook,
			}),
		);
		const body = JSON.stringify({ id: 101 });
		const valid = await shopifyHeaders(body, {
			topic: 'products/update',
			webhookId: 'valid-auth-delivery',
		});

		const responses = await Promise.all([
			app.request(jsonRequest(body, without(valid, 'x-shopify-hmac-sha256'))),
			app.request(
				jsonRequest(body, {
					...valid,
					'x-shopify-hmac-sha256': 'not-base64',
				}),
			),
			app.request(
				jsonRequest(body, {
					...valid,
					'x-shopify-hmac-sha256': await hmac('different-secret', body),
				}),
			),
		]);

		expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('rejects missing or malformed required and optional delivery metadata', async () => {
		const webhook = vi.fn();
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				webhook,
			}),
		);
		const body = JSON.stringify({ id: 202 });
		const valid = await shopifyHeaders(body, {
			topic: 'products/delete',
			webhookId: 'metadata-delivery',
		});

		const responses = await Promise.all([
			app.request(jsonRequest(body, without(valid, 'x-shopify-topic'))),
			app.request(jsonRequest(body, without(valid, 'x-shopify-shop-domain'))),
			app.request(jsonRequest(body, without(valid, 'x-shopify-api-version'))),
			app.request(jsonRequest(body, without(valid, 'x-shopify-webhook-id'))),
			app.request(jsonRequest(body, { ...valid, 'x-shopify-event-id': '' })),
			app.request(jsonRequest(body, { ...valid, 'x-shopify-name': '' })),
		]);

		expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400]);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('rejects unsupported media, malformed JSON, invalid UTF-8, and oversized bodies', async () => {
		const webhook = vi.fn();
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				bodyLimit: 128,
				webhook,
			}),
		);
		const malformedJson = '{"id":';
		const malformedHeaders = await shopifyHeaders(malformedJson, {
			topic: 'orders/create',
			webhookId: 'malformed-json',
		});
		const invalidBytes = new Uint8Array([0xff]);
		const invalidHeaders = await shopifyHeaders(invalidBytes, {
			topic: 'orders/create',
			webhookId: 'invalid-utf8',
		});
		const shortBody = '{}';
		const declaredHeaders = await shopifyHeaders(shortBody, {
			topic: 'orders/create',
			webhookId: 'declared-size',
		});
		const streamedBody = JSON.stringify({ value: 'x'.repeat(140) });
		const streamedHeaders = await shopifyHeaders(streamedBody, {
			topic: 'orders/create',
			webhookId: 'streamed-size',
		});

		const unsupported = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/xml' },
				body: '<order />',
			}),
		);
		const malformed = await app.request(jsonRequest(malformedJson, malformedHeaders));
		const invalidUtf8 = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...invalidHeaders },
				body: invalidBytes,
			}),
		);
		const invalidLength = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': '128bytes',
					...declaredHeaders,
				},
				body: shortBody,
			}),
		);
		const declared = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': '129',
					...declaredHeaders,
				},
				body: shortBody,
			}),
		);
		const streamed = await app.request(streamingRequest(streamedBody, streamedHeaders));

		expect([
			unsupported.status,
			malformed.status,
			invalidUtf8.status,
			invalidLength.status,
			declared.status,
			streamed.status,
		]).toEqual([415, 400, 400, 400, 413, 413]);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('serializes normal handler results and fails closed on invalid results or errors', async () => {
		const body = JSON.stringify({ id: 303 });
		const outcomes: Array<undefined | object | Response | bigint | Error> = [
			undefined,
			{ accepted: true },
			new Response('accepted later', {
				status: 202,
				headers: { 'x-result': 'response' },
			}),
			1n,
			new Error('handler failed'),
		];
		const responses: Response[] = [];

		for (const [index, outcome] of outcomes.entries()) {
			const app = channelApp(
				createShopifyChannel({
					clientSecret: CLIENT_SECRET,
					webhook() {
						if (outcome instanceof Error) throw outcome;
						return outcome as never;
					},
				}),
			);
			responses.push(
				await app.request(
					jsonRequest(
						body,
						await shopifyHeaders(body, {
							topic: 'orders/updated',
							webhookId: `handler-${index}`,
						}),
					),
				),
			);
		}

		expect(responses.map((response) => response.status)).toEqual([200, 200, 202, 500, 500]);
		await expect(responses[1]?.json()).resolves.toEqual({ accepted: true });
		await expect(responses[2]?.text()).resolves.toBe('accepted later');
		expect(responses[2]?.headers.get('x-result')).toBe('response');
	});

	it('returns a retryable failure when the handler exceeds the configured deadline', async () => {
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				handlerTimeoutMs: 5,
				webhook: () => new Promise(() => {}),
			}),
		);
		const body = JSON.stringify({ id: 404 });

		const response = await app.request(
			jsonRequest(
				body,
				await shopifyHeaders(body, {
					topic: 'orders/cancelled',
					webhookId: 'timeout-delivery',
				}),
			),
		);

		expect(response.status).toBe(500);
	});

	it('applies the configured deadline to body receipt and callback time together', async () => {
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				handlerTimeoutMs: 60,
				webhook: () => new Promise((resolve) => setTimeout(resolve, 40)),
			}),
		);
		const body = JSON.stringify({ id: 505 });
		const headers = await shopifyHeaders(body, {
			topic: 'orders/fulfilled',
			webhookId: 'cumulative-timeout-delivery',
		});

		const response = await app.request(delayedStreamingRequest(body, headers, 40));

		expect(response.status).toBe(500);
	});

	it('validates constructor options and publishes only the fixed webhook route', () => {
		const shopify = createShopifyChannel({
			clientSecret: CLIENT_SECRET,
			webhook() {},
		});

		expect(shopify.routes.map(({ method, path }) => ({ method, path }))).toEqual([
			{ method: 'POST', path: '/webhook' },
		]);
		expect(() => createShopifyChannel(undefined as never)).toThrow(TypeError);
		expect(() => createShopifyChannel({ clientSecret: '', webhook() {} })).toThrow(TypeError);
		expect(() =>
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				previousClientSecret: '',
				webhook() {},
			}),
		).toThrow(TypeError);
		expect(() =>
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				webhook: undefined as never,
			}),
		).toThrow(TypeError);
		expect(() =>
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				bodyLimit: 0,
				webhook() {},
			}),
		).toThrow(TypeError);
		expect(() =>
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				handlerTimeoutMs: 4_501,
				webhook() {},
			}),
		).toThrow(TypeError);

		type CustomEnv = { Bindings: { SHOPIFY_AUDIT_BUCKET: string } };
		expectTypeOf<ShopifyWebhookHandlerInput<CustomEnv>['c']['env']>().toEqualTypeOf<{
			SHOPIFY_AUDIT_BUCKET: string;
		}>();
		expectTypeOf(shopify).toEqualTypeOf<ShopifyChannel>();
	});
});

function channelApp(channel: ShopifyChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

function jsonRequest(body: string, headers: Record<string, string>): Request {
	return new Request('https://example.test/webhook', {
		method: 'POST',
		headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
		body,
	});
}

function streamingRequest(body: string, headers: Record<string, string>): Request {
	const bytes = encoder.encode(body);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.slice(0, 64));
			controller.enqueue(bytes.slice(64));
			controller.close();
		},
	});
	return new Request('https://example.test/webhook', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: stream,
		duplex: 'half',
	} as RequestInit);
}

function delayedStreamingRequest(
	body: string,
	headers: Record<string, string>,
	delayMs: number,
): Request {
	const bytes = encoder.encode(body);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			setTimeout(() => {
				controller.enqueue(bytes);
				controller.close();
			}, delayMs);
		},
	});
	return new Request('https://example.test/webhook', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: stream,
		duplex: 'half',
	} as RequestInit);
}

async function shopifyHeaders(
	body: string | Uint8Array,
	options: {
		topic: string;
		webhookId: string;
		secret?: string;
		eventId?: string;
		triggeredAt?: string;
		name?: string;
		subTopic?: string;
	},
): Promise<Record<string, string>> {
	return {
		'x-shopify-hmac-sha256': await hmac(options.secret ?? CLIENT_SECRET, body),
		'x-shopify-topic': options.topic,
		'x-shopify-shop-domain': 'flue-fixtures.myshopify.com',
		'x-shopify-api-version': '2026-04',
		'x-shopify-webhook-id': options.webhookId,
		...(options.eventId ? { 'x-shopify-event-id': options.eventId } : {}),
		...(options.triggeredAt ? { 'x-shopify-triggered-at': options.triggeredAt } : {}),
		...(options.name ? { 'x-shopify-name': options.name } : {}),
		...(options.subTopic ? { 'x-shopify-sub-topic': options.subTopic } : {}),
	};
}

async function hmac(secret: string, body: string | Uint8Array): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			'HMAC',
			key,
			typeof body === 'string' ? encoder.encode(body) : copyArrayBuffer(body),
		),
	);
	return base64(signature);
}

function base64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function without(headers: Record<string, string>, name: string): Record<string, string> {
	const copy = { ...headers };
	delete copy[name];
	return copy;
}
