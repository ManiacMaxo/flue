import type { Context, Env, Handler } from 'hono';
import { InvalidSlackConversationKeyError, InvalidSlackInputError } from './errors.ts';
import { createSlackEventsHandler, createSlackInteractionsHandler } from './routes.ts';

export { InvalidSlackConversationKeyError, InvalidSlackInputError } from './errors.ts';

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

/** Ingress configuration for one fixed Slack application and workspace. */
export interface SlackChannelOptions<E extends Env = Env> {
	signingSecret: string;
	/** Expected signed Slack application id. */
	appId: string;
	/** Expected workspace id. Org-wide installations are not supported in v1. */
	teamId: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Handler deadline in milliseconds. Defaults to and may not exceed 2500. */
	handlerTimeoutMs?: number;
	/** Optional Events API callback. Omit it to omit `/events`. */
	events?(input: SlackEventsHandlerInput<E>): SlackHandlerResult;
	/** Optional interactivity callback. Omit it to omit `/interactions`. */
	interactions?(input: SlackInteractionsHandlerInput<E>): SlackHandlerResult;
}

/** Canonical Slack thread destination within the configured workspace. */
export interface SlackThreadRef {
	teamId: string;
	channelId: string;
	threadTs: string;
}

export interface SlackAppMentionPayload {
	channelId: string;
	messageTs: string;
	threadTs?: string;
	text: string;
	userId: string;
}

export interface SlackMessagePayload {
	channelId: string;
	messageTs: string;
	threadTs?: string;
	text: string;
	userId: string;
}

export interface SlackEventEnvelope<TType extends string, TPayload> {
	type: TType;
	eventId: string;
	appId: string;
	teamId: string;
	retry?: { number: number; reason?: string };
	payload: TPayload;
	/** Parsed provider payload. Treat this as untrusted provider data. */
	raw: unknown;
}

export interface SlackUnknownEvent {
	type: 'unknown';
	eventType: string;
	/** Slack event id when the unsupported envelope supplies one. */
	eventId?: string;
	appId: string;
	teamId: string;
	retry?: { number: number; reason?: string };
	raw: unknown;
}

export interface SlackActionEnvelope {
	type: 'action';
	appId: string;
	teamId: string;
	userId: string;
	actionId: string;
	/** Signed action value when the provider action supplies one. */
	value?: string;
	channelId: string;
	messageTs: string;
	threadTs: string;
	/** Provider-native action object. */
	payload: unknown;
	/**
	 * Complete parsed interaction payload. It may contain a signed
	 * `response_url` capability; keep it out of dispatch input, model context,
	 * logs, and durable session data.
	 */
	raw: unknown;
}

export interface SlackViewSubmissionEnvelope {
	type: 'view_submission';
	appId: string;
	teamId: string;
	userId: string;
	viewId: string;
	callbackId: string;
	privateMetadata?: string;
	values: unknown;
	/**
	 * Complete parsed interaction payload. It may contain a signed
	 * `response_url` capability; keep it out of dispatch input, model context,
	 * logs, and durable session data.
	 */
	raw: unknown;
}

export interface SlackUnknownInteraction {
	type: 'unknown';
	interactionType: string;
	appId: string;
	teamId: string;
	userId: string;
	raw: unknown;
}

export interface SlackEvents {
	app_mention: SlackEventEnvelope<'app_mention', SlackAppMentionPayload>;
	message: SlackEventEnvelope<'message', SlackMessagePayload>;
}

export type SlackEvent = SlackEvents[keyof SlackEvents] | SlackUnknownEvent;
export type SlackInteraction =
	| SlackActionEnvelope
	| SlackViewSubmissionEnvelope
	| SlackUnknownInteraction;

/** Provider-native Slack view validation response. */
export interface SlackViewValidationResponse {
	response_action: 'errors';
	errors: Record<string, string>;
}

type SlackHandlerValue = undefined | JsonValue | SlackViewValidationResponse | Response;

export type SlackHandlerResult = SlackHandlerValue | Promise<SlackHandlerValue>;

