import { defineTool, type ToolDefinition } from '@flue/runtime';
import { createSlackClient } from './client.ts';
import {
	DuplicateSlackHandlerError,
	InvalidSlackConversationKeyError,
	InvalidSlackInputError,
} from './errors.ts';
import { createSlackEventsHandler, createSlackInteractionsHandler } from './routes.ts';

export {
	DuplicateSlackHandlerError,
	InvalidSlackConversationKeyError,
	InvalidSlackInputError,
	SlackApiError,
	SlackRateLimitError,
	SlackTimeoutError,
} from './errors.ts';

export interface SlackChannelOptions {
	signingSecret: string;
	botToken: string;
	appId: string;
	teamId: string;
	fetch?: typeof globalThis.fetch;
	requestTimeoutMs?: number;
}

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
	raw: unknown;
}

export interface SlackActionEnvelope {
	type: 'action';
	appId: string;
	teamId: string;
	userId: string;
	actionId: string;
	channelId: string;
	messageTs: string;
	threadTs: string;
	payload: unknown;
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
	raw: unknown;
}

export interface SlackMessage {
	text: string;
	blocks?: readonly unknown[];
}

export type SlackActionResponse = { type: 'ack' };
export type SlackViewResponse =
	| { type: 'ack' }
	| { type: 'validation_errors'; errors: Record<string, string> };

export interface SlackEvents {
	app_mention: SlackEventEnvelope<'app_mention', SlackAppMentionPayload>;
	message: SlackEventEnvelope<'message', SlackMessagePayload>;
}

export type SlackEventName = keyof SlackEvents;
export type SlackNotificationHandler<TEvent> = (event: TEvent) => void | Promise<void>;
export type SlackInteractionHandler<TEvent, TResponse> = (
	event: TEvent,
) => TResponse | Promise<TResponse>;
export type SlackRouteHandler = (request: Request) => Promise<Response>;

export interface SlackRouteOptions {
	bodyLimit?: number;
	handlerTimeoutMs?: number;
}

export interface SlackClient {
	postMessage(ref: SlackThreadRef, message: SlackMessage, signal?: AbortSignal): Promise<void>;
	addReaction(ref: SlackThreadRef, name: string, signal?: AbortSignal): Promise<void>;
}

export interface SlackChannel {
	readonly routes: {
		events(options?: SlackRouteOptions): SlackRouteHandler;
		interactions(options?: SlackRouteOptions): SlackRouteHandler;
	};
	readonly client: SlackClient;
	readonly tools: {
		replyInThread(ref: SlackThreadRef): ToolDefinition;
		addReaction(ref: SlackThreadRef): ToolDefinition;
	};
	on<TKey extends SlackEventName>(
		type: TKey,
		handler: SlackNotificationHandler<SlackEvents[TKey]>,
	): () => void;
	onAction(
		actionId: string,
		handler: SlackInteractionHandler<SlackActionEnvelope, SlackActionResponse>,
	): () => void;
	onView(
		callbackId: string,
		handler: SlackInteractionHandler<SlackViewSubmissionEnvelope, SlackViewResponse>,
	): () => void;
	conversationKey(ref: SlackThreadRef): string;
	parseConversationKey(id: string): SlackThreadRef;
}

