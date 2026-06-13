import type { Context, Env, Handler } from 'hono';
import { createShopifyWebhookHandler } from './webhook.ts';

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface ChannelRoute<E extends Env = Env> {
	readonly method: string;
	readonly path: string;
	readonly handler: Handler<E>;
}

/** Ingress configuration for one Shopify app secret. */
export interface ShopifyChannelOptions<E extends Env = Env> {
	/** Current app client secret used to verify exact Shopify request bytes. */
	clientSecret: string;
	/**
	 * Previous app client secret accepted during Shopify's rotation propagation
	 * period. Remove it after deliveries use the current secret.
	 */
	previousClientSecret?: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/**
	 * Complete route deadline, including body receipt, verification, parsing,
	 * and the application callback. Defaults to and may not exceed 4500ms,
	 * leaving time before Shopify's five-second delivery deadline.
	 *
	 * Timed-out work may continue running after the failure response.
	 */
	handlerTimeoutMs?: number;
	/** Receives every verified JSON Shopify webhook delivery. */
	webhook(input: ShopifyWebhookHandlerInput<E>): ShopifyHandlerResult;
}

/**
 * One verified Shopify JSON webhook.
 *
 * Payload fields depend on the topic, API version, and subscription field
 * selection, so applications validate the fields they consume.
 */
export interface ShopifyWebhookEvent<TPayload extends JsonValue = JsonValue> {
	/** Provider topic such as `orders/create` or `shop/redact`. */
	topic: string;
	/** Shop tenant supplied in `X-Shopify-Shop-Domain`. */
	shopDomain: string;
	/** Serializer version supplied in `X-Shopify-API-Version`. */
	apiVersion: string;
	/** Delivery id suitable for application-owned deduplication. */
	webhookId: string;
	/** Optional causal id shared by deliveries produced by the same action. */
	eventId?: string;
	/** Optional provider timestamp. Shopify does not include it in the HMAC. */
	triggeredAt?: string;
	/** Optional configured subscription name. */
	name?: string;
	/** Optional provider sub-topic metadata. */
	subTopic?: string;
	/**
	 * Parsed provider JSON. Unsafe numeric literals are strings so 64-bit
	 * Shopify identifiers are not rounded by JavaScript.
	 */
	payload: TPayload;
	/** Exact UTF-8 body after successful signature verification. */
	rawBody: string;
}

export interface ShopifyWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	event: ShopifyWebhookEvent;
}

type ShopifyHandlerValue = undefined | JsonValue | Response;

/**
 * Returning no value or JSON acknowledges with `200`. A returned `Response`
 * passes through; Shopify retries non-2xx responses.
 */
export type ShopifyHandlerResult = ShopifyHandlerValue | Promise<ShopifyHandlerValue>;

/** Verified Shopify ingress. */
export interface ShopifyChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
}

/**
 * Creates one verified Shopify JSON webhook route.
 *
 * The route is fixed at `POST /webhook`. The channel is stateless and does not
 * deduplicate or reorder deliveries.
 */
export function createShopifyChannel<E extends Env = Env>(
	options: ShopifyChannelOptions<E>,
): ShopifyChannel<E> {
	validateOptions(options);
	return {
		routes: [
			{
				method: 'POST',
				path: '/webhook',
				handler: createShopifyWebhookHandler(options),
			},
		],
	};
}

function validateOptions<E extends Env>(options: ShopifyChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createShopifyChannel() requires an options object.');
	}
	if (typeof options.clientSecret !== 'string' || options.clientSecret.length === 0) {
		throw new TypeError('createShopifyChannel() requires a non-empty clientSecret.');
	}
	if (
		options.previousClientSecret !== undefined &&
		(typeof options.previousClientSecret !== 'string' || options.previousClientSecret.length === 0)
	) {
		throw new TypeError('Shopify previousClientSecret must be a non-empty string.');
	}
	if (typeof options.webhook !== 'function') {
		throw new TypeError('createShopifyChannel() requires a webhook handler.');
	}
}
