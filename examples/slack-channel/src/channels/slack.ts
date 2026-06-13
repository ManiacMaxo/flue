import { dispatch } from '@flue/runtime';
import { createSlackChannel } from '@flue/slack';
import assistant from '../agents/assistant.ts';

export const slack = createSlackChannel({
	signingSecret: requiredEnv('SLACK_SIGNING_SECRET'),
	botToken: requiredEnv('SLACK_BOT_TOKEN'),
	appId: requiredEnv('SLACK_APP_ID'),
	teamId: requiredEnv('SLACK_TEAM_ID'),
});

slack.on('app_mention', async (event) => {
	const thread = {
		teamId: event.teamId,
		channelId: event.payload.channelId,
		threadTs: event.payload.threadTs ?? event.payload.messageTs,
	};
	await dispatch(assistant, {
		id: slack.conversationKey(thread),
		input: {
			type: 'slack.app_mention',
			eventId: event.eventId,
			text: event.payload.text,
		},
	});
});

slack.onAction('approve', async (event) => {
	const thread = {
		teamId: event.teamId,
		channelId: event.channelId,
		threadTs: event.threadTs,
	};
	await dispatch(assistant, {
		id: slack.conversationKey(thread),
		input: {
			type: 'slack.action',
			actionId: event.actionId,
			userId: event.userId,
			messageTs: event.messageTs,
		},
	});
	return { type: 'ack' };
});

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