export interface SlackEventsHandlerInput<E extends Env = Env> {
	c: Context<E>;
	event: SlackEvent;
}

export interface SlackInteractionsHandlerInput<E extends Env = Env> {
	c: Context<E>;
	interaction: SlackInteraction;
}

/** Verified ingress and canonical identity helpers. */
export interface SlackChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
	/** Serializes a canonical namespaced identifier. It is not an authorization capability. */
	conversationKey(ref: SlackThreadRef): string;
	/** Parses only canonical keys produced by `conversationKey()`. */
	parseConversationKey(id: string): SlackThreadRef;
}

/**
 * Creates a fixed-workspace Slack channel.
 *
 * Signed request timestamps must be within five minutes of the server clock.
 * Successful acknowledgement waits for the configured handler, and the
 * channel does not deduplicate Events API retries.
 */
export function createSlackChannel<E extends Env = Env>(
	options: SlackChannelOptions<E>,
): SlackChannel<E> {
	validateOptions(options);
	const signingSecret = options.signingSecret;
	const appId = options.appId;
	const teamId = options.teamId;
	const routes: ChannelRoute<E>[] = [];

	if (options.events) {
		routes.push({
			method: 'POST',
			path: '/events',
			handler: createSlackEventsHandler({
				signingSecret,
				appId,
				teamId,
				bodyLimit: options.bodyLimit,
				handlerTimeoutMs: options.handlerTimeoutMs,
				events: options.events,
			}),
		});
	}
	if (options.interactions) {
		routes.push({
			method: 'POST',
			path: '/interactions',
			handler: createSlackInteractionsHandler({
				signingSecret,
				appId,
				teamId,
				bodyLimit: options.bodyLimit,
				handlerTimeoutMs: options.handlerTimeoutMs,
				interactions: options.interactions,
			}),
		});
	}
	if (routes.length === 0) {
		throw new TypeError('createSlackChannel() requires an events or interactions handler.');
	}

	const channel: SlackChannel<E> = {
		routes,
		conversationKey(ref) {
			assertThreadRef(ref);
			return `slack:v1:${encodeURIComponent(ref.teamId)}:${encodeURIComponent(ref.channelId)}:${encodeURIComponent(ref.threadTs)}`;
		},
		parseConversationKey(id) {
			try {
				const match = /^slack:v1:([^:]+):([^:]+):([^:]+)$/.exec(id);
				const teamId = match?.[1];
				const channelId = match?.[2];
				const threadTs = match?.[3];
				if (!teamId || !channelId || !threadTs) throw new InvalidSlackConversationKeyError();
				const ref = {
					teamId: decodeURIComponent(teamId),
					channelId: decodeURIComponent(channelId),
					threadTs: decodeURIComponent(threadTs),
				};
				assertThreadRef(ref);
				if (channel.conversationKey(ref) !== id) throw new InvalidSlackConversationKeyError();
				return ref;
			} catch (error) {
				if (error instanceof InvalidSlackConversationKeyError) throw error;
				throw new InvalidSlackConversationKeyError();
			}
		},
	};

	return channel;
}

function validateOptions<E extends Env>(options: SlackChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createSlackChannel() requires an options object.');
	}
	assertOption(options.signingSecret, 'signingSecret');
	assertOption(options.appId, 'appId');
	assertOption(options.teamId, 'teamId');
	if (options.events !== undefined && typeof options.events !== 'function') {
		throw new TypeError('Slack events handler must be a function.');
	}
	if (options.interactions !== undefined && typeof options.interactions !== 'function') {
		throw new TypeError('Slack interactions handler must be a function.');
	}
}

function assertOption(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new TypeError(`createSlackChannel() requires a non-empty ${field}.`);
	}
}

function assertThreadRef(ref: SlackThreadRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidSlackInputError('ref');
	assertIdentifier(ref.teamId, 'teamId');
	assertIdentifier(ref.channelId, 'channelId');
	assertIdentifier(ref.threadTs, 'threadTs');
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new InvalidSlackInputError(field);
	}
}
