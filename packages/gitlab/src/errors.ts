export class InvalidGitLabConversationKeyError extends Error {
	constructor() {
		super('Invalid GitLab conversation key.');
		this.name = 'InvalidGitLabConversationKeyError';
	}
}

export class InvalidGitLabInputError extends TypeError {
	readonly field: string;

	constructor(field: string) {
		super(`Invalid GitLab ${field}.`);
		this.name = 'InvalidGitLabInputError';
		this.field = field;
	}
}
