import type { Context, Env, Handler } from 'hono';
import { InvalidGitLabConversationKeyError, InvalidGitLabInputError } from './errors.ts';
import { createGitLabWebhookHandler } from './webhook.ts';

export { InvalidGitLabConversationKeyError, InvalidGitLabInputError } from './errors.ts';

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface ChannelRoute<E extends Env = Env> {
	readonly method: string;
	readonly path: string;
	readonly handler: Handler<E>;
}

/**
 * Provider-native GitLab webhook payload.
 *
 * GitLab does not publish an authoritative TypeScript package for webhook
 * bodies. The channel therefore forwards the verified JSON object with
 * GitLab's own field names, nesting, and open discriminants such as
 * `object_kind`, `event_name`, `event_type`, and `object_attributes`.
 * Applications narrow the payload for the event families they subscribe to.
 */
export interface GitLabWebhookPayload {
	[key: string]: unknown;
	object_kind?: string;
	event_name?: string;
	event_type?: string;
	object_attributes?: Record<string, unknown>;
}

/** Ingress configuration for one GitLab project or group webhook. */
export interface GitLabChannelOptions<E extends Env = Env> {
	/**
	 * GitLab 19.0+ signing token in `whsec_<base64>` form.
	 *
	 * This is the preferred verifier for new webhooks. Requests carrying a
	 * `webhook-signature` header are verified with this token when configured and
	 * never fall back to `secretToken` after a failed signature verification.
	 */
	signingToken?: string;
	/**
	 * Legacy secret token checked against `X-Gitlab-Token`.
	 *
	 * Use for GitLab versions before signing tokens, or during a migration where
	 * unsigned deliveries can still arrive.
	 */
	secretToken?: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Receives every verified GitLab project or group webhook payload. */
	webhook(input: GitLabWebhookHandlerInput<E>): GitLabHandlerResult;
}

/** Stable GitLab issue or merge-request destination suitable for an agent id. */
export type GitLabConversationRef =
	| {
			type: 'issue';
			/** GitLab instance URL or hostname, such as `https://gitlab.com`. */
			instance: string;
			/** Numeric project id from GitLab webhook payloads and REST routes. */
			projectId: number;
			/** Project-scoped issue iid. */
			iid: number;
	  }
	| {
			type: 'merge-request';
			/** GitLab instance URL or hostname, such as `https://gitlab.com`. */
			instance: string;
			/** Numeric project id from GitLab webhook payloads and REST routes. */
			projectId: number;
			/** Project-scoped merge request iid. */
			iid: number;
	  };

/** Metadata and payload for one verified GitLab webhook request. */
export interface GitLabWebhookDelivery {
	/** `X-Gitlab-Event`, such as `Note Hook` or `Merge Request Hook`. */
	eventName: string;
	/** Provider-native verified JSON payload. */
	payload: GitLabWebhookPayload;
	/** Standard Webhooks `webhook-id`, when supplied. Use for deduplication. */
	deliveryId?: string;
	/** `Idempotency-Key`, available on newer GitLab deliveries and retries. */
	idempotencyKey?: string;
	/** `X-Gitlab-Event-UUID`; recursive webhooks can share this value. */
	eventUuid?: string;
	/** `X-Gitlab-Webhook-UUID`, identifying the configured webhook. */
	webhookUuid?: string;
	/** `X-Gitlab-Instance`, identifying the sender instance. */
	instance?: string;
	/** Standard Webhooks `webhook-timestamp`, when signature auth was used. */
	signatureTimestamp?: string;
}

export interface GitLabWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	delivery: GitLabWebhookDelivery;
}

type GitLabHandlerValue = undefined | JsonValue | Response;

/**
 * Returning nothing produces an empty `200`. JSON-compatible values become
 * JSON responses, and Hono or Fetch responses pass through unchanged.
 */
export type GitLabHandlerResult = GitLabHandlerValue | Promise<GitLabHandlerValue>;

/** Verified GitLab ingress and canonical identity helpers. */
export interface GitLabChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
	/** Serializes a canonical namespaced identifier. It is not an authorization capability. */
	conversationKey(ref: GitLabConversationRef): string;
	/** Parses only canonical keys produced by `conversationKey()`. */
	parseConversationKey(id: string): GitLabConversationRef;
}

