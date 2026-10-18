// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { Session } from '$lib/types';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
		session: Session;
		}
		interface Platform {
			env: import('$lib/server/cloudflare/runtime').CloudflareEnv;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
