import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// 빌드 결과는 숨김 폴더로 둬서 프로젝트 루트를 어지럽히지 않는다(실행: node .build)
			adapter: adapter({ out: '.build' }),
			// 루트에서 서빙한다. BASE_PATH 를 주면 하위 경로로 빌드 가능(빌드 시점 고정)
			paths: { base: (process.env.BASE_PATH ?? '') as '' | `/${string}` },
			// OWASP ASVS V3.4.3: CSP 는 SvelteKit 이 페이지 응답에 설정한다(hash 모드가 인라인 부트스트랩
			// 스크립트에 sha256 을 첨부하므로 script-src 에 'unsafe-inline' 이 필요 없다).
			// script-src 'unsafe-inline' 제거는 hooks.server.ts 의 fallback Csp 와 함께 동작한다.
			csp: {
				mode: 'hash',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					// KaTeX는 수식 요소에 인라인 style 속성을 쓰고 app.html 도 style="display: contents" 를 쓴다
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:', 'blob:'],
					'font-src': ['self', 'data:'],
					'connect-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['none'],
					'frame-ancestors': ['none'],
					'form-action': ['self']
				}
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
