export interface GitLabClientOptions {
	instance: string;
	token: string;
	fetch?: typeof fetch;
}

export interface CreateNoteInput {
	projectId: number;
	iid: number;
	body: string;
}

export class GitLabClient {
	readonly #instance: string;
	readonly #token: string;
	readonly #fetch: typeof fetch;

	constructor(options: GitLabClientOptions) {
		this.#instance = options.instance.replace(/\/+$/, '');
		this.#token = options.token;
		this.#fetch = options.fetch ?? fetch;
	}

	createIssueNote(input: CreateNoteInput): Promise<{ id: number; web_url?: string }> {
		return this.#createNote(
			`/api/v4/projects/${input.projectId}/issues/${input.iid}/notes`,
			input.body,
		);
	}

	createMergeRequestNote(input: CreateNoteInput): Promise<{ id: number; web_url?: string }> {
		return this.#createNote(
			`/api/v4/projects/${input.projectId}/merge_requests/${input.iid}/notes`,
			input.body,
		);
	}

	async #createNote(path: string, body: string): Promise<{ id: number; web_url?: string }> {
		const response = await this.#fetch(`${this.#instance}${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'private-token': this.#token,
			},
			body: JSON.stringify({ body }),
		});
		if (!response.ok) throw new Error(`GitLab note request failed with ${response.status}.`);
		const json = await response.json();
		if (!isRecord(json) || typeof json.id !== 'number') {
			throw new Error('GitLab note response did not include a numeric id.');
		}
		return {
			id: json.id,
			...(typeof json.web_url === 'string' ? { web_url: json.web_url } : {}),
		};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
