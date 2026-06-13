import { WebClient } from '@slack/web-api';
import { describe, expect, it, vi } from 'vitest';

describe('Slack WebClient', () => {
	it('calls chat.postMessage when executed in workerd', async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				ok: true,
				channel: 'C123',
				ts: '1710000000.000001',
				message: { text: 'hello' },
			}),
		);
		vi.stubGlobal('fetch', fetch);

		try {
			const client = new WebClient('xoxb-test');
			const result = await client.chat.postMessage({
				channel: 'C123',
				thread_ts: '1710000000.000000',
				text: 'hello',
			});

			expect(result.ok).toBe(true);
			expect(result.channel).toBe('C123');
			expect(fetch).toHaveBeenCalledOnce();
			const [url, init] = fetch.mock.calls[0] ?? [];
			expect(String(url)).toBe('https://slack.com/api/chat.postMessage');
			expect(init?.method).toBe('POST');
			expect(new Headers(init?.headers).get('authorization')).toBe('Bearer xoxb-test');
			expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toMatchObject({
				channel: 'C123',
				thread_ts: '1710000000.000000',
				text: 'hello',
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
