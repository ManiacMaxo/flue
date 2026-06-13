import { createAgent } from '@flue/runtime';
import { channel, replyInThread } from '../channels/slack.ts';

export default createAgent(({ id }) => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Reply in the bound Slack thread when appropriate.',
	tools: [replyInThread(channel.parseConversationKey(id))],
}));
