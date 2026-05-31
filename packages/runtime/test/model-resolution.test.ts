import { describe, expect, it } from 'vitest';
import { configureProvider, registerProvider } from '../src/index.ts';
import { resolveModel } from '../src/internal.ts';

describe('model provider identity', () => {
	it('uses registered provider IDs for resolved model identity and settings', () => {
		registerProvider('registered-test', {
			api: 'openai-completions',
			baseUrl: 'https://before.invalid',
		});
		configureProvider('registered-test', { baseUrl: 'https://after.invalid' });

		expect(resolveModel('registered-test/model-id')).toMatchObject({
			id: 'model-id',
			provider: 'registered-test',
			baseUrl: 'https://after.invalid',
		});
	});

	it('keys provider settings by registered provider ID only', () => {
		registerProvider('settings-id-test', {
			api: 'openai-completions',
			baseUrl: 'https://before.invalid',
		});
		configureProvider('unrelated-provider', { baseUrl: 'https://ignored.invalid' });

		expect(resolveModel('settings-id-test/model-id')).toMatchObject({
			provider: 'settings-id-test',
			baseUrl: 'https://before.invalid',
		});
	});

	it('uses the binding provider ID instead of a transport-specific identity', () => {
		registerProvider('cloudflare-binding-test', {
			api: 'cloudflare-ai-binding',
			binding: { run: async () => new Response() },
		});

		expect(resolveModel('cloudflare-binding-test/@cf/example/model')).toMatchObject({
			id: '@cf/example/model',
			provider: 'cloudflare-binding-test',
			api: 'cloudflare-ai-binding',
		});
	});
});
