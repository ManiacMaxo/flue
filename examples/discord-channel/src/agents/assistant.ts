import { createAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/discord.ts';

export default createAgent(({ id }) => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Post a concise answer to the bound Discord destination.',
	tools: [postMessage(channel.parseConversationKey(id))],
}));