/**
 * Creates one verified GitLab project/group webhook route.
 *
 * The route is fixed at `POST /webhook`. GitLab 19.0+ signed deliveries are
 * verified over exact bytes with the Standard Webhooks headers. Legacy
 * deliveries are verified with `X-Gitlab-Token` when `secretToken` is supplied.
 * The channel is stateless and does not deduplicate delivery ids.
 */
export function createGitLabChannel<E extends Env = Env>(
	options: GitLabChannelOptions<E>,
): GitLabChannel<E> {
	validateOptions(options);
	const channel: GitLabChannel<E> = {
		routes: [{ method: 'POST', path: '/webhook', handler: createGitLabWebhookHandler(options) }],
		conversationKey(ref) {
			assertConversationRef(ref);
			return [
				'gitlab',
				'v1',
				'instance',
				encodeURIComponent(ref.instance),
				'project',
				String(ref.projectId),
				ref.type === 'merge-request' ? 'merge-request' : 'issue',
				String(ref.iid),
			].join(':');
		},
		parseConversationKey(id) {
			try {
				const match =
					/^gitlab:v1:instance:([^:]+):project:([1-9]\d*):(issue|merge-request):([1-9]\d*)$/.exec(
						id,
					);
				if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
					throw new InvalidGitLabConversationKeyError();
				}
				const ref: GitLabConversationRef = {
					type: match[3] as 'issue' | 'merge-request',
					instance: decodeURIComponent(match[1]),
					projectId: Number(match[2]),
					iid: Number(match[4]),
				};
				assertConversationRef(ref);
				if (channel.conversationKey(ref) !== id) throw new InvalidGitLabConversationKeyError();
				return ref;
			} catch (error) {
				if (error instanceof InvalidGitLabConversationKeyError) throw error;
				throw new InvalidGitLabConversationKeyError();
			}
		},
	};
	return channel;
}

function validateOptions<E extends Env>(options: GitLabChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createGitLabChannel() requires an options object.');
	}
	if (options.signingToken !== undefined) assertSigningToken(options.signingToken);
	if (
		options.secretToken !== undefined &&
		(typeof options.secretToken !== 'string' || options.secretToken.length === 0)
	) {
		throw new TypeError('GitLab secretToken must be a non-empty string when provided.');
	}
	if (options.signingToken === undefined && options.secretToken === undefined) {
		throw new TypeError('createGitLabChannel() requires signingToken or secretToken.');
	}
	if (typeof options.webhook !== 'function') {
		throw new TypeError('createGitLabChannel() requires a webhook handler.');
	}
}

function assertSigningToken(token: string): void {
	if (typeof token !== 'string' || !token.startsWith('whsec_')) {
		throw new TypeError('GitLab signingToken must be in whsec_<base64> form.');
	}
	try {
		if (decodeSigningToken(token).byteLength !== 32) {
			throw new TypeError('GitLab signingToken must encode a 32-byte key.');
		}
	} catch (error) {
		if (error instanceof TypeError) throw error;
		throw new TypeError('GitLab signingToken must be in whsec_<base64> form.');
	}
}

function decodeSigningToken(token: string): Uint8Array {
	const encoded = token.slice('whsec_'.length);
	const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function assertConversationRef(ref: GitLabConversationRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidGitLabInputError('conversation');
	if (ref.type !== 'issue' && ref.type !== 'merge-request') {
		throw new InvalidGitLabInputError('conversation.type');
	}
	if (
		typeof ref.instance !== 'string' ||
		ref.instance.length === 0 ||
		ref.instance.trim() !== ref.instance
	) {
		throw new InvalidGitLabInputError('conversation.instance');
	}
	if (!Number.isSafeInteger(ref.projectId) || ref.projectId <= 0) {
		throw new InvalidGitLabInputError('conversation.projectId');
	}
	if (!Number.isSafeInteger(ref.iid) || ref.iid <= 0) {
		throw new InvalidGitLabInputError('conversation.iid');
	}
}
