<script lang="ts">
	import 'katex/dist/katex.min.css';
	import { goto, invalidate } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { AJAX_HEADER, AJAX_VALUE } from '$lib/ajax';
	import { renderMarkdown } from '$lib/math';
	import { linkifyProblemRefs, problemNumber, problemRefsFrom, stripLeadingTitle } from '$lib/report-links';
	import { formatDate, formatDateTime } from '$lib/time';
	import {
		ACTIVE_REPORT_STATUSES,
		REPORT_STATUS_LABEL,
		REPORT_STATUS_TONE,
		formatPeriodLabel,
		getAvailablePeriods,
		isItemInPeriod,
		type ReportRecord
	} from '$lib/types';

	let { data } = $props();

	let topic = $state('');
	// 처음에는 최근 10일로 시작한다(문제별 목록과 같은 기본값)
	let period = $state('10d');
	let generating = $state(false);
	let actionError = $state<string | null>(null);

	const availablePeriods = $derived(getAvailablePeriods(data.items));

	// 현재 선택된 영역과 기간에 분석 완료된 오답 수
	const doneInSelection = $derived(
		data.items.filter(
			(i) =>
				i.status === 'done' &&
				i.analysis !== null &&
				(!topic || i.analysis.classification.topic === topic) &&
				isItemInPeriod(i.created_at, period)
		)
	);

	const unitCounts = $derived(
		doneInSelection.reduce<Record<string, number>>((acc, i) => {
			const u = i.analysis?.classification.unit_major || '기타';
			acc[u] = (acc[u] || 0) + 1;
			return acc;
		}, {})
	);

	const workbookCounts = $derived(
		doneInSelection.reduce<Record<string, number>>((acc, i) => {
			const wb = i.workbook.name;
			acc[wb] = (acc[wb] || 0) + 1;
			return acc;
		}, {})
	);

	// 공유 링크로 들어온 방문자는 보기만 한다(보고서 작성·재작성·삭제 숨김)
	const readonly = $derived(page.data.session?.role === 'guest');

	// URL 쿼리 파라미터로 선택된 보고서 (?id=...)
	const selectedId = $derived(page.url.searchParams.get('id'));
	const selectedReport = $derived(data.reports.find((r) => r.id === selectedId) ?? null);

	// 보고서 본문에 나온 문제 번호(0381 등)를 해당 오답 상세로 가는 링크로 바꾼다
	const reportHtml = $derived(
		selectedReport?.markdown
			? renderMarkdown(
					linkifyProblemRefs(
						stripLeadingTitle(selectedReport.markdown),
						problemRefsFrom(data.items.filter((i) => selectedReport.item_ids?.includes(i.id))),
						(id) => `${base}/items?id=${id}`
					)
				)
			: ''
	);

	const hasActiveReports = $derived(data.reports.some((r) => ACTIVE_REPORT_STATUSES.includes(r.status)));

	// 작성 중인 보고서가 있으면 2.5초마다 새로고침
	$effect(() => {
		if (!hasActiveReports) return;
		const t = setInterval(() => invalidate('app:reports'), 2500);
		return () => clearInterval(t);
	});

	function openReport(id: string | null) {
		actionError = null;
		const url = new URL(page.url);
		if (id) url.searchParams.set('id', id);
		else url.searchParams.delete('id');
		goto(url, { keepFocus: true, noScroll: true });
	}

	async function createReport() {
		if (!topic) {
			actionError = '보고서를 작성할 영역(대수, 기하 등)을 먼저 선택해 주세요.';
			return;
		}
		if (doneInSelection.length === 0) {
			const pLabel = formatPeriodLabel(period);
			actionError = `'${topic}' 영역의 ${pLabel}에 분석 완료된 오답이 없어 보고서를 작성할 수 없어요.`;
			return;
		}

		generating = true;
		actionError = null;
		try {
			const res = await fetch(`${base}/api/reports`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					[AJAX_HEADER]: AJAX_VALUE
				},
				body: JSON.stringify({ topic, period })
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(err?.message ?? `보고서 작성 실패(${res.status})`);
			}
			const body = (await res.json()) as { report: ReportRecord };
			await invalidate('app:reports');
			openReport(body.report.id);
		} catch (e) {
			actionError = e instanceof Error ? e.message : '보고서 작성에 실패했어요';
		} finally {
			generating = false;
		}
	}

	async function retryReport(id: string) {
		try {
			actionError = null;
			const res = await fetch(`${base}/api/reports/${id}/retry`, {
				method: 'POST',
				headers: { [AJAX_HEADER]: AJAX_VALUE }
			});
			if (!res.ok) throw new Error(`재작성 요청 실패(${res.status})`);
			await invalidate('app:reports');
		} catch (e) {
			actionError = e instanceof Error ? e.message : '다시 작성 요청에 실패했어요';
		}
	}

	async function deleteReport(id: string) {
		if (!confirm('이 영역별 보고서를 삭제할까요?')) return;
		try {
			actionError = null;
			const res = await fetch(`${base}/api/reports/${id}`, {
				method: 'DELETE',
				headers: { [AJAX_HEADER]: AJAX_VALUE }
			});
			if (!res.ok) throw new Error(`보고서 삭제 실패(${res.status})`);
			if (selectedId === id) openReport(null);
			await invalidate('app:reports');
		} catch (e) {
			actionError = e instanceof Error ? e.message : '보고서 삭제에 실패했어요';
		}
	}

	const when = formatDateTime;

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && selectedId) {
			openReport(null);
		}
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="header">
	<h1>📊 영역별 맞춤 코칭 보고서</h1>
