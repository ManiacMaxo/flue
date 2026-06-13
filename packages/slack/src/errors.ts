export class DuplicateSlackHandlerError extends Error {
	readonly kind: 'event' | 'action' | 'view';
	readonly key: string;

	constructor(kind: 'event' | 'action' | 'view', key: string) {
		super(`A Slack ${kind} handler is already registered for "${key}".`);
		this.name = 'DuplicateSlackHandlerError';
		this.kind = kind;
		this.key = key;
	}
}

export class InvalidSlackConversationKeyError extends Error {
	constructor() {
		super('Invalid Slack conversation key.');
		this.name = 'InvalidSlackConversationKeyError';
	}
}

export class InvalidSlackInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid Slack ${field}.`);
		this.name = 'InvalidSlackInputError';
		this.field = field;
	}
}

export interface SlackApiErrorOptions {
	status: number;
	code: string;
	requestId?: string;
	responseMessage?: string;
	retryAfterSeconds?: number;
}

export class SlackApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly requestId?: string;
	readonly responseMessage?: string;
	readonly retryAfterSeconds?: number;

	constructor(options: SlackApiErrorOptions) {
		super(`Slack API request failed: ${options.code}.`);
		this.name = 'SlackApiError';
		this.status = options.status;
		this.code = options.code;
		this.requestId = options.requestId;
		this.responseMessage = options.responseMessage;
		this.retryAfterSeconds = options.retryAfterSeconds;
	}
}

export class SlackRateLimitError extends SlackApiError {
	constructor(options: SlackApiErrorOptions) {
		super(options);
		this.name = 'SlackRateLimitError';
	}
}

export class SlackTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Slack API request timed out after ${timeoutMs}ms.`);
		this.name = 'SlackTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}