export function createSlackChannel(options: SlackChannelOptions): SlackChannel {
	validateOptions(options);
	const signingSecret = options.signingSecret;
	const appId = options.appId;
	const teamId = options.teamId;
	const client = createSlackClient({
		signingSecret,
		botToken: options.botToken,
		appId,
		teamId,
		fetch: options.fetch,
		requestTimeoutMs: options.requestTimeoutMs,
	});
	const eventHandlers = new Map<
		SlackEventName,
		SlackNotificationHandler<SlackEvents[SlackEventName]>
	>();
	const actionHandlers = new Map<
		string,
		SlackInteractionHandler<SlackActionEnvelope, SlackActionResponse>
	>();
	const viewHandlers = new Map<
		string,
		SlackInteractionHandler<SlackViewSubmissionEnvelope, SlackViewResponse>
	>();

	const channel: SlackChannel = {
		routes: {
			events: (routeOptions) =>
				createSlackEventsHandler({
					signingSecret,
					appId,
					teamId,
					bodyLimit: routeOptions?.bodyLimit,
					handlerTimeoutMs: routeOptions?.handlerTimeoutMs,
					getHandler: (type) => eventHandlers.get(type),
				}),
			interactions: (routeOptions) =>
				createSlackInteractionsHandler({
					signingSecret,
					appId,
					teamId,
					bodyLimit: routeOptions?.bodyLimit,
					handlerTimeoutMs: routeOptions?.handlerTimeoutMs,
					getActionHandler: (actionId) => actionHandlers.get(actionId),
					getViewHandler: (callbackId) => viewHandlers.get(callbackId),
				}),
		},
		client,
		tools: {
			replyInThread: (ref) => {
				assertThreadRef(ref, teamId);
				const boundRef = snapshotThreadRef(ref);
				return defineTool({
					name: 'slack_reply_in_thread',
					description: 'Post a reply to the bound Slack thread.',
					parameters: {
						type: 'object',
						properties: { text: { type: 'string', minLength: 1 } },
						required: ['text'],
						additionalProperties: false,
					},
					execute: async ({ text }, signal) => {
						await client.postMessage(boundRef, { text }, signal);
						return 'Reply posted.';
					},
				});
			},
			addReaction: (ref) => {
				assertThreadRef(ref, teamId);
				const boundRef = snapshotThreadRef(ref);
				return defineTool({
					name: 'slack_add_reaction',
					description: 'Add a reaction to the bound Slack thread root.',
					parameters: {
						type: 'object',
						properties: { name: { type: 'string', minLength: 1 } },
						required: ['name'],
						additionalProperties: false,
					},
					execute: async ({ name }, signal) => {
						await client.addReaction(boundRef, name, signal);
						return 'Reaction added.';
					},
				});
			},
		},
		on(type, handler) {
			return registerOne(eventHandlers, type, handler, 'event');
		},
		onAction(actionId, handler) {
			return registerOne(actionHandlers, actionId, handler, 'action');
		},
		onView(callbackId, handler) {
			return registerOne(viewHandlers, callbackId, handler, 'view');
		},
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

function registerOne<TKey, THandler>(
	handlers: Map<TKey, THandler>,
	key: TKey,
	handler: THandler,
	kind: 'event' | 'action' | 'view',
): () => void {
	if (typeof key !== 'string' || key.length === 0 || key.trim() !== key) {
		throw new InvalidSlackInputError(`${kind} key`);
	}
	if (typeof handler !== 'function') {
		throw new TypeError(`Slack ${kind} handler must be a function.`);
	}
	if (handlers.has(key)) throw new DuplicateSlackHandlerError(kind, key);
	handlers.set(key, handler);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		if (handlers.get(key) === handler) handlers.delete(key);
	};
}

function validateOptions(options: SlackChannelOptions): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createSlackChannel() requires an options object.');
	}
	assertOption(options.signingSecret, 'signingSecret');
	assertOption(options.botToken, 'botToken');
	assertOption(options.appId, 'appId');
	assertOption(options.teamId, 'teamId');
	if (options.fetch !== undefined && typeof options.fetch !== 'function') {
		throw new TypeError('createSlackChannel() fetch must be a function.');
	}
	if (
		options.requestTimeoutMs !== undefined &&
		(!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
	) {
		throw new TypeError('createSlackChannel() requestTimeoutMs must be a positive integer.');
	}
}

function assertOption(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new TypeError(`createSlackChannel() requires a non-empty ${field}.`);
	}
}

function assertThreadRef(ref: SlackThreadRef, expectedTeamId?: string): void {
	if (!ref || typeof ref !== 'object') throw new InvalidSlackInputError('ref');
	assertIdentifier(ref.teamId, 'teamId');
	if (expectedTeamId !== undefined && ref.teamId !== expectedTeamId) {
		throw new InvalidSlackInputError('teamId');
	}
	assertIdentifier(ref.channelId, 'channelId');
	assertIdentifier(ref.threadTs, 'threadTs');
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new InvalidSlackInputError(field);
	}
}

function snapshotThreadRef(ref: SlackThreadRef): SlackThreadRef {
	return {
		teamId: ref.teamId,
		channelId: ref.channelId,
		threadTs: ref.threadTs,
	};
}
