export type { CloudflareAIBinding, CloudflareAIBindingRegistration } from './cloudflare/index.ts';
export type { FlueEventSubscriber } from './runtime/events.ts';
export type { HttpProviderRegistration, ProviderConfiguration, ProviderRegistration } from './runtime/providers.ts';
export type { Fetchable } from './routing.ts';

function migrationError(helper: string, entrypoint: '@flue/runtime' | '@flue/runtime/routing'): never {
	throw new Error(`[flue] ${helper}() is no longer available from "@flue/runtime/app". Import it from "${entrypoint}" instead.`);
}

export const admin: typeof import('./routing.ts').admin = () => migrationError('admin', '@flue/runtime/routing');
export const flue: typeof import('./routing.ts').flue = () => migrationError('flue', '@flue/runtime/routing');
export const configureProvider: typeof import('./index.ts').configureProvider = () => migrationError('configureProvider', '@flue/runtime');
export const registerApiProvider: typeof import('./index.ts').registerApiProvider = () => migrationError('registerApiProvider', '@flue/runtime');
export const registerProvider: typeof import('./index.ts').registerProvider = () => migrationError('registerProvider', '@flue/runtime');
export const observe: typeof import('./runtime/events.ts').observe = () => {
	throw new Error('[flue] observe() is no longer available from "@flue/runtime/app". Import it from "@flue/runtime" instead.');
};