</div>

{#if actionError}
	<p class="alert bad">{actionError}</p>
{/if}

{#if !readonly}
	<!-- 새 보고서 작성 박스 -->
	<section class="create-card">
		<div class="create-grid">
			<!-- 좌측: 입력 컨트롤 -->
			<div class="create-main">
				<h2>✨ 새로운 보고서 만들기</h2>
				<div class="creator-form">
					<div class="chips" role="group" aria-label="영역 선택">
						{#each data.topics as t (t)}
							<button type="button" class:on={topic === t} onclick={() => (topic = t)}>
								{t}
							</button>
						{/each}
					</div>

					<div class="period-row">
						<select id="period-select" bind:value={period} aria-label="집계 기간">
							{#each availablePeriods as p (p.value)}
								<option value={p.value}>{p.label}</option>
							{/each}
						</select>
					</div>

					<div class="action-row">
						<button
							type="button"
							class="btn-generate"
							disabled={generating || !topic || doneInSelection.length === 0}
							onclick={createReport}
						>
							{#if generating}
								<span class="spinner"></span> '{topic}' 오답 집계 및 보고서 작성 중…
							{:else if topic}
								📊 '{topic}' 영역 코칭 보고서 작성하기
								<span class="badge-count">({doneInSelection.length}문제)</span>
							{:else}
								📊 영역을 먼저 선택해 주세요
							{/if}
						</button>
					</div>
				</div>
			</div>

			<!-- 우측: 실시간 집계 현황 및 코칭 안내 패널 -->
			<aside class="create-preview">
				{#if topic}
					<div class="preview-head">
						<span class="badge topic">{topic}</span>
						<span class="badge period">{formatPeriodLabel(period)}</span>
						<span class="preview-tag">집계 현황</span>
					</div>
					<div class="preview-stat-card">
						<span class="stat-num">{doneInSelection.length}</span>
						<span class="stat-lbl">분석 완료된 오답</span>
					</div>
					{#if doneInSelection.length > 0}
						<div class="preview-breakdown">
							<div class="breakdown-group">
								<span class="breakdown-title">단원 구성</span>
								<div class="breakdown-chips">
									{#each Object.entries(unitCounts) as [u, count]}
										<span class="b-chip">{u} <b>{count}</b></span>
									{/each}
								</div>
							</div>
							<div class="breakdown-group">
								<span class="breakdown-title">교재</span>
								<div class="breakdown-chips">
									{#each Object.entries(workbookCounts) as [wb, count]}
										<span class="b-chip wb">{wb} <b>{count}</b></span>
									{/each}
								</div>
							</div>
						</div>
					{:else}
						<p class="preview-empty">
							선택하신 기간({formatPeriodLabel(period)})에 분석 완료된 '{topic}' 오답이 없습니다.
						</p>
					{/if}
				{:else}
					<div class="preview-guide">
						<h3>💡 영역별 맞춤 코칭이란?</h3>
						<p>
							개별 문제를 하나씩 볼 때와 달리, 같은 영역의 오답들을 모아보면
							<strong>자주 헷갈리는 조건</strong>이나 <strong>반복되는 생각의 함정</strong>이 보입니다.
						</p>
						<ul class="guide-points">
							<li>🎯 반복 취약 패턴 & 오해의 순간 진단</li>
							<li>💡 정답 없이 스스로 풀게 돕는 2단계 생각 힌트</li>
							<li>⏱ 풀이 직후 10초 셀프 체크리스트 제공</li>
						</ul>
					</div>
				{/if}
			</aside>
		</div>
	</section>
{/if}

<!-- 보관된 보고서 목록 -->
<section class="archive-section">
	<div class="archive-head">
		<h2>📑 보관된 보고서 ({data.reports.length}개)</h2>
	</div>

	{#if data.reports.length === 0}
		<div class="empty-box">
			<p>아직 작성된 보고서가 없어요.</p>
			<p class="empty-sub">위에서 영역과 기간을 선택하고 보고서를 만들어 보세요!</p>
		</div>
	{:else}
		<div class="report-grid">
			{#each data.reports as r (r.id)}
				<!-- 카드 전체가 링크다. 다시 작성·삭제는 상세(보고서 읽기)에서 한다 -->
				<a
					class="report-card"
					class:active={r.id === selectedId}
					href="?id={r.id}"
					data-sveltekit-noscroll
					data-sveltekit-keepfocus
				>
					<div class="rc-top">
						<span class="badge topic">{r.topic}</span>
						{#if r.status !== 'done'}
							<span class="badge {REPORT_STATUS_TONE[r.status]}">{REPORT_STATUS_LABEL[r.status]}</span>
						{/if}
						{#if r.status === 'generating'}
							<span class="spinner-small"></span>
						{/if}
						<span class="badge date">{formatDate(r.created_at)}</span>
					</div>

					<h3 class="rc-title">{r.topic} 영역 학습 코칭 보고서</h3>

					{#if r.summary}
						<div class="rc-meta">
							<span>집계 오답 <b>{r.summary.total_items}문제</b></span>
							<span>단원 <b>{Object.keys(r.summary.unit_distribution || {}).length}개</b></span>
						</div>

						{#if Object.keys(r.summary.unit_distribution || {}).length > 0}
							<div class="rc-section">
								<span class="rc-sec-label">🎯 주요 단원</span>
								<div class="rc-tags">
									{#each Object.entries(r.summary.unit_distribution).slice(0, 3) as [unit, count]}
										<span class="unit-tag">{unit} <small>({count})</small></span>
									{/each}
									{#if Object.keys(r.summary.unit_distribution).length > 3}
										<span class="rc-more">+{Object.keys(r.summary.unit_distribution).length - 3}</span>
									{/if}
								</div>
							</div>
						{/if}

						{#if Object.keys(r.summary.error_type_distribution || {}).length > 0}
							<div class="rc-section">
								<span class="rc-sec-label">💡 주요 실수</span>
								<div class="rc-tags">
									{#each Object.entries(r.summary.error_type_distribution).slice(0, 2) as [etype, count]}
										<span class="etype-tag">{etype} <small>({count})</small></span>
									{/each}
									{#if Object.keys(r.summary.error_type_distribution).length > 2}
										<span class="rc-more">+{Object.keys(r.summary.error_type_distribution).length - 2}</span>
									{/if}
								</div>
							</div>
						{/if}
					{:else if r.error}
						<p class="alert bad rc-err">오류: {r.error}</p>
					{/if}
				</a>
			{/each}
		</div>
	{/if}
</section>

<!-- 보고서 상세 시트 (?id=...) -->
{#if selectedReport}
	<div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && openReport(null)}>
		<article class="sheet report-sheet" aria-label="보고서 상세">
			<header>
				<div class="sheet-title-info">
					<div class="title-row">
						<span class="badge topic">{selectedReport.topic}</span>
						<strong>📊 {selectedReport.topic} 영역 맞춤 코칭 보고서</strong>
						{#if selectedReport.status !== 'done'}
							<span class="badge {REPORT_STATUS_TONE[selectedReport.status]}">{REPORT_STATUS_LABEL[selectedReport.status]}</span>
						{/if}
						<span class="badge date">{formatDate(selectedReport.created_at)}</span>
					</div>
				</div>
				<button class="close" aria-label="닫기" onclick={() => openReport(null)}>✕</button>
			</header>

			{#if selectedReport.summary}
				<div class="coaching-summary-banner">
					<div class="banner-stat">
						<span class="b-num">{selectedReport.summary.total_items}</span>
						<span class="b-txt">집계된 오답</span>
					</div>
					<div class="banner-info">
						<div class="info-line">
							<strong>🎯 살펴본 단원:</strong>
							{#each Object.entries(selectedReport.summary.unit_distribution) as [unit, count]}
								<span class="unit-tag">{unit} ({count})</span>
							{/each}
						</div>
						{#if Object.keys(selectedReport.summary.error_type_distribution).length}
							<div class="info-line">
								<strong>💡 주요 실수 유형:</strong>
								{#each Object.entries(selectedReport.summary.error_type_distribution) as [etype, count]}
									<span class="etype-tag">{etype} ({count})</span>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			{/if}

			{#if selectedReport.markdown}
				<div class="report-content md-doc">
					{@html reportHtml}
				</div>
			{:else if selectedReport.status === 'failed'}
				<p class="alert bad">보고서 작성에 실패했습니다: {selectedReport.error}</p>
			{:else}
				<p class="empty">보고서를 작성하고 있습니다. 잠시만 기다려 주세요...</p>
			{/if}

			<!-- 근거 문항 목록 (결과 페이지로 연결) -->
			{#if selectedReport.item_ids && selectedReport.item_ids.length > 0}
				<section class="references-box">
					<h3>🔍 함께 살펴본 문제 ({selectedReport.item_ids.length}건)</h3>
					<p class="ref-desc">문제를 누르면 해당 문제의 사진과 상세 오답 분석을 확인하실 수 있어요.</p>
					<div class="ref-links">
						{#each selectedReport.item_ids as id}
							{@const item = data.items.find((i) => i.id === id)}
							<a
								class="ref-btn"
								href="{base}/items?id={id}"
								target="_blank"
								rel="noreferrer"
							>
								{#if item}
									{@const a = item.analysis}
									{@const num = problemNumber(item)}
									{#if a}<span class="badge topic">{a.classification.topic}</span>{/if}
									<span class="badge wb">{item.workbook.name}</span>
									{#if num}<span class="badge pnum">{num}</span>{/if}
									{#if a}<span class="badge etype">{a.error_analysis.error_type}</span>{/if}
								{:else}
									<span>문항 {id}</span>
								{/if}
								<span class="arrow">↗</span>
							</a>
						{/each}
					</div>
				</section>
			{/if}

			<footer>
				<button type="button" class="btn primary" onclick={() => window.print()}>🖨 인쇄하기</button>
				{#if !readonly}
					<button
						type="button"
						class="btn"
						disabled={selectedReport.status !== 'done' && selectedReport.status !== 'failed'}
						onclick={() => retryReport(selectedReport.id)}>🔄 다시 작성</button
					>
					<button
						type="button"
						class="btn danger"
						disabled={selectedReport.status === 'generating'}
						onclick={() => deleteReport(selectedReport.id)}>🗑 삭제</button
					>
				{/if}
				<button type="button" class="btn" onclick={() => openReport(null)}>닫기</button>
			</footer>
		</article>
	</div>
{/if}

<style>
	.header {
		margin-bottom: 20px;
	}
	h1 {
		font-size: 1.5rem;
		margin: 0;
	}

	.create-card {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 22px;
		margin-bottom: 24px;
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.03);
	}
	/*
	 * 열 폭은 minmax(0, …) 로 둔다. `1fr` 은 minmax(auto, 1fr) 라서 안쪽 내용(줄바꿈 없는 칩 다섯 개 등)의 최소 폭만큼 열이 늘어나
	 * 좁은 화면(폰)에서 버튼·안내 박스가 카드 밖으로 삐져나온다.
	 */
	.create-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
	}
	.create-main,
	.create-preview {
		min-width: 0;
	}
	@media (min-width: 768px) {
		.create-grid {
			grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
			gap: 28px;
			align-items: stretch;
		}
	}
	.create-main {
		display: flex;
		flex-direction: column;
	}
	.create-main h2 {
		font-size: 1.15rem;
		margin: 0 0 16px;
	}
	.creator-form {
		display: flex;
		flex-direction: column;
		gap: 16px;
		height: 100%;
	}
	.period-row {
		display: flex;
		align-items: center;
	}
	.period-row select {
		width: 100%;
		max-width: 220px;
	}
	/*
	 * 영역 칩은 항상 한 줄이다(폰에서 두 줄로 꺾이지 않게). 칩이 줄어들 수 있도록 안쪽 좌우 여백을 화면 폭에 맞춰 줄이고
	 * (넓으면 16px, 375px 폰이면 약 6px), 남는 폭은 칩이 나눠 가져 줄이 꽉 차 보이게 한다.
	 * 영역이 더 늘어 한 줄에 다 못 들어가면 잘리지 않고 가로 스크롤된다.
	 */
	.chips {
		display: flex;
		flex-wrap: nowrap;
		gap: 6px;
		overflow-x: auto;
		padding-bottom: 2px;
	}
	.chips button {
		flex: 1 1 auto;
		text-align: center;
		padding: 8px clamp(6px, 1.7vw, 16px);
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--bg);
		color: var(--text);
		font-weight: 600;
		font-size: 0.95rem;
		cursor: pointer;
		white-space: nowrap;
		transition: all 0.15s;
	}
	.chips button:hover {
		border-color: var(--accent);
	}
	.chips button.on {
		background: var(--accent);
		border-color: var(--accent);
		color: #ffffff;
	}

	select {
		padding: 8px 12px;
		border-radius: 10px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--text);
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
	}

	.action-row {
		margin-top: auto;
		padding-top: 8px;
	}
	.btn-generate {
		width: 100%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		background: var(--accent);
		color: #ffffff;
		border: none;
		border-radius: 12px;
		padding: 12px 20px;
		font-size: 1rem;
		font-weight: 700;
		cursor: pointer;
		transition: opacity 0.15s;
		/* 좁은 화면에서 한글이 "작성하 / 기" 처럼 낱말 중간에서 끊기지 않게 하고, (13문제) 는 통째로 다음 줄로 내린다 */
		flex-wrap: wrap;
		word-break: keep-all;
		text-align: center;
	}
	.btn-generate:hover:not(:disabled) {
		opacity: 0.92;
	}
	.btn-generate:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.badge-count {
		white-space: nowrap;
		font-size: 0.85rem;
		opacity: 0.9;
		font-weight: 500;
	}

	/* 우측 미리보기 및 가이드 패널 */
	.create-preview {
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 14px;
		padding: 18px 20px;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 12px;
	}
	.preview-head {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.preview-tag {
		margin-left: auto;
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--accent);
		background: var(--accent-soft);
		padding: 2px 8px;
		border-radius: 6px;
	}
	.preview-stat-card {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin: 2px 0 6px;
	}
	.stat-num {
		font-size: 2.2rem;
		font-weight: 800;
		color: var(--accent);
		line-height: 1;
	}
	.stat-lbl {
		font-size: 0.9rem;
		font-weight: 700;
		color: var(--muted);
	}
	.preview-breakdown {
		display: flex;
		flex-direction: column;
		gap: 10px;
		border-top: 1px dashed var(--line);
		padding-top: 10px;
	}
	.breakdown-group {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.breakdown-title {
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--muted);
	}
	.breakdown-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.b-chip {
		font-size: 0.8rem;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 3px 8px;
		color: var(--text);
	}
	.b-chip b {
		color: var(--accent);
	}
	.b-chip.wb {
		color: var(--muted);
	}
	.preview-empty {
		color: var(--bad);
		font-size: 0.88rem;
		margin: 4px 0 0;
	}
	.preview-guide {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.preview-guide h3 {
		font-size: 0.98rem;
		color: var(--text);
		margin: 0;
	}
	.preview-guide p {
		font-size: 0.86rem;
		color: var(--muted);
		line-height: 1.5;
		margin: 0;
	}
	.guide-points {
		margin: 4px 0 0;
		padding-left: 18px;
		font-size: 0.82rem;
		color: var(--text);
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.archive-section {
		margin-top: 28px;
	}
	.archive-head {
		margin-bottom: 16px;
	}
	.archive-head h2 {
		font-size: 1.15rem;
		margin: 0;
	}

	.empty-box {
		text-align: center;
		padding: 40px 16px;
		background: var(--surface);
		border: 1px dashed var(--line);
		border-radius: var(--radius);
		color: var(--muted);
	}
	.empty-sub {
		font-size: 0.9rem;
		margin-top: 4px;
	}

	.report-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		gap: 16px;
	}
	.report-card {
		text-decoration: none;
		color: inherit;
		cursor: pointer;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 18px 20px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		transition: border-color 0.15s, box-shadow 0.15s;
	}
	.report-card:hover {
		border-color: var(--accent);
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.06);
	}
	.report-card.active {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.rc-top {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.rc-top :global(.badge.date) {
		margin-left: auto;
	}
	.rc-title {
		font-size: 1.1rem;
		margin: 0;
		color: var(--text);
		font-weight: 700;
	}
	.rc-meta {
		display: flex;
		gap: 12px;
		font-size: 0.88rem;
		color: var(--muted);
		padding-bottom: 8px;
		border-bottom: 1px dashed var(--line);
	}
	.rc-meta b {
		color: var(--text);
	}
	.rc-section {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.rc-sec-label {
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--muted);
	}
	.rc-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
	}
	.rc-more {
		font-size: 0.76rem;
		color: var(--muted);
		font-weight: 600;
	}
	.rc-err {
		margin: 4px 0;
		font-size: 0.82rem;
		padding: 6px 10px;
	}


	/* 모달 시트 */
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.45);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
		z-index: 10;
		backdrop-filter: blur(2px);
	}
	.sheet {
		background: var(--surface);
		border-radius: 18px;
		padding: 24px;
		max-height: 92vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 22px;
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.2);
	}
	.report-sheet {
		max-width: 820px;
		width: 100%;
	}
	/*
	 * 폰에서는 바깥 여백(16px)을 없애 시트가 화면 폭을 다 쓰게 하고 안쪽 여백도 줄인다.
	 * (전: 바깥 16 + 안쪽 24 = 좌우 80px 를 뺀 340px → 후: 안쪽 12 = 좌우 24px 를 뺀 396px, 420px 폰 기준)
	 * 위쪽은 살짝 남겨 배경을 눌러 닫을 수 있게 한다.
	 */
	@media (max-width: 560px) {
		.overlay {
			padding: 0;
			align-items: flex-end;
		}
		.sheet {
			padding: 14px 12px 16px;
			border-radius: 18px 18px 0 0;
			max-height: 96dvh;
			gap: 14px;
		}
		header {
			padding-bottom: 8px;
			margin-bottom: 10px;
			gap: 8px;
		}
		.title-row {
			gap: 6px;
		}
		.title-row strong {
			font-size: 1.05rem;
		}
		.close {
			width: 32px;
			height: 32px;
			font-size: 0.9rem;
		}
	}
	header {
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
	.title-row strong {
		font-size: 1.15rem;
		color: var(--text);
		line-height: 1.3;
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

	/* 코칭 요약 배너 */
	.coaching-summary-banner {
		display: flex;
		align-items: center;
		gap: 20px;
		background: var(--accent-soft);
		border: 1px solid var(--line);
		border-radius: 14px;
		padding: 16px 20px;
	}
	.banner-stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-width: 80px;
		border-right: 1px solid var(--line);
		padding-right: 16px;
	}
	.b-num {
		font-size: 1.8rem;
		font-weight: 800;
		color: var(--accent);
		line-height: 1;
	}
	.b-txt {
		font-size: 0.8rem;
		font-weight: 700;
		color: var(--muted);
		margin-top: 4px;
	}
	.banner-info {
		display: flex;
		flex-direction: column;
		gap: 8px;
		flex: 1;
		font-size: 0.88rem;
	}
	.info-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.info-line strong {
		color: var(--text);
		font-weight: 700;
	}
	.unit-tag {
		background: var(--surface);
		padding: 2px 8px;
		border-radius: 6px;
		font-size: 0.82rem;
		color: var(--accent);
		border: 1px solid var(--line);
		font-weight: 600;
	}
	.etype-tag {
		background: var(--warn-soft);
		padding: 2px 8px;
		border-radius: 6px;
		font-size: 0.82rem;
		color: var(--warn);
		border: 1px solid var(--line);
		font-weight: 600;
	}

	/* 마크다운 본문 */
	.report-content {
		line-height: 1.8;
		font-size: 1.02rem;
		color: var(--text);
		overflow-wrap: break-word;
	}
	.report-content :global(h1),
	.report-content :global(h2),
	.report-content :global(h3) {
		color: var(--text);
		font-weight: 700;
	}
	/* h2(구분 띠)·h3(번호 소제목) 모양은 공용 스타일(ui.css 의 .md-doc)을 쓴다 */
	.report-content :global(p) {
		margin: 16px 0;
	}
	.report-content :global(table) {
		width: 100%;
		border-collapse: collapse;
		margin: 20px 0;
		font-size: 0.92rem;
	}
	.report-content :global(th),
	.report-content :global(td) {
		padding: 12px 14px;
		border: 1px solid var(--line);
		text-align: left;
	}
	.report-content :global(th) {
		background: var(--bg);
		font-weight: 700;
	}
	/* 첫 열(문제)은 "문제집<br/>문제번호" 두 줄이다. 긴 문제집 이름이 좁은 열에서 글자 중간에 잘려 세 줄이 되지 않게 한다 */
	.report-content :global(th:first-child),
	.report-content :global(td:first-child) {
		white-space: nowrap;
	}
	/*
	 * 첫 열을 줄바꿈 금지로 두면 좁은 화면(폰)에서 나머지 열이 글자 한두 개 폭으로 찌그러진다.
	 * 나머지 열에 최소 폭을 줘서, 좁으면 표를 찌그러뜨리지 않고 감싼 상자(.table-wrap)에서 가로로 스크롤되게 한다.
	 */
	.report-content :global(th:not(:first-child)),
	.report-content :global(td:not(:first-child)) {
		min-width: 12em;
	}

	.report-content :global(a) {
		color: var(--accent);
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.report-content :global(a.problem-link) {
		text-decoration: none !important;
	}
	.report-content :global(td:first-child a.problem-link) {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 4px;
		align-items: center;
	}
	.report-content :global(blockquote) {
		margin: 18px 0;
		padding: 14px 18px;
		border-left: 4px solid var(--accent);
		background: var(--accent-soft);
		border-radius: 0 10px 10px 0;
		font-style: normal;
	}
	.report-content :global(ul),
	.report-content :global(ol) {
		margin: 14px 0;
		padding-left: 24px;
	}
	.report-content :global(li) {
		margin-bottom: 6px;
	}

	/* 근거 문항 */
	.references-box {
		margin-top: 24px;
		padding-top: 20px;
		border-top: 1px dashed var(--line);
	}
	.references-box h3 {
		font-size: 1.05rem;
		margin: 0 0 4px;
	}
	.ref-desc {
		font-size: 0.85rem;
		color: var(--muted);
		margin: 0 0 12px;
	}
	.ref-links {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.ref-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 8px 12px;
		text-decoration: none;
		color: var(--text);
		font-size: 0.88rem;
		font-weight: 600;
		transition: all 0.15s;
	}
	.ref-btn:hover {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
	}

	.ref-btn .arrow {
		color: var(--accent);
		font-size: 0.85rem;
	}

	footer {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		border-top: 1px solid var(--line);
		padding-top: 18px;
		margin-top: 16px;
	}
	.btn {
		padding: 9px 16px;
		border-radius: 10px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--text);
		font-weight: 600;
		font-size: 0.92rem;
		cursor: pointer;
	}
	.btn:hover {
		background: var(--line);
	}
	.btn.primary {
		background: var(--accent);
		color: #ffffff;
		border-color: var(--accent);
	}
	.btn.danger {
		color: var(--bad);
	}
	.btn.danger:hover {
		background: var(--bad-soft);
	}


	.spinner {
		width: 14px;
		height: 14px;
		border: 2px solid rgba(255, 255, 255, 0.4);
		border-top-color: #fff;
		border-radius: 50%;
		display: inline-block;
		animation: spin 0.8s linear infinite;
	}
	.spinner-small {
		width: 10px;
		height: 10px;
		border: 2px solid var(--line);
		border-top-color: var(--accent);
		border-radius: 50%;
		display: inline-block;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.alert {
		padding: 10px 14px;
		border-radius: 10px;
		font-size: 0.9rem;
		margin: 0 0 16px;
	}
	.alert.bad {
		background: var(--bad-soft);
		color: var(--bad);
	}

	/* A4 세로로 인쇄한다. 폰에서 PDF 로 저장한 뒤 프린터로 보내는 흐름이 기준이다 */
	@page {
		size: A4 portrait;
		margin: 14mm;
	}
	/*
	 * 폰 전용 규칙은 여기 모아 둔다. 기본 규칙보다 뒤에 있어야 이긴다(앞에 두면 같은 명시도의 뒤쪽 기본 규칙에 덮어써진다).
	 */
	@media (max-width: 560px) {
		/* 집계 박스: 큰 숫자를 위 한 줄로 올려 칩이 전체 폭을 쓰게 한다 */
		.coaching-summary-banner {
			flex-direction: column;
			align-items: stretch;
			padding: 12px;
			gap: 10px;
		}
		.banner-stat {
			flex-direction: row;
			align-items: baseline;
			justify-content: flex-start;
			gap: 8px;
			min-width: 0;
			padding: 0 0 10px;
			border-right: none;
			border-bottom: 1px solid var(--line);
		}
		/* 표: 폭이 넓어진 시트에 스크롤 없이 들어가도록 여백·최소 폭을 줄인다 */
		.report-content :global(th),
		.report-content :global(td) {
			padding: 8px 6px;
		}
		.report-content :global(th:not(:first-child)),
		.report-content :global(td:not(:first-child)) {
			min-width: 6.5em;
		}
		/* 첫 열은 줄바꿈 금지라 폭을 정하므로 글자를 조금 줄인다("개념원리 공통수학2" 처럼 긴 문제집 이름 때문) */
		.report-content :global(th:first-child),
		.report-content :global(td:first-child) {
			font-size: 0.9em;
		}
	}

	@media print {
		/* 화면용 페이지 틀을 걷어 낸다 */
		:global(html),
		:global(body) {
			background: #fff !important;
			height: auto !important;
			overflow: visible !important;
		}
		:global(main) {
			padding: 0 !important;
			max-width: none !important;
		}
		:global(nav),
		.create-card,
		.archive-section,
		.header,
		.alert,
		.references-box,
		footer,
		.close {
			display: none !important;
		}

		/*
		 * 보고서 상세는 화면에서는 높이 92vh 에 스크롤이 있는 모달이다. 이 제한이 인쇄에도 남으면 화면에 보이는 만큼만
		 * 출력되므로(보고서 뒷부분이 통째로 빠짐), 모달을 일반 문서 흐름으로 되돌려 전체를 쪽으로 나눠 찍는다.
		 * 어두운 테마여도 종이에는 밝은 배경·어두운 글자로 나오도록 색도 고정한다.
		 */
		.overlay {
			--bg: #fff;
			--surface: #fff;
			--text: #111;
			--muted: #555;
			--line: #c9ccd3;
			--accent: #1d3fbf;
			--accent-soft: #eef2ff;
			position: static !important;
			display: block !important;
			background: #fff !important;
			padding: 0 !important;
			backdrop-filter: none !important;
			color: #111;
		}
		.sheet {
			max-height: none !important;
			height: auto !important;
			overflow: visible !important;
			max-width: 100% !important;
			width: 100% !important;
			padding: 0 !important;
			border-radius: 0 !important;
			box-shadow: none !important;
			background: #fff !important;
		}
		.report-content {
			font-size: 11pt;
			line-height: 1.6;
		}
		/* 표는 잘리지 않게: 한 줄이 쪽 경계에서 갈라지지 않고 머리글은 쪽마다 반복한다 */
		.report-content :global(table) {
			font-size: 10pt;
			break-inside: auto;
		}
		.report-content :global(thead) {
			display: table-header-group;
		}
		.report-content :global(tr),
		.report-content :global(blockquote) {
			break-inside: avoid;
		}
		/* 제목이 쪽 끝에 혼자 남지 않게 */
		.report-content :global(h1),
		.report-content :global(h2),
		.report-content :global(h3),
		.report-content :global(h4) {
			break-after: avoid;
		}
		/* 배경색(표 머리글, 배지)이 인쇄되게 */
		.report-content :global(th),
		.badge,
		.coaching-summary-banner {
			-webkit-print-color-adjust: exact;
			print-color-adjust: exact;
		}
		/* 종이에서는 링크 색이 흐리면 읽기 어렵다 */
		.report-content :global(a) {
			color: #1d3fbf;
		}
	}
</style>
