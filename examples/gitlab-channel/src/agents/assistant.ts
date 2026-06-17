import { createAgent } from '@flue/runtime';
import { channel, postNote } from '../channels/gitlab.ts';

export default createAgent(({ id }) => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Review the GitLab conversation and post a concise note when appropriate.',
	tools: [postNote(channel.parseConversationKey(id))],
}));
