import { completeSimple, registerApiProvider } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { registerProvider } from '../src/index.ts';
import { getCloudflareAIBindingApiProvider } from '../src/cloudflare/workers-ai-provider.ts';
import { resolveModel } from '../src/internal.ts';

describe('Workers AI binding reasoning effort', () => {
	it('forwards supported reasoning effort tiers for reasoning models only', async () => {
		const payloads: Record<string, unknown>[] = [];
		const provider = `cloudflare-reasoning-${crypto.randomUUID()}`;
		registerApiProvider(getCloudflareAIBindingApiProvider());
		registerProvider(provider, {
			api: 'cloudflare-ai-binding',
			binding: {
				run: async (_model, inputs) => {
					payloads.push(inputs);
					return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
				},
			},
		});

		const reasoningModel = resolveModel(`${provider}/@cf/zai-org/glm-4.7-flash`);
		const ordinaryModel = resolveModel(`${provider}/@cf/meta/llama-4-scout-17b-16e-instruct`);
		expect(reasoningModel).toBeDefined();
		expect(ordinaryModel).toBeDefined();
		if (!reasoningModel || !ordinaryModel) throw new Error('Expected resolved Workers AI models.');

		for (const [reasoning, expected] of [
			['minimal', 'low'],
			['medium', 'medium'],
			['xhigh', 'high'],
		] as const) {
			await completeSimple(reasoningModel, { messages: [] }, { reasoning });
			expect(payloads.at(-1)?.reasoning_effort).toBe(expected);
		}

		await completeSimple(ordinaryModel, { messages: [] }, { reasoning: 'high' });
		expect(payloads.at(-1)).not.toHaveProperty('reasoning_effort');
	});
});
