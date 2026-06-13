import type { Context, Env, Handler } from 'hono';
import { InvalidDiscordConversationKeyError, InvalidDiscordInputError } from './errors.ts';
import { createDiscordInteractionsHandler } from './routes.ts';

export { InvalidDiscordConversationKeyError, InvalidDiscordInputError } from './errors.ts';

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

/** Ingress configuration for one fixed Discord application. */
export interface DiscordChannelOptions<E extends Env = Env> {
	/** 32-byte Discord application public key encoded as 64 hexadecimal characters. */
	publicKey: string;
	/** Expected signed Discord application id. */
	applicationId: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Handler deadline in milliseconds. Defaults to and may not exceed 2500. */
	handlerTimeoutMs?: number;
	interactions(input: DiscordInteractionsHandlerInput<E>): DiscordHandlerResult;
}

/** Stable Discord destination when an interaction supplies channel identity. */
export type DiscordDestinationRef =
	| { type: 'guild'; guildId: string; channelId: string; channelKind: 'channel' | 'thread' }
	| { type: 'dm'; channelId: string }
	| { type: 'private'; channelId: string };

/** User who invoked a verified interaction. */
export interface DiscordUserRef {
	id: string;
}

/** Installation identities that authorized an interaction. */
export interface DiscordAuthorizingIntegrationOwners {
	guildId?: string;
	userId?: string;
}

/**
 * Short-lived capability for interaction callbacks and follow-up messages.
 *
 * Never place this value in model context, dispatch input, logs, or durable
 * session data.
 */
export interface DiscordInteractionCapabilities {
	token: string;
}

export interface DiscordCommandData {
	/** Discord application-command type. */
	commandType: number;
	name: string;
	options: readonly unknown[];
	targetId?: string;
	resolved?: unknown;
}

export interface DiscordAutocompleteData {
	name: string;
	options: readonly unknown[];
	resolved?: unknown;
}

export interface DiscordComponentData {
	customId: string;
	componentType: number;
	values?: readonly string[];
	resolved?: unknown;
	message: unknown;
}

export interface DiscordModalData {
	customId: string;
	components: readonly unknown[];
	fields: readonly DiscordModalField[];
	resolved?: unknown;
}

export interface DiscordModalField {
	customId: string;
	type: number;
	value?: string | boolean | null;
	values?: readonly string[];
}

export interface DiscordInteractionEnvelope<TType extends string, TData> {
	type: TType;
	id: string;
	applicationId: string;
	user: DiscordUserRef;
	/** Discord interaction-context type when supplied by the provider. */
	context?: number;
	destination?: DiscordDestinationRef;
	locale?: string;
	guildLocale?: string;
	authorizingIntegrationOwners?: DiscordAuthorizingIntegrationOwners;
	capabilities: DiscordInteractionCapabilities;
	data: TData;
	/** Complete parsed payload. It may contain sensitive provider capabilities. */
	raw: unknown;
}

export type DiscordCommandInteraction = DiscordInteractionEnvelope<'command', DiscordCommandData>;
export type DiscordAutocompleteInteraction = DiscordInteractionEnvelope<
	'autocomplete',
	DiscordAutocompleteData
>;
export type DiscordComponentInteraction = DiscordInteractionEnvelope<
	'component',
	DiscordComponentData
>;
export type DiscordModalInteraction = DiscordInteractionEnvelope<'modal', DiscordModalData>;

export interface DiscordUnknownInteraction {
	type: 'unknown';
	interactionType: number;
	id: string;
	applicationId: string;
	user: DiscordUserRef;
	context?: number;
	destination?: DiscordDestinationRef;
	locale?: string;
	guildLocale?: string;
	authorizingIntegrationOwners?: DiscordAuthorizingIntegrationOwners;
	capabilities: DiscordInteractionCapabilities;
	raw: unknown;
}

export type DiscordInteraction =
	| DiscordCommandInteraction
	| DiscordAutocompleteInteraction
	| DiscordComponentInteraction
	| DiscordModalInteraction
	| DiscordUnknownInteraction;

/**
 * Discord interaction callback response in provider wire format.
 *
 * The package checks JSON compatibility at runtime but does not duplicate
 * Discord's full response schema.
 */
export interface DiscordInteractionResponse {
	type: number;
	data?: JsonValue;
}

