<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { base } from '$app/paths';
	import { onMount } from 'svelte';
	import { AJAX_HEADER, AJAX_VALUE } from '$lib/ajax';
	import { STATUS_LABEL, STATUS_TONE, hasActive } from '$lib/status';
	import { formatTime } from '$lib/time';
	import type { Workbook } from '$lib/types';

	let { data } = $props();

	const STORAGE_KEY = 'ymath.lastWorkbook';
	let selectedId = $state<string | null>(null);
	let useCamera = $state(true);
	let uploading = $state(false);
	let message = $state<{ kind: 'ok' | 'bad'; text: string } | null>(null);
	let camera: HTMLInputElement;
	let album: HTMLInputElement;

	const selected = $derived(data.workbooks.find((w) => w.id === selectedId) ?? null);

	// 학년별로 묶는다(목록은 서버에서 이미 정렬되어 있다)
	const groups = $derived(
		data.workbooks.reduce<{ grade: string; items: Workbook[] }[]>((acc, w) => {
			const last = acc.at(-1);
			if (last && last.grade === w.grade) last.items.push(w);
			else acc.push({ grade: w.grade, items: [w] });
			return acc;
		}, [])
	);

	onMount(() => {
		// 마지막에 쓴 문제집을 기억해 같은 책을 연속으로 찍기 쉽게 한다. 저장소를 못 쓰는 환경이어도 동작해야 한다.
		try {
			const saved = localStorage.getItem(STORAGE_KEY);
			if (saved && data.workbooks.some((w) => w.id === saved)) selectedId = saved;
		} catch {
			/* 무시 */
		}
	});

	// 진행 중인 항목이 있으면 3초마다 상태를 새로 읽는다
	$effect(() => {
		if (!hasActive(data.recent)) return;
		const t = setInterval(() => invalidate('app:recent'), 3000);
		return () => clearInterval(t);
	});

	function pick(w: Workbook) {
		selectedId = w.id;
		try {
			localStorage.setItem(STORAGE_KEY, w.id);
		} catch {
			/* 무시 */
		}
		message = null;
		if (useCamera) {
			camera.click(); // [v] 카메라 체크 시: 탭 이벤트 안에서 즉시 카메라 실행
		} else {
			album.click(); // 체크 해제 시: 갤러리/파일 등 원하는 동작 선택 창
		}
	}

	async function onFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // 같은 파일/같은 동작을 다시 해도 change 가 발생하도록
		if (!file || !selected) return;

		uploading = true;
		message = null;
		try {
			// 사진 원본 바이트를 그대로 보낸다(서버는 image/* 본문만 받는다). 커스텀 헤더는 다른 사이트의 위조 요청을 막는다.
			const res = await fetch(`${base}/api/upload?workbookId=${encodeURIComponent(selected.id)}`, {
				method: 'POST',
				headers: { 'content-type': file.type || 'application/octet-stream', [AJAX_HEADER]: AJAX_VALUE },
				body: file
			});
			if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? `업로드 실패(${res.status})`);
			message = { kind: 'ok', text: `${selected.name} 접수했어요. 분석은 알아서 진행돼요.` };
			await invalidate('app:recent');
		} catch (err) {
			message = { kind: 'bad', text: err instanceof Error ? err.message : '업로드에 실패했어요' };
		} finally {
			uploading = false;
		}
	}

	const time = formatTime;
</script>

<input bind:this={camera} type="file" accept="image/*" capture="environment" hidden onchange={onFile} />
<input bind:this={album} type="file" accept="image/*" hidden onchange={onFile} />

{#each groups as g, i (g.grade)}
	<section>
		<div class="grade-header">
			<h2>{g.grade}</h2>
			{#if i === 0}
				<label class="cam-toggle" title="카메라 바로 열기">
					<input type="checkbox" bind:checked={useCamera} />
					<span>📷</span>
				</label>
			{/if}
		</div>
		<div class="grid">
			{#each g.items as w (w.id)}
				<button class="wb" class:selected={w.id === selectedId} disabled={uploading} onclick={() => pick(w)}>
					{w.name}
				</button>
			{/each}
		</div>
	</section>
{/each}

{#if uploading}
	<p class="msg" role="status">올리는 중…</p>
{:else if message}
	<p class="msg {message.kind}" role="status">{message.text}</p>
{/if}

{#if data.recent.length}
	<section class="recent">
		<h2>최근 올린 것</h2>
		<div class="recent-grid">
			{#each data.recent as r (r.id)}
				<a class="row" href="{base}/items?id={r.id}">
					<img src="{base}/api/items/{r.id}/image" alt="" loading="lazy" />
					<span class="info">
						<strong>{r.workbook}</strong>
						<small>{time(r.created_at)}{r.asks ? ` · ${r.asks}` : ''}</small>
					</span>
					<span class="badge {STATUS_TONE[r.status]}">{STATUS_LABEL[r.status]}</span>
				</a>
			{/each}
		</div>
	</section>
{/if}

<style>
	.grade-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin: 20px 0 8px;
	}
	section:first-of-type .grade-header {
		margin-top: 4px;
	}
	h2 {
		font-size: 0.95rem;
		color: var(--muted);
		margin: 0;
	}
	.recent h2 {
		margin: 20px 0 8px;
	}
	.cam-toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--muted);
		cursor: pointer;
		user-select: none;
	}
	.cam-toggle span {
		font-size: 1.15rem;
		line-height: 1;
	}
	.cam-toggle input {
		width: 16px;
		height: 16px;
		margin: 0;
		accent-color: var(--accent);
		cursor: pointer;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 12px;
	}
	.wb {
		min-height: 64px;
		padding: 10px 12px;
		font-size: 1.1rem;
		font-weight: 700;
		line-height: 1.3;
		color: var(--text);
		background: var(--surface);
		border: 2px solid var(--line);
		border-radius: var(--radius);
		cursor: pointer;
		touch-action: manipulation;
	}
	.wb:active {
		transform: scale(0.98);
	}
	.wb.selected {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
	}
	.wb:disabled {
		opacity: 0.55;
	}
	.msg {
		margin: 16px 0 0;
		padding: 12px 14px;
		border-radius: 10px;
		background: var(--accent-soft);
		font-weight: 600;
	}
	.msg.ok {
		background: var(--ok-soft);
		color: var(--ok);
	}
	.msg.bad {
		background: var(--bad-soft);
		color: var(--bad);
	}
	.recent-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 10px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 12px;
		text-decoration: none;
		color: inherit;
		min-width: 0;
	}
	.row img {
		width: 44px;
		height: 44px;
		object-fit: cover;
		border-radius: 8px;
		background: var(--line);
		flex-shrink: 0;
	}
	.info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.info strong {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 0.95rem;
	}
	.info small {
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 0.8rem;
	}
	.badge {
		font-size: 0.78rem;
		font-weight: 700;
		padding: 3px 9px;
		border-radius: 999px;
		white-space: nowrap;
		background: var(--line);
		color: var(--muted);
	}
	.badge.accent {
		background: var(--accent-soft);
		color: var(--accent);
	}
	.badge.ok {
		background: var(--ok-soft);
		color: var(--ok);
	}
	.badge.bad {
		background: var(--bad-soft);
		color: var(--bad);
	}
</style>
