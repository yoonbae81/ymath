<script lang="ts">
	import 'katex/dist/katex.min.css';
	import { goto, invalidate } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { AJAX_HEADER, AJAX_VALUE } from '$lib/ajax';
	import { renderMath, renderMarkdown } from '$lib/math';
	import { formatDate, formatDateTime } from '$lib/time';
	import { problemNumber } from '$lib/report-links';
	import { STATUS_LABEL, STATUS_TONE, hasActive } from '$lib/status';
	import {
		ERROR_TYPES,
		PROVIDERS,
		PROVIDER_LABEL,
		getAvailablePeriods,
		isItemInPeriod,
		type ItemRecord,
		type Provider
	} from '$lib/types';

	let { data } = $props();

	let topic = $state('');
	let workbook = $state('');
	let errorType = $state('');
	// 처음에는 최근 10일만 보여 준다(지난 오답은 기간 선택으로 넓힌다). 상세 링크(?id=)는 기간 필터와 무관하게 열린다
	let period = $state('10d');
	let busy = $state(false);
	let actionError = $state<string | null>(null);
	// 재분석에 쓸 LLM. 고르기 전에는 이 항목의 마지막 선택(없으면 서버 기본값)을 보여 준다
	let providerChoice = $state<Provider | null>(null);
	const chosenProvider = (i: ItemRecord): Provider => providerChoice ?? i.requested_provider ?? data.defaultProvider;

	// 공유 링크로 들어온 방문자는 보기만 한다(원본 사진은 서버 설정에 따라 숨김)
	const readonly = $derived(page.data.session?.role === 'guest');
	const showPhotos = $derived(!readonly || page.data.guestPhotos);

	const openId = $derived(page.url.searchParams.get('id'));
	const open = $derived(data.items.find((i) => i.id === openId) ?? null);

	const availablePeriods = $derived(getAvailablePeriods(data.items));

	const filtered = $derived(
		data.items.filter(
			(i) =>
				(!topic || i.analysis?.classification.topic === topic) &&
				(!workbook || i.workbook.id === workbook) &&
				(!errorType || i.analysis?.error_analysis.error_type === errorType) &&
				isItemInPeriod(i.created_at, period)
		)
	);
	const filtering = $derived(!!(topic || workbook || errorType || period));

	// 진행 중인 항목이 있으면 3초마다 새로 읽는다
	$effect(() => {
		if (!hasActive(data.items)) return;
		const t = setInterval(() => invalidate('app:items'), 3000);
		return () => clearInterval(t);
	});

	function show(id: string | null) {
		actionError = null;
		providerChoice = null;
		const url = new URL(page.url);
		if (id) url.searchParams.set('id', id);
		else url.searchParams.delete('id');
		goto(url, { keepFocus: true, noScroll: true });
	}

	async function call(method: string, path: string, after?: () => void) {
		busy = true;
		actionError = null;
		try {
			const res = await fetch(path, { method, headers: { [AJAX_HEADER]: AJAX_VALUE } });
			if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? `요청 실패(${res.status})`);
			after?.();
			await invalidate('app:items');
		} catch (e) {
			actionError = e instanceof Error ? e.message : '요청에 실패했어요';
		} finally {
			busy = false;
		}
	}

	const retry = (i: ItemRecord) => call('POST', `${base}/api/items/${i.id}/retry?provider=${chosenProvider(i)}`);
	const remove = (i: ItemRecord) => {
		if (confirm(`이 오답(${i.workbook.name})을 삭제할까요? 사진과 분석 결과가 모두 지워져요.`)) call('DELETE', `${base}/api/items/${i.id}`, () => show(null));
	};

	const when = formatDateTime;
	const conceptLabel = (id: string) => (data.concepts[id] ? `${data.concepts[id]}` : id);
	const SEVERITY = { 1: '단순 실수', 2: '절차·기술 미숙', 3: '개념 결손' } as const;

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && openId) {
			show(null);
		}
	}
</script>

<svelte:window onkeydown={onKey} />