export type DiscordHandlerResult =
	| DiscordInteractionResponse
	| Response
	| Promise<DiscordInteractionResponse | Response>;

export interface DiscordInteractionsHandlerInput<E extends Env = Env> {
	c: Context<E>;
	interaction: DiscordInteraction;
}

/** Verified interactions and canonical identity helpers. */
export interface DiscordChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
	/** Serializes a canonical namespaced identifier. It is not an authorization capability. */
	conversationKey(ref: DiscordDestinationRef): string;
	/** Parses only canonical keys produced by `conversationKey()`. */
	parseConversationKey(id: string): DiscordDestinationRef;
}

/**
 * Creates a fixed-application Discord HTTP interactions channel.
 *
 * PING is handled internally. Successful interactions wait for the configured
 * handler, and the channel does not deduplicate interaction ids.
 */
export function createDiscordChannel<E extends Env = Env>(
	options: DiscordChannelOptions<E>,
): DiscordChannel<E> {
	const publicKey = validateOptions(options);
	const applicationId = options.applicationId;
	const interactions = options.interactions;
	const handler = createDiscordInteractionsHandler({
		publicKey,
		applicationId,
		bodyLimit: options.bodyLimit,
		handlerTimeoutMs: options.handlerTimeoutMs,
		interactions,
	});

	const channel: DiscordChannel<E> = {
		routes: [{ method: 'POST', path: '/interactions', handler }],
		conversationKey(ref) {
			assertDestinationRef(ref);
			if (ref.type === 'guild') {
				return `discord:v1:guild:${encodeURIComponent(ref.guildId)}:${ref.channelKind}:${encodeURIComponent(ref.channelId)}`;
			}
			return `discord:v1:${ref.type}:${encodeURIComponent(ref.channelId)}`;
		},
		parseConversationKey(id) {
			try {
				const guild = /^discord:v1:guild:([^:]+):(channel|thread):([^:]+)$/.exec(id);
				const guildId = guild?.[1];
				const channelKind = guild?.[2];
				const channelId = guild?.[3];
				if (guildId && (channelKind === 'channel' || channelKind === 'thread') && channelId) {
					const ref: DiscordDestinationRef = {
						type: 'guild',
						guildId: decodeURIComponent(guildId),
						channelId: decodeURIComponent(channelId),
						channelKind,
					};
					assertDestinationRef(ref);
					if (channel.conversationKey(ref) !== id) throw new InvalidDiscordConversationKeyError();
					return ref;
				}
				const direct = /^discord:v1:(dm|private):([^:]+)$/.exec(id);
				const type = direct?.[1];
				const directChannelId = direct?.[2];
				if ((type !== 'dm' && type !== 'private') || !directChannelId) {
					throw new InvalidDiscordConversationKeyError();
				}
				const ref: DiscordDestinationRef = {
					type,
					channelId: decodeURIComponent(directChannelId),
				};
				assertDestinationRef(ref);
				if (channel.conversationKey(ref) !== id) throw new InvalidDiscordConversationKeyError();
				return ref;
			} catch (error) {
				if (error instanceof InvalidDiscordConversationKeyError) throw error;
				throw new InvalidDiscordConversationKeyError();
			}
		},
	};

	return channel;
}

function validateOptions<E extends Env>(options: DiscordChannelOptions<E>): Uint8Array {
	if (!options || typeof options !== 'object') throw new InvalidDiscordInputError('options');
	if (!/^[0-9a-fA-F]{64}$/.test(options.publicKey)) {
		throw new InvalidDiscordInputError('publicKey');
	}
	assertIdentifier(options.applicationId, 'applicationId');
	if (typeof options.interactions !== 'function') {
		throw new InvalidDiscordInputError('interactions');
	}
	return decodeHex(options.publicKey);
}

function assertDestinationRef(ref: DiscordDestinationRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidDiscordInputError('ref');
	assertIdentifier(ref.channelId, 'channelId');
	if (ref.type === 'guild') {
		assertIdentifier(ref.guildId, 'guildId');
		if (ref.channelKind !== 'channel' && ref.channelKind !== 'thread') {
			throw new InvalidDiscordInputError('channelKind');
		}
		return;
	}
	if (ref.type !== 'dm' && ref.type !== 'private') {
		throw new InvalidDiscordInputError('destination type');
	}
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new InvalidDiscordInputError(field);
	}
}

function decodeHex(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}
