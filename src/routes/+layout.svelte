<script lang="ts">
	import '$lib/ui.css';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';
	import ShareMenu from '$lib/ShareMenu.svelte';

	let { data, children } = $props();
	// 읽기 전용(공유 링크로 들어온) 방문자는 올리기·링크 만들기를 보지 못한다
	const guest = $derived(data.session?.role === 'guest');
	// SSR 중에는 base 가 './' 같은 상대 경로라 href 로 현재 페이지를 판정할 수 없다.
	// 그래서 base 와 무관한 path 로 판정한다(pathname 은 /ymath/upload 처럼 base 를 포함하므로 endsWith 로 비교).
	const allLinks = [
		{ path: '/upload', icon: '📷', label: '업로드' },
		{ path: '/items', icon: '📋', label: '문제별' },
		{ path: '/areas', icon: '📊', label: '영역별' }
	];
	const links = $derived(guest ? allLinks.filter((l) => l.path !== '/upload') : allLinks);
	const isActive = (path: string) => page.url.pathname.replace(/\/$/, '').endsWith(path);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>오답노트</title>
</svelte:head>

<!-- 로그인 화면(세션 없음)에는 메뉴를 보이지 않는다 -->
{#if data.session}
	<nav>
		<div class="nav-inner">
			{#each links as l (l.path)}
				<a href="{base}{l.path}" class:active={isActive(l.path)}>
					<span class="tab-label">
						<span class="tab-icon">{l.icon}</span>
						<span>{l.label}</span>
					</span>
				</a>
			{/each}
			<div class="tools">
				<a
					href="{base}/status"
					class="status-btn"
					class:active={isActive('/status')}
					aria-label="작업 상태"
					title="작업 상태"
				>
					⚡
				</a>
				{#if !guest}
					<ShareMenu canLogout={data.session.via === 'cookie'} />
				{/if}
			</div>
		</div>
	</nav>
{/if}

<main>
	{@render children()}
</main>

<style>
	:global(:root) {
		--bg: #f6f7f9;
		--surface: #ffffff;
		--text: #1c2330;
		--muted: #667085;
		--line: #dfe3ea;
		--accent: #2f5bea;
		--accent-soft: #e8edff;
		--ok: #12805c;
		--ok-soft: #dff5ec;
		--warn: #a15c00;
		--warn-soft: #fff1d6;
		--bad: #c0322b;
		--bad-soft: #fde6e4;
		--radius: 14px;
		color-scheme: light dark;
	}
	@media (prefers-color-scheme: dark) {
		:global(:root) {
			--bg: #12151b;
			--surface: #1b2029;
			--text: #e8ecf3;
			--muted: #9aa4b5;
			--line: #2d3442;
			--accent: #7c9bff;
			--accent-soft: #24304f;
			--ok: #55d6a4;
			--ok-soft: #173a2e;
			--warn: #f0b95a;
			--warn-soft: #3c2e12;
			--bad: #ff8a80;
			--bad-soft: #43201d;
		}
	}
	/*
	 * 인쇄는 화면 테마와 상관없이 항상 밝은 팔레트를 쓴다. 어두운 테마의 색(밝은 글자, 어두운 박스 배경)이 그대로 종이에 나가면
	 * 읽을 수 없다. 반드시 어두운 테마 규칙 뒤에 두어야 이긴다.
	 */
	@media print {
		:global(:root) {
			--bg: #ffffff;
			--surface: #ffffff;
			--text: #111111;
			--muted: #555555;
			--line: #c9ccd3;
			--accent: #1d3fbf;
			--accent-soft: #eef2ff;
			--ok: #12805c;
			--ok-soft: #dff5ec;
			--warn: #a15c00;
			--warn-soft: #fff1d6;
			--bad: #c0322b;
			--bad-soft: #fde6e4;
			color-scheme: light;
		}
	}
	:global(body) {
		margin: 0;
		background: var(--bg);
		color: var(--text);
		font-family:
			system-ui,
			-apple-system,
			'Noto Sans KR',
			'Apple SD Gothic Neo',
			sans-serif;
		line-height: 1.5;
		-webkit-text-size-adjust: 100%;
	}
	:global(*) {
		box-sizing: border-box;
	}
	nav {
		background: var(--surface);
		border-bottom: 1px solid var(--line);
		position: sticky;
		top: 0;
		z-index: 5;
	}
	.nav-inner {
		max-width: 960px;
		margin: 0 auto;
		padding: 0 16px;
		display: flex;
		align-items: stretch;
		width: 100%;
	}
	@media (min-width: 720px) {
		nav a:first-child {
			padding-left: 0;
		}
	}
	nav a {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 16px;
		height: 52px;
		text-decoration: none;
		color: var(--muted);
		font-weight: 700;
		font-size: 1rem;
		white-space: nowrap;
		flex-shrink: 0;
		position: relative;
		transition: color 0.15s;
	}
	nav a:hover {
		color: var(--text);
	}
	nav a.active {
		color: var(--accent);
	}
	.tab-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 100%;
		position: relative;
	}
	.tab-icon {
		display: inline-flex;
		align-items: center;
		line-height: 1;
	}
	nav a.active .tab-label::after {
		content: '';
		position: absolute;
		bottom: -1px;
		left: 0;
		right: 0;
		height: 3px;
		background: var(--accent);
		border-radius: 3px 3px 0 0;
	}
	.tools {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}
	@media (max-width: 480px) {
		.nav-inner {
			padding: 0 10px;
		}
		nav a {
			padding: 0 10px;
			font-size: 0.95rem;
			height: 48px;
		}
	}
	.status-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		padding: 0;
		font-size: 1.1rem;
		border-radius: 50%;
		border: 1px solid var(--line);
		background: var(--surface);
		transition: background 0.15s, border-color 0.15s;
	}
	.status-btn:hover {
		border-color: var(--muted);
	}
	.status-btn.active {
		background: var(--accent-soft);
		border-color: var(--accent);
	}
	main {
		max-width: 960px;
		margin: 0 auto;
		padding: 16px;
	}
</style>
