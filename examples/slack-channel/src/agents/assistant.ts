import { createAgent } from '@flue/runtime';
import { slack } from '../channels/slack.ts';

export default createAgent(({ id }) => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Reply in the bound Slack thread when appropriate.',
	tools: [
		slack.tools.replyInThread(slack.parseConversationKey(id)),
		slack.tools.addReaction(slack.parseConversationKey(id)),
	],
}));
