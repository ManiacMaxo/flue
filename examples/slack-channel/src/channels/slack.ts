import { defineTool, dispatch } from '@flue/runtime';
import { createSlackChannel } from '@flue/slack';
import { WebClient } from '@slack/web-api';
import assistant from '../agents/assistant.ts';

export const client = new WebClient(requiredEnv('SLACK_BOT_TOKEN'));

export const channel = createSlackChannel({
	signingSecret: requiredEnv('SLACK_SIGNING_SECRET'),
	appId: requiredEnv('SLACK_APP_ID'),
	teamId: requiredEnv('SLACK_TEAM_ID'),

	// Path: /channels/slack/events
	async events({ event }) {
		switch (event.type) {
			case 'app_mention': {
				const thread = {
					teamId: event.teamId,
					channelId: event.payload.channelId,
					threadTs: event.payload.threadTs ?? event.payload.messageTs,
				};
				await dispatch(assistant, {
					id: channel.conversationKey(thread),
					input: {
						type: 'slack.app_mention',
						eventId: event.eventId,
						text: event.payload.text,
					},
				});
				return;
			}
			default:
				return;
		}
	},

	// Enable this surface when the application handles Block Kit or view interactions.
	// Path: /channels/slack/interactions
	// async interactions({ interaction }) {
	// 	return;
	// },
});

export function replyInThread(ref: { channelId: string; threadTs: string }) {
	return defineTool({
		name: 'reply_in_slack_thread',
		description: 'Reply in the Slack thread bound to this agent.',
		parameters: {
			type: 'object',
			properties: {
				text: { type: 'string', minLength: 1 },
			},
			required: ['text'],
			additionalProperties: false,
		},
		async execute({ text }) {
			const result = await client.chat.postMessage({
				channel: ref.channelId,
				thread_ts: ref.threadTs,
				text,
			});
			return JSON.stringify({ channel: result.channel, ts: result.ts });
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
