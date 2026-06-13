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

/** Supported guild-channel, guild-thread, or bot-DM destination. */
export type DiscordDestinationRef =
	| { type: 'guild'; guildId: string; channelId: string; channelKind: 'channel' | 'thread' }
	| { type: 'dm'; channelId: string };

export interface DiscordCommandData {
	name: string;
	options: readonly unknown[];
}

export interface DiscordComponentData {
	customId: string;
	componentType: number;
	values?: readonly string[];
}

export interface DiscordModalData {
	customId: string;
	components: readonly unknown[];
	fields: readonly DiscordModalField[];
}

export interface DiscordModalField {
	customId: string;
	type: number;
	value?: string;
}

export interface DiscordInteractionEnvelope<TType extends string, TData> {
	type: TType;
	id: string;
	applicationId: string;
	/**
	 * Sensitive interaction capability. Keep it out of dispatch input, model
	 * context, logs, and durable session data.
	 */
	token: string;
	destination: DiscordDestinationRef;
	data: TData;
	/** Complete parsed payload. It may contain sensitive provider capabilities. */
	raw: unknown;
}

export type DiscordCommandInteraction = DiscordInteractionEnvelope<'command', DiscordCommandData>;
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
	token: string;
	destination: DiscordDestinationRef;
	raw: unknown;
}

export type DiscordInteraction =
	| DiscordCommandInteraction
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
			return `discord:v1:dm:${encodeURIComponent(ref.channelId)}`;
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
				const dmChannelId = /^discord:v1:dm:([^:]+)$/.exec(id)?.[1];
				if (!dmChannelId) throw new InvalidDiscordConversationKeyError();
				const ref: DiscordDestinationRef = {
					type: 'dm',
					channelId: decodeURIComponent(dmChannelId),
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
	if (ref.type !== 'dm') throw new InvalidDiscordInputError('destination type');
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
