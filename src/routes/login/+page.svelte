<script lang="ts">
	import { base } from '$app/paths';
	import { AJAX_HEADER, AJAX_VALUE } from '$lib/ajax';

	let { data } = $props();
	let password = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!password || busy) return;
		busy = true;
		error = null;
		try {
			// 폼 전송 대신 fetch 로 보낸다: 커스텀 헤더가 다른 사이트의 위조 요청을 막고, http 접속에서도 동작한다
			const res = await fetch(`${base}/api/login`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [AJAX_HEADER]: AJAX_VALUE },
				body: JSON.stringify({ password, next: data.next })
			});
			const body = (await res.json().catch(() => null)) as { message?: string; next?: string } | null;
			if (!res.ok) throw new Error(body?.message ?? `로그인 실패(${res.status})`);
			// 쿠키가 적용된 새 요청으로 들어가도록 전체 이동한다
			location.assign(body?.next ?? `${base}/upload`);
		} catch (err) {
			error = err instanceof Error ? err.message : '로그인에 실패했어요';
			password = '';
			busy = false;
		}
	}
</script>

<svelte:head><title>로그인 · 오답노트</title></svelte:head>

<form class="login" onsubmit={submit}>
	<h1>🔒 오답노트</h1>

	{#if !data.configured}
		<p class="alert">서버에 <code>PASSWORD</code> 가 설정되어 있지 않아 밖에서는 들어올 수 없어요.</p>
	{/if}

	<input
		type="password"
		name="password"
		autocomplete="current-password"
		placeholder="비밀번호"
		aria-label="비밀번호"
		bind:value={password}
		disabled={busy || !data.configured}
	/>
	{#if error}<p class="alert" role="alert">{error}</p>{/if}
	<button type="submit" disabled={busy || !password || !data.configured}>{busy ? '확인 중…' : '들어가기'}</button>
</form>

<style>
	.login {
		max-width: 360px;
		margin: 12vh auto 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	h1 {
		margin: 0;
		font-size: 1.4rem;
	}

	input {
		padding: 12px 14px;
		font-size: 1rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
	}
	input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	button {
		padding: 12px 14px;
		font-size: 1rem;
		font-weight: 700;
		border: 0;
		border-radius: var(--radius);
		background: var(--accent);
		color: #fff;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.alert {
		margin: 0;
		padding: 10px 12px;
		border-radius: 10px;
		background: var(--bad-soft);
		color: var(--bad);
		font-size: 0.9rem;
	}
</style>
