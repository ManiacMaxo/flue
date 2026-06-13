import { REST } from '@discordjs/rest';
import { createDiscordChannel, type DiscordDestinationRef } from '@flue/discord';
import { defineTool, dispatch } from '@flue/runtime';
import { InteractionResponseType, Routes } from 'discord-api-types/v10';
import assistant from '../agents/assistant.ts';

export const client = new REST({ version: '10' }).setToken(requiredEnv('DISCORD_BOT_TOKEN'));

export const channel = createDiscordChannel({
	publicKey: requiredEnv('DISCORD_PUBLIC_KEY'),
	applicationId: requiredEnv('DISCORD_APPLICATION_ID'),

	// Path: /channels/discord/interactions
	async interactions({ interaction }) {
		if (interaction.type !== 'command' || interaction.data.name !== 'ask') {
			return {
				type: InteractionResponseType.ChannelMessageWithSource,
				data: { content: 'Unsupported interaction.', flags: 64 },
			};
		}

		const destination: DiscordDestinationRef = interaction.destination;
		await dispatch(assistant, {
			id: channel.conversationKey(destination),
			input: {
				type: 'discord.command.ask',
				interactionId: interaction.id,
				data: interaction.data,
			},
		});
		return {
			type: InteractionResponseType.ChannelMessageWithSource,
			data: { content: 'Your request was accepted.', flags: 64 },
		};
	},
});

export function postMessage(ref: DiscordDestinationRef) {
	return defineTool({
		name: 'post_discord_message',
		description: 'Post a message to the Discord destination bound to this agent.',
		parameters: {
			type: 'object',
			properties: {
				content: { type: 'string', minLength: 1 },
			},
			required: ['content'],
			additionalProperties: false,
		},
		async execute({ content }) {
			const result = (await client.post(Routes.channelMessages(ref.channelId), {
				body: { content },
			})) as { id?: string };
			return JSON.stringify({ messageId: result.id });
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
