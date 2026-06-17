import {
	createGitLabChannel,
	type GitLabConversationRef,
	type GitLabWebhookPayload,
} from '@flue/gitlab';
import { defineTool, dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';
import { GitLabClient } from '../gitlab-client.ts';

const gitlabInstance = optionalEnv('GITLAB_INSTANCE') ?? 'https://gitlab.com';

export const client = new GitLabClient({
	instance: gitlabInstance,
	token: requiredEnv('GITLAB_TOKEN'),
});

export const channel = createGitLabChannel({
	...(optionalEnv('GITLAB_WEBHOOK_SIGNING_TOKEN') === undefined
		? {}
		: { signingToken: optionalEnv('GITLAB_WEBHOOK_SIGNING_TOKEN') }),
	...(optionalEnv('GITLAB_WEBHOOK_SECRET_TOKEN') === undefined
		? {}
		: { secretToken: optionalEnv('GITLAB_WEBHOOK_SECRET_TOKEN') }),

	// Path: /channels/gitlab/webhook
	async webhook({ delivery }) {
		if (delivery.eventName !== 'Note Hook' || !isNoteEvent(delivery.payload)) return;
		const note = delivery.payload.object_attributes;
		if (note.action !== 'create' || note.system) return;

		const projectId = projectIdFrom(delivery.payload);
		const instance = delivery.instance ?? gitlabInstance;
		if (projectId === undefined) return;

		if (note.noteable_type === 'Issue' && isIssue(delivery.payload.issue)) {
			const ref = {
				type: 'issue' as const,
				instance,
				projectId,
				iid: delivery.payload.issue.iid,
			};
			await dispatch(assistant, {
				id: channel.conversationKey(ref),
				input: {
					type: 'gitlab.issue_note.created',
					deliveryId: delivery.deliveryId,
					idempotencyKey: delivery.idempotencyKey,
					eventUuid: delivery.eventUuid,
					issue: ref,
					sender: delivery.payload.user,
					title: delivery.payload.issue.title,
					note: { id: note.id, body: note.note, url: note.url },
				},
			});
			return;
		}

		if (note.noteable_type === 'MergeRequest' && isMergeRequest(delivery.payload.merge_request)) {
			const ref = {
				type: 'merge-request' as const,
				instance,
				projectId,
				iid: delivery.payload.merge_request.iid,
			};
			await dispatch(assistant, {
				id: channel.conversationKey(ref),
				input: {
					type: 'gitlab.merge_request_note.created',
					deliveryId: delivery.deliveryId,
					idempotencyKey: delivery.idempotencyKey,
					eventUuid: delivery.eventUuid,
					mergeRequest: ref,
					sender: delivery.payload.user,
					title: delivery.payload.merge_request.title,
					note: { id: note.id, body: note.note, url: note.url },
				},
			});
		}
	},
});

type GitLabNotePayload = GitLabWebhookPayload & {
	object_kind: 'note';
	project_id?: unknown;
	project?: unknown;
	user?: unknown;
	object_attributes: {
		id: number;
		note: string;
		noteable_type: string;
		action?: string;
		system?: boolean;
		url?: string;
	};
	issue?: unknown;
	merge_request?: unknown;
};

function isNoteEvent(payload: GitLabWebhookPayload): payload is GitLabNotePayload {
	if (payload.object_kind !== 'note' || !isRecord(payload.object_attributes)) return false;
	const note = payload.object_attributes;
	return (
		typeof note.id === 'number' &&
		typeof note.note === 'string' &&
		typeof note.noteable_type === 'string'
	);
}

function projectIdFrom(payload: GitLabNotePayload): number | undefined {
	const payloadProjectId = payload.project_id;
	if (
		typeof payloadProjectId === 'number' &&
		Number.isSafeInteger(payloadProjectId) &&
		payloadProjectId > 0
	)
		return payloadProjectId;
	if (isRecord(payload.project)) {
		const projectId = payload.project.id;
		if (typeof projectId === 'number' && Number.isSafeInteger(projectId) && projectId > 0)
			return projectId;
	}
	return undefined;
}

function isIssue(value: unknown): value is { iid: number; title?: string } {
	if (!isRecord(value)) return false;
	const iid = value.iid;
	return typeof iid === 'number' && Number.isSafeInteger(iid) && iid > 0;
}

function isMergeRequest(value: unknown): value is { iid: number; title?: string } {
	if (!isRecord(value)) return false;
	const iid = value.iid;
	return typeof iid === 'number' && Number.isSafeInteger(iid) && iid > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function postNote(ref: GitLabConversationRef) {
	return defineTool({
		name: 'post_gitlab_note',
		description: 'Post a note to the GitLab issue or merge request bound to this agent.',
		parameters: {
			type: 'object',
			properties: {
				body: { type: 'string', minLength: 1 },
			},
			required: ['body'],
			additionalProperties: false,
		},
		async execute({ body }) {
			const result =
				ref.type === 'issue'
					? await client.createIssueNote({ projectId: ref.projectId, iid: ref.iid, body })
					: await client.createMergeRequestNote({ projectId: ref.projectId, iid: ref.iid, body });
			return JSON.stringify({ noteId: result.id, url: result.web_url });
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

function optionalEnv(name: string): string | undefined {
	return process.env[name] || undefined;
}