{#if data.taxonomyError}
	<p class="alert bad">분류 체계(curriculum.md)에 문제가 있어요: {data.taxonomyError}</p>
{/if}

<div class="filters">
	<div class="chips" role="group" aria-label="영역">
		<button class:on={topic === ''} onclick={() => (topic = '')}>전체</button>
		{#each data.topics as t (t)}
			<button class:on={topic === t} onclick={() => (topic = t)}>{t}</button>
		{/each}
	</div>
	<div class="selects">
		<select bind:value={period} aria-label="분석 기간">
			{#each availablePeriods as p (p.value)}
				<option value={p.value}>{p.label}</option>
			{/each}
		</select>
		<select bind:value={workbook} aria-label="문제집">
			<option value="">모든 문제집</option>
			{#each data.workbooks as w (w.id)}<option value={w.id}>{w.name}</option>{/each}
		</select>
		<select bind:value={errorType} aria-label="오류 유형">
			<option value="">모든 오류 유형</option>
			{#each ERROR_TYPES as e (e)}<option value={e}>{e}</option>{/each}
		</select>
	</div>
</div>

<p class="count">{filtering ? `${filtered.length} / ` : ''}총 {data.items.length}건</p>

{#if filtered.length === 0}
	<p class="empty">{data.items.length === 0 ? '아직 올린 오답이 없어요.' : '조건에 맞는 오답이 없어요.'}</p>
{/if}

<div class="list">
	{#each filtered as i (i.id)}
		{@const a = i.analysis}
		{@const num = problemNumber(i)}
		<button class="card" onclick={() => show(i.id)}>
			{#if showPhotos}<img src="{base}/api/items/{i.id}/image" alt="" loading="lazy" />{/if}
			<div class="body">
				<div class="line1">
					<div class="badges">
						{#if a}<span class="badge topic">{a.classification.topic}</span>{/if}
						<span class="badge wb">{i.workbook.name}</span>
						{#if num}<span class="badge pnum">{num}</span>{/if}
						{#if a}<span class="badge etype">{a.error_analysis.error_type}</span>{/if}
						{#if i.status !== 'done'}
							<span class="badge {STATUS_TONE[i.status]}">{STATUS_LABEL[i.status]}</span>
						{/if}
						{#if i.flags.taxonomy_mismatch.length}<span class="badge warn">분류 확인</span>{/if}
					</div>
					<span class="badge date">{formatDate(i.created_at)}</span>
				</div>
				<p class="title">{a?.asks ?? (i.status === 'failed' ? '분석에 실패했어요' : '분석을 기다리고 있어요')}</p>
				{#if a?.classification.unit_major}
					<small>{a.classification.unit_major}</small>
				{/if}
			</div>
		</button>
	{/each}
</div>

{#if open}
	{@const a = open.analysis}
	{@const openNum = problemNumber(open)}
	<div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && show(null)}>
		<article class="sheet" aria-label="오답 상세">
			<header>
				<div class="sheet-title-info">
					<div class="title-row">
						{#if a}
							<span class="badge topic">{a.classification.topic}</span>
						{/if}
						<span class="badge wb">{open.workbook.name}</span>
						{#if openNum}
							<span class="badge pnum">{openNum}</span>
						{/if}
						{#if a}
							<span class="badge etype">{a.error_analysis.error_type}</span>
						{/if}
						{#if open.status !== 'done'}
							<span class="badge {STATUS_TONE[open.status]}">{STATUS_LABEL[open.status]}</span>
						{/if}
						{#if open.flags.taxonomy_mismatch.length}
							<span class="badge warn">분류 확인</span>
						{/if}
						<span class="badge date">{formatDate(open.created_at)}</span>
					</div>
				</div>
				<button class="close" aria-label="닫기" onclick={() => show(null)}>✕</button>
			</header>

			{#if showPhotos}
				<a href="{base}/api/items/{open.id}/image" target="_blank" rel="noreferrer"><img class="photo" src="{base}/api/items/{open.id}/image" alt="오답 사진" /></a>
			{/if}

			{#if open.status === 'failed'}
				<p class="alert bad">분석에 실패했어요: {open.error}</p>
			{/if}
			{#if open.flags.ocr_missing}<p class="alert warn">글자 인식(OCR)이 실패해서 사진만 보고 분석했어요.</p>{/if}
			{#each open.flags.taxonomy_mismatch as m (m)}<p class="alert warn">분류 확인 필요: {m}</p>{/each}
			{#if a?.flags.multiple_problems}<p class="alert warn">사진에 문제가 여러 개 있어요. 가장 주된 한 문제만 분석했어요.</p>{/if}
			{#if a?.flags.unreadable}<p class="alert warn">사진을 읽기 어려워 내용이 부정확할 수 있어요.</p>{/if}
			{#if a && !a.verification.student_error_confirmed}<p class="alert warn">풀이가 맞아 보이거나 판단이 어려워요. 진단이 부정확할 수 있으니 확인해 주세요.</p>{/if}
			{#each open.flags.guardrail as g (g)}<p class="alert warn">형식 확인: {g}</p>{/each}

			{#if a}
				<!-- 보고서와 같은 디자인 장치(ui.css): 구분 띠, 번호 배지, 강조 박스, 라벨 목록 -->
				<section>
					<h3 class="band">분류</h3>
					<p>
						<span class="badge topic">{a.classification.topic}</span>
						{a.classification.unit_major}{a.classification.course ? ` (${a.classification.course})` : ''}
						{#if a.classification.unit_minor}› {a.classification.unit_minor}{/if}
					</p>
					<p class="tags">
						{#each a.classification.concept_ids as c (c)}<span class="tag" title={c}>{conceptLabel(c)}</span>{/each}
					</p>
					<p class="muted">{a.classification.question_type} · 난이도 {a.classification.difficulty}/5 · {a.classification.topic_rationale}</p>
				</section>

				<section>
					<h3 class="band">문제</h3>
					<div class="md">{@html renderMath(a.problem.text_md)}</div>
					{#if a.problem.figure_description}<p class="muted md">📐 {@html renderMath(a.problem.figure_description)}</p>{/if}
					<ul class="label-list">
						<li><strong>묻는 것:</strong> <span class="md">{@html renderMath(a.asks)}</span></li>
					</ul>
				</section>

				<section>
					<h3 class="band">풀이</h3>
					<div class="student-paper">
						{#if a.student_work.visible}
							<div class="md student-solution">{@html renderMath(a.student_work.transcription_md)}</div>
						{:else}
							<p class="muted student-empty">사진에 풀이 과정이 보이지 않아요.</p>
						{/if}
						{#if a.student_work.student_answer}
							<div class="student-ans-row">
								<strong class="ans-label">답:</strong>
								<span class="md ans-val">{@html renderMath(a.student_work.student_answer)}</span>
							</div>
						{/if}
					</div>
				</section>

				<section>
					<h3 class="band">
						어디서 어긋났을까
						<span class="badge etype">{a.error_analysis.error_type}</span>
						<span class="badge sev{a.error_analysis.severity}">{SEVERITY[a.error_analysis.severity]}</span>
					</h3>
					<div class="callout callout-warn">
						<strong class="callout-title">⚠️ 최초 오류 지점</strong>
						<div class="callout-body"><p class="md">{@html renderMath(a.error_analysis.error_step)}</p></div>
					</div>
					<p class="md">{@html renderMath(a.error_analysis.explanation)}</p>
				</section>

				<section>
					<h3 class="band">다시 생각해 볼 질문</h3>
					<ol class="step-list">
						<li>
							<span class="step-num">1</span>
							<span class="step-body"><strong>조건 다시 보기:</strong> <span class="md">{@html renderMath(a.error_analysis.nudges.condition_question)}</span></span>
						</li>
						<li>
							<span class="step-num">2</span>
							<span class="step-body"><strong>다른 관점으로:</strong> <span class="md">{@html renderMath(a.error_analysis.nudges.strategy_question)}</span></span>
						</li>
					</ol>
					<div class="callout callout-ok"><strong class="callout-title">✅ 위 두 질문을 바탕으로 풀이를 수정해 보세요.</strong></div>
				</section>

				<section>
					<h3 class="band">왜 또 틀릴 수 있을까</h3>
					<ul class="label-list">
						{#if a.error_analysis.misconception}
							<li><strong>잘못 알고 있는 규칙:</strong> <span class="md">{@html renderMath(a.error_analysis.misconception)}</span></li>
						{/if}
						{#if a.error_analysis.trigger}
							<li><strong>이런 상황에서 나와요:</strong> <span class="md">{@html renderMath(a.error_analysis.trigger)}</span></li>
						{/if}
						<li><strong>다 풀고 스스로 확인:</strong> <span class="md">{@html renderMath(a.error_analysis.self_check)}</span></li>
						{#if a.error_analysis.prerequisites.length}
							<li><strong>먼저 알아야 할 것:</strong> {a.error_analysis.prerequisites.join(' · ')}</li>
						{/if}
						{#if a.error_analysis.root_cause_concept_ids.length}
							<li>
								<strong>근본 원인 개념:</strong>
								<span class="tags inline">
									{#each a.error_analysis.root_cause_concept_ids as c (c)}<span class="tag" title={c}>{conceptLabel(c)}</span>{/each}
								</span>
							</li>
						{/if}
					</ul>
					<p class="muted">패턴: {a.error_analysis.error_pattern_id}</p>
				</section>

				{#if open.meta}
					<p class="muted">
						{open.meta.provider ? `${PROVIDER_LABEL[open.meta.provider]} ` : ''}{open.meta.model} · 지침 {open.meta.prompt_version} · 신뢰도 {a.confidence} · {when(open.meta.analyzed_at || open.created_at)}
					</p>
				{:else}
					<p class="muted">{when(open.created_at)}</p>
				{/if}
			{:else if open.status !== 'failed'}
				<p class="empty">분석이 끝나면 여기에 나와요.</p>
			{/if}

			{#if actionError}<p class="alert bad">{actionError}</p>{/if}
			{#if !readonly}
				<footer>
					<select class="provider" aria-label="분석에 쓸 LLM" value={chosenProvider(open)} onchange={(e) => (providerChoice = e.currentTarget.value as Provider)}>
						{#each PROVIDERS as p (p)}<option value={p}>{PROVIDER_LABEL[p]}</option>{/each}
					</select>
					<button class="btn" disabled={busy || (open.status !== 'done' && open.status !== 'failed')} onclick={() => retry(open)}>🔄 다시 분석</button>
					<button class="btn danger" disabled={busy || open.status === 'ocr' || open.status === 'analyzing'} onclick={() => remove(open)}>🗑 삭제</button>
				</footer>
			{/if}
		</article>
	</div>
{/if}

<style>
	.filters {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.chips {
		display: flex;
		gap: 8px;
		overflow-x: auto;
		padding-bottom: 2px;
	}
	.chips button {
		flex: none;
		padding: 8px 16px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--text);
		font-weight: 600;
		font-size: 0.95rem;
	}
	.chips button.on {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.selects {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	select {
		flex: 1 1 140px;
		padding: 9px 10px;
		border-radius: 10px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--text);
		font-size: 0.95rem;
	}
	.count {
		color: var(--muted);
		margin: 12px 2px 8px;
		font-size: 0.9rem;
	}
	.empty {
		color: var(--muted);
		text-align: center;
		padding: 32px 0;
	}
	.list {
		display: grid;
		gap: 10px;
	}
	.card {
		width: 100%;
		display: flex;
		gap: 12px;
		padding: 10px;
		text-align: left;
		color: inherit;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		cursor: pointer;
		font: inherit;
	}
	.card img {
		width: 84px;
		height: 84px;
		object-fit: cover;
		border-radius: 10px;
		background: var(--line);
		flex: none;
	}
	.body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.line1 {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
	}
	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
		min-width: 0;
		flex: 1;
	}
	.line1 :global(.badge.date) {
		margin-left: auto;
		flex-shrink: 0;
	}
	.title {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 400;
		color: var(--text);
		line-height: 1.4;
		text-align: left;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.body small {
		color: var(--muted);
	}

	.overlay {
		position: fixed;
		inset: 0;
		z-index: 50;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		justify-content: center;
		align-items: center;
		padding: 16px;
		backdrop-filter: blur(2px);
	}
	.sheet {
		width: 100%;
		max-width: 820px;
		max-height: 92vh;
		overflow-y: auto;
		background: var(--surface);
		border-radius: 18px;
		padding: 24px;
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.2);
	}
	/* 폰에서는 바깥 여백을 없애 시트가 화면 폭을 다 쓰게 하고 안쪽 여백도 줄인다 */
	@media (max-width: 560px) {
		.overlay {
			padding: 0;
			align-items: flex-end;
		}
		.sheet {
			padding: 18px 12px 16px;
			border-radius: 18px 18px 0 0;
			max-height: 96dvh;
		}
	}
	.sheet header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		border-bottom: 1px solid var(--line);
		padding-bottom: 12px;
		margin-bottom: 14px;
	}
	.sheet-title-info {
		display: flex;
		align-items: center;
		min-width: 0;
		flex: 1;
	}
	.title-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}

	.title-row :global(.badge.date) {
		margin-left: auto;
	}
	.close {
		border: none;
		background: var(--line);
		color: var(--text);
		width: 36px;
		height: 36px;
		border-radius: 50%;
		font-size: 1rem;
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}
	.close:hover {
		opacity: 0.85;
	}
	.photo {
		width: 100%;
		border-radius: 12px;
		border: 1px solid var(--line);
		background: #fff;
		margin-bottom: 8px;
	}
	/* 카드 테두리 대신 구분 띠(.band, ui.css)로 나눈다 */
	.sheet section {
		margin-top: 2.2rem;
	}
	.sheet section:first-of-type {
		margin-top: 1.2rem;
	}
	@media (max-width: 560px) {
		.overlay {
			padding: 0;
			align-items: flex-end;
		}
		.sheet {
			padding: 14px 12px 16px;
			border-radius: 18px 18px 0 0;
			max-height: 96dvh;
		}
		.sheet header {
			padding-bottom: 8px;
			margin-bottom: 10px;
			gap: 8px;
		}

		.close {
			width: 32px;
			height: 32px;
			font-size: 0.9rem;
		}
		.sheet section {
			margin-top: 1.6rem;
		}
		.sheet section:first-of-type {
			margin-top: 0.8rem;
		}
	}
	.tags.inline {
		display: inline-flex;
		vertical-align: middle;
	}
	.sheet p {
		margin: 10px 0;
		line-height: 1.65;
	}
	.muted {
		color: var(--muted);
		font-size: 0.88rem;
	}
	.md {
		overflow: visible;
		word-break: keep-all;
		overflow-wrap: anywhere;
		line-height: 1.7;
	}
	.md :global(.katex-display) {
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: none;
		margin: 12px 0;
	}
	.md :global(.katex-display::-webkit-scrollbar) {
		display: none;
	}
	/* 풀이: 종이(방안지/노트) 그리드 배경 */
	.student-paper {
		margin: 14px 0 18px;
		padding: 18px 20px;
		border-radius: 12px;
		background-color: #fdfbf7;
		background-image:
			linear-gradient(rgba(195, 178, 150, 0.16) 1px, transparent 1px),
			linear-gradient(90deg, rgba(195, 178, 150, 0.16) 1px, transparent 1px);
		background-size: 20px 20px;
		border: 1px solid #ebdcc5;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.03);
		color: #2c2824;
	}
	@media (prefers-color-scheme: dark) {
		.student-paper {
			background-color: #1a1d24;
			background-image:
				linear-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 1px),
				linear-gradient(90deg, rgba(255, 255, 255, 0.04) 1px, transparent 1px);
			border-color: #313744;
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
			color: #e3e0d8;
		}
	}
	@media (max-width: 560px) {
		.student-paper {
			padding: 14px 16px;
		}
	}
	@media print {
		.student-paper {
			background-color: #fdfbf7 !important;
			color: #111111 !important;
			border-color: #d0c8b6 !important;
		}
	}
	.student-solution {
		font-size: 0.98rem;
		line-height: 1.75;
	}
	.student-empty {
		margin: 0;
		font-style: italic;
	}
	.student-ans-row {
		margin-top: 12px;
		padding-top: 10px;
		border-top: 1px dashed rgba(195, 178, 150, 0.5);
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 0.95rem;
	}
	@media (prefers-color-scheme: dark) {
		.student-ans-row {
			border-top-color: rgba(255, 255, 255, 0.12);
		}
	}
	.ans-label {
		color: #a06428;
		font-weight: 700;
		white-space: nowrap;
	}
	@media (prefers-color-scheme: dark) {
		.ans-label {
			color: #e0aa6a;
		}
	}
	.ans-val {
		font-weight: 600;
	}
	.tags {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.tag {
		font-size: 0.82rem;
		padding: 2px 9px;
		border-radius: 8px;
		background: var(--accent-soft);
		color: var(--accent);
	}
	.alert {
		padding: 10px 12px;
		border-radius: 10px;
		margin: 10px 0 0;
		font-size: 0.92rem;
	}
	.alert.bad {
		background: var(--bad-soft);
		color: var(--bad);
	}
	.alert.warn {
		background: var(--warn-soft);
		color: var(--warn);
	}
	/* 하단 버튼줄은 화면에 고정하지 않고 내용 끝에 둔다(스크롤을 끝까지 내렸을 때만 보인다). 폰에서 세로 공간을 아끼기 위함 */
	footer {
		display: flex;
		gap: 10px;
		margin-top: 28px;
		padding: 8px 0 12px;
	}
	.btn {
		flex: 1;
		padding: 12px;
		border-radius: 12px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--text);
		font-weight: 700;
		font-size: 1rem;
	}
	.provider {
		flex: none;
		padding: 0 10px;
		border-radius: 12px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--text);
		font-size: 1rem;
	}
	.btn.danger {
		color: var(--bad);
	}
	.btn:disabled {
		opacity: 0.5;
	}

	@media print {
		:global(nav),
		.filters,
		.count,
		.list,
		footer,
		.close {
			display: none !important;
		}
		.overlay {
			position: static !important;
			background: none !important;
			padding: 0 !important;
		}
		.sheet {
			box-shadow: none !important;
			max-width: 100% !important;
			padding: 0 !important;
		}
	}
</style>
