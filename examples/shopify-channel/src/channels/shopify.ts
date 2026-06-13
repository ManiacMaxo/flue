import { defineTool, dispatch } from '@flue/runtime';
import { createShopifyChannel, type JsonValue } from '@flue/shopify';
import assistant from '../agents/assistant.ts';
import { createShopifyClient, retrieveShopifyOrder } from '../shopify-client.ts';

const ORDER_INSTANCE_PREFIX = 'shopify-order:';
const shopDomain = requiredEnv('SHOPIFY_SHOP_DOMAIN');

export interface ShopifyOrderRef {
	shopDomain: string;
	orderId: string;
}

export const client = createShopifyClient({
	shopDomain,
	accessToken: requiredEnv('SHOPIFY_ADMIN_ACCESS_TOKEN'),
});

export const channel = createShopifyChannel({
	clientSecret: requiredEnv('SHOPIFY_CLIENT_SECRET'),
	previousClientSecret: optionalEnv('SHOPIFY_PREVIOUS_CLIENT_SECRET'),

	// Path: /channels/shopify/webhook
	async webhook({ c, event }) {
		if (event.shopDomain !== shopDomain) {
			return c.json({ error: 'Unexpected Shopify shop domain.' }, 403);
		}

		switch (event.topic) {
			case 'orders/create': {
				const order = parseOrderCreatedPayload(event.payload);
				if (!order) {
					return c.json({ error: 'Unsupported orders/create payload.' }, 400);
				}

				const ref = {
					shopDomain: event.shopDomain,
					orderId: order.id,
				};
				await dispatch(assistant, {
					id: shopifyOrderInstanceId(ref),
					input: {
						type: 'shopify.orders/create',
						webhookId: event.webhookId,
						...(event.eventId === undefined ? {} : { eventId: event.eventId }),
						shopDomain: event.shopDomain,
						orderId: order.id,
						orderName: order.name,
					},
				});
				return;
			}
			default:
				return;
		}
	},
});

export function retrieveOrder(ref: ShopifyOrderRef) {
	if (ref.shopDomain !== shopDomain) {
		throw new TypeError('Shopify order does not belong to the configured shop.');
	}
	return defineTool({
		name: 'retrieve_shopify_order',
		description: 'Retrieve the Shopify order already bound to this agent.',
		parameters: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		async execute() {
			const order = await retrieveShopifyOrder(client, ref.orderId);
			return JSON.stringify({ order });
		},
	});
}

export function shopifyOrderInstanceId(ref: ShopifyOrderRef): string {
	if (!isShopDomain(ref.shopDomain) || !isOrderId(ref.orderId)) {
		throw new TypeError('Shopify order reference is invalid.');
	}
	return `${ORDER_INSTANCE_PREFIX}${encodeURIComponent(JSON.stringify(ref))}`;
}

export function parseShopifyOrderInstanceId(id: string): ShopifyOrderRef {
	if (!id.startsWith(ORDER_INSTANCE_PREFIX)) {
		throw new TypeError('Expected a local Shopify order instance id.');
	}

	let value: unknown;
	try {
		value = JSON.parse(decodeURIComponent(id.slice(ORDER_INSTANCE_PREFIX.length)));
	} catch {
		throw new TypeError('Expected a local Shopify order instance id.');
	}

	if (!isRecord(value) || !isShopDomain(value.shopDomain) || !isOrderId(value.orderId)) {
		throw new TypeError('Expected a local Shopify order instance id.');
	}
	return {
		shopDomain: value.shopDomain,
		orderId: String(value.orderId),
	};
}

function parseOrderCreatedPayload(payload: JsonValue): { id: string; name: string } | undefined {
	if (!isRecord(payload)) return undefined;
	if (!isOrderId(payload.id)) return undefined;
	if (typeof payload.name !== 'string' || payload.name.length === 0) return undefined;
	return {
		id: String(payload.id),
		name: payload.name,
	};
}

function isShopDomain(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(value);
}

function isOrderId(value: unknown): value is string | number {
	if (typeof value === 'string') return /^[1-9]\d*$/.test(value);
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

function optionalEnv(name: string): string | undefined {
	return process.env[name] || undefined;
}
