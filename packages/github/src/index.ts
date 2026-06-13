import type { Context, Env, Handler } from 'hono';
import { InvalidGitHubConversationKeyError, InvalidGitHubInputError } from './errors.ts';
import { createGitHubWebhookHandler } from './webhook.ts';

export { InvalidGitHubConversationKeyError, InvalidGitHubInputError } from './errors.ts';

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

/** Ingress configuration for one fixed GitHub webhook. */
export interface GitHubChannelOptions<E extends Env = Env> {
	/** Secret configured on the GitHub webhook. */
	webhookSecret: string;
	/** Maximum request-body size in bytes. Defaults to 25 MiB. */
	bodyLimit?: number;
	/** Receives every verified non-ping GitHub delivery. */
	webhook(input: GitHubWebhookHandlerInput<E>): GitHubWebhookHandlerResult;
}

/** Canonical issue or pull-request destination. Pull requests use their issue number. */
export interface GitHubIssueRef {
	owner: string;
	repo: string;
	issueNumber: number;
}

export interface GitHubRepositoryRef {
	id: number;
	owner: string;
	name: string;
}

export interface GitHubIssuesOpenedPayload {
	issue: { number: number; title: string; body: string | null };
}

export interface GitHubIssueCommentCreatedPayload {
	issue: { number: number };
	comment: { id: number; body: string };
}

export interface GitHubPullRequestOpenedPayload {
	pullRequest: { number: number; title: string; body: string | null };
}

export interface GitHubWebhookEvent<TType extends string, TPayload> {
	type: TType;
	/** GitHub delivery id. Replays and manual redeliveries retain this value. */
	deliveryId: string;
	hookId?: string;
	installationTarget?: {
		id: string;
		type: string;
	};
	installationId?: number;
	repository: GitHubRepositoryRef;
	payload: TPayload;
	/** Parsed provider payload. Treat this as untrusted provider data. */
	raw: unknown;
}

export interface GitHubUnknownEvent {
	type: 'unknown';
	/** Original `X-GitHub-Event` value. */
	event: string;
	/** Provider action when present. */
	action?: string;
	deliveryId: string;
	hookId?: string;
	installationTarget?: {
		id: string;
		type: string;
	};
	installationId?: number;
	/** Parsed provider payload. Treat this as untrusted provider data. */
	raw: unknown;
}

export interface GitHubEvents {
	'issues.opened': GitHubWebhookEvent<'issues.opened', GitHubIssuesOpenedPayload>;
	'issue_comment.created': GitHubWebhookEvent<
		'issue_comment.created',
		GitHubIssueCommentCreatedPayload
	>;
	'pull_request.opened': GitHubWebhookEvent<'pull_request.opened', GitHubPullRequestOpenedPayload>;
}

export type GitHubEvent = GitHubEvents[keyof GitHubEvents] | GitHubUnknownEvent;

export interface GitHubWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	event: GitHubEvent;
}

type GitHubWebhookHandlerValue = undefined | JsonValue | Response;

export type GitHubWebhookHandlerResult =
	| GitHubWebhookHandlerValue
	| Promise<GitHubWebhookHandlerValue>;

/** Verified ingress and canonical identity helpers. */
export interface GitHubChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
	/** Serializes a canonical namespaced identifier. It is not an authorization capability. */
	conversationKey(ref: GitHubIssueRef): string;
	/** Parses only canonical keys produced by `conversationKey()`. */
	parseConversationKey(id: string): GitHubIssueRef;
}

/**
 * Creates a fixed-webhook GitHub channel.
 *
 * Successful acknowledgement waits for the configured handler to finish. The
 * channel is stateless and does not deduplicate delivery ids.
 */
export function createGitHubChannel<E extends Env = Env>(
	options: GitHubChannelOptions<E>,
): GitHubChannel<E> {
	validateOptions(options);
	const webhookSecret = options.webhookSecret;
	const webhook = options.webhook;
	const webhookHandler = createGitHubWebhookHandler<E>({
		webhookSecret,
		bodyLimit: options.bodyLimit,
		webhook,
	});

	const channel: GitHubChannel<E> = {
		routes: [{ method: 'POST', path: '/webhook', handler: webhookHandler }],
		conversationKey(ref) {
			assertIssueRef(ref);
			return `github:v1:owner:${encodeURIComponent(ref.owner)}:repo:${encodeURIComponent(ref.repo)}:issue:${ref.issueNumber}`;
		},
		parseConversationKey(id) {
			try {
				const match = /^github:v1:owner:([^:]+):repo:([^:]+):issue:([1-9]\d*)$/.exec(id);
				const owner = match?.[1];
				const repo = match?.[2];
				const issueNumberText = match?.[3];
				if (!owner || !repo || !issueNumberText) throw new InvalidGitHubConversationKeyError();
				const ref = {
					owner: decodeURIComponent(owner),
					repo: decodeURIComponent(repo),
					issueNumber: Number(issueNumberText),
				};
				assertIssueRef(ref);
				if (channel.conversationKey(ref) !== id) throw new InvalidGitHubConversationKeyError();
				return ref;
			} catch (error) {
				if (error instanceof InvalidGitHubConversationKeyError) throw error;
				throw new InvalidGitHubConversationKeyError();
			}
		},
	};

	return channel;
}

function validateOptions<E extends Env>(options: GitHubChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createGitHubChannel() requires an options object.');
	}
	if (typeof options.webhookSecret !== 'string' || options.webhookSecret.length === 0) {
		throw new TypeError('createGitHubChannel() requires a non-empty webhookSecret.');
	}
	if (typeof options.webhook !== 'function') {
		throw new TypeError('createGitHubChannel() requires a webhook handler.');
	}
}

function assertIssueRef(ref: GitHubIssueRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidGitHubInputError('ref');
	assertPathSegment(ref.owner, 'owner');
	assertPathSegment(ref.repo, 'repo');
	if (!Number.isSafeInteger(ref.issueNumber) || ref.issueNumber <= 0) {
		throw new InvalidGitHubInputError('issueNumber');
	}
}

function assertPathSegment(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new InvalidGitHubInputError(field);
	}
}
