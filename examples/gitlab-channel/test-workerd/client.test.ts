import { describe, expect, it, vi } from 'vitest';
import { GitLabClient } from '../src/gitlab-client.ts';

describe('GitLabClient', () => {
	it('creates issue and merge request notes through Fetch in workerd', async () => {
		const fetch = vi.fn(async () =>
			Response.json({ id: 4401, web_url: 'https://gitlab.example/note/4401' }),
		);
		const client = new GitLabClient({
			instance: 'https://gitlab.example/',
			token: 'gitlab-test-token',
			fetch,
		});

		const issue = await client.createIssueNote({
			projectId: 12,
			iid: 34,
			body: 'Checked from a Worker.',
		});
		const mergeRequest = await client.createMergeRequestNote({
			projectId: 12,
			iid: 7,
			body: 'Reviewed from a Worker.',
		});

		expect(issue).toEqual({ id: 4401, web_url: 'https://gitlab.example/note/4401' });
		expect(mergeRequest.id).toBe(4401);
		expect(fetch).toHaveBeenCalledTimes(2);
		const [issueUrl, issueInit] = fetch.mock.calls[0] ?? [];
		const [mergeRequestUrl, mergeRequestInit] = fetch.mock.calls[1] ?? [];
		expect(String(issueUrl)).toBe('https://gitlab.example/api/v4/projects/12/issues/34/notes');
		expect(String(mergeRequestUrl)).toBe(
			'https://gitlab.example/api/v4/projects/12/merge_requests/7/notes',
		);
		expect(issueInit?.method).toBe('POST');
		expect(new Headers(issueInit?.headers).get('private-token')).toBe('gitlab-test-token');
		expect(JSON.parse(String(issueInit?.body))).toEqual({ body: 'Checked from a Worker.' });
		expect(JSON.parse(String(mergeRequestInit?.body))).toEqual({ body: 'Reviewed from a Worker.' });
	});
});
