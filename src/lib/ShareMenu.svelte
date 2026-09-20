<script lang="ts">
	import { base } from '$app/paths';
	import { AJAX_HEADER, AJAX_VALUE } from '$lib/ajax';
	import { formatTime } from '$lib/time';

	/** 쿠키로 로그인한 경우에만 로그아웃을 보여 준다(내부망은 로그인 상태가 없다) */
	let { canLogout }: { canLogout: boolean } = $props();

	let open = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let link = $state<{ url: string; expiresAt: string; publicUrlConfigured: boolean } | null>(null);
	let copied = $state(false);
	let copyFailed = $state(false);
	let field = $state<HTMLInputElement>();
	let root = $state<HTMLElement>();

	async function call(path: string) {
		const res = await fetch(`${base}${path}`, { method: 'POST', headers: { [AJAX_HEADER]: AJAX_VALUE } });
		const body = (await res.json().catch(() => null)) as Record<string, any> | null;
		if (!res.ok) throw new Error(body?.message ?? `요청 실패(${res.status})`);
		return body!;
	}

	async function create() {
		busy = true;
		error = null;
		copied = false;
		copyFailed = false;
		try {
			const b = await call('/api/share');
			link = { url: b.url, expiresAt: b.expires_at, publicUrlConfigured: b.public_url_configured };
		} catch (e) {
			error = e instanceof Error ? e.message : '링크를 만들지 못했어요';
		} finally {
			busy = false;
		}
	}

	async function copy() {
		if (!link) return;
		copyFailed = false;
		try {
			await navigator.clipboard.writeText(link.url);
			copied = true;
			return;
		} catch {
			// http(내부망) 접속에서는 Clipboard API 가 없거나 막혀 있다. 아래 방식으로 다시 시도한다
		}
		field?.focus();
		field?.select();
		field?.setSelectionRange(0, link.url.length); // iOS 는 select() 만으로는 선택되지 않는다
		try {
			copied = document.execCommand('copy');
		} catch {
			copied = false;
		}
		copyFailed = !copied;
	}

	async function logout() {
		busy = true;
		try {
			await call('/api/logout');
			location.assign(`${base}/login`);
		} catch (e) {
			error = e instanceof Error ? e.message : '로그아웃하지 못했어요';
			busy = false;
		}
	}

	function onWindowClick(e: MouseEvent) {
		if (open && root && !root.contains(e.target as Node)) open = false;
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={(e) => e.key === 'Escape' && (open = false)} />

<div class="share" bind:this={root}>
	<button
		type="button"
		class="icon-btn"
		class:active={open}
		aria-label="공유 링크"
		aria-haspopup="true"
		aria-expanded={open}
		title="공유 링크"
		onclick={() => (open = !open)}
	>
		🔗
	</button>

	{#if open}
		<div class="panel" role="dialog" aria-label="공유 링크">
			<strong>읽기전용 임시링크</strong>
			<p>링크를 만든 시각부터 1시간 동안만 열려요. 보기만 할 수 있고 올리기·삭제·재분석은 안 돼요.</p>

			{#if link}
				<input bind:this={field} readonly value={link.url} aria-label="공유 링크 주소" onfocus={(e) => e.currentTarget.select()} />
				<div class="row">
					<button type="button" class="primary" onclick={copy}>{copied ? '복사했어요 ✓' : '복사'}</button>
					<button type="button" onclick={create} disabled={busy}>새로 만들기</button>
				</div>
				{#if copyFailed}
					<small class="warn">자동 복사가 안 돼요. 위 주소가 선택되어 있으니 직접 복사해 주세요.</small>
				{/if}
				<small>{formatTime(link.expiresAt)}까지 유효</small>
				{#if !link.publicUrlConfigured}
					<small class="warn">서버에 <code>PUBLIC_URL</code> 이 없어 지금 접속한 주소로 만들었어요. 밖에서 열리는 주소인지 확인하세요.</small>
				{/if}
			{:else}
				<button type="button" class="primary" onclick={create} disabled={busy}>{busy ? '만드는 중…' : '1시간 링크 만들기'}</button>
			{/if}

			{#if error}<p class="err" role="alert">{error}</p>{/if}

			{#if canLogout}
				<hr />
				<button type="button" class="ghost" onclick={logout} disabled={busy}>로그아웃</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.share {
		position: relative;
	}
	.icon-btn {
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
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s;
	}
	.icon-btn:hover {
		border-color: var(--muted);
	}
	.icon-btn.active {
		background: var(--accent-soft);
		border-color: var(--accent);
	}
	.panel {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		width: min(320px, calc(100vw - 32px));
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 14px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		box-shadow: 0 8px 28px rgb(0 0 0 / 0.18);
		color: var(--text);
	}
	p {
		margin: 0;
		font-size: 0.85rem;
		color: var(--muted);
	}
	input {
		padding: 9px 10px;
		font-size: 0.85rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--bg);
		color: var(--text);
		width: 100%;
	}
	.row {
		display: flex;
		gap: 8px;
	}
	.panel button:not(.icon-btn) {
		flex: 1;
		padding: 9px 12px;
		font-weight: 700;
		border-radius: 10px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}
	.panel button.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.panel button.ghost {
		color: var(--muted);
		font-weight: 600;
	}
	.panel button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	small {
		color: var(--muted);
	}
	small.warn,
	.err {
		color: var(--warn);
	}
	.err {
		color: var(--bad);
	}
	hr {
		width: 100%;
		border: 0;
		border-top: 1px solid var(--line);
		margin: 4px 0;
	}
</style>
