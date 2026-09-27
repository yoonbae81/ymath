<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { base } from '$app/paths';
	import { hasActive, STATUS_LABEL, STATUS_TONE } from '$lib/status';
	import { problemNumber } from '$lib/report-links';
	import { formatDate, formatDateTimeSeconds } from '$lib/time';
	import {
		ACTIVE_REPORT_STATUSES,
		REPORT_STATUS_LABEL,
		REPORT_STATUS_TONE,
		type ItemRecord,
		type ReportRecord
	} from '$lib/types';

	let { data } = $props();

	let statusFilter = $state<string>('');
	let typeFilter = $state<string>('');

	const activeItems = $derived(hasActive(data.items));
	const activeReports = $derived(data.reports.some((r) => ACTIVE_REPORT_STATUSES.includes(r.status)));

	// 진행 중인 작업이 있으면 2.5초마다 새로고침
	$effect(() => {
		if (!activeItems && !activeReports) return;
		const t = setInterval(() => invalidate('app:status'), 2500);
		return () => clearInterval(t);
	});

	type QueueEntry =
		| {
				type: 'item';
				id: string;
				time: string;
				status: ItemRecord['status'];
				active: boolean;
				item: ItemRecord;
		  }
		| {
				type: 'report';
				id: string;
				time: string;
				status: ReportRecord['status'];
				active: boolean;
				report: ReportRecord;
		  };

	const allEntries = $derived<QueueEntry[]>([
		...data.items.map((i): QueueEntry => ({
			type: 'item',
			id: i.id,
			time: i.created_at,
			status: i.status,
			active: i.status === 'ocr' || i.status === 'analyzing',
			item: i
		})),
		...data.reports.map((r): QueueEntry => ({
			type: 'report',
			id: r.id,
			time: r.created_at,
			status: r.status,
			active: r.status === 'generating',
			report: r
		}))
	].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()));

	const filteredEntries = $derived(
		allEntries.filter((entry) => {
			if (typeFilter && entry.type !== typeFilter) return false;
			if (!statusFilter) return true;
			if (statusFilter === 'processing') return entry.active;
			if (statusFilter === 'queued') return entry.status === 'queued';
			if (statusFilter === 'done') return entry.status === 'done';
			if (statusFilter === 'failed') return entry.status === 'failed';
			return true;
		})
	);

	const when = formatDateTimeSeconds;
</script>

<div class="header">
	<h1>
		⚡ 작업 상태
		{#if activeItems || activeReports}
			<span class="pulse-badge">실행 중</span>
		{/if}
	</h1>
	<button class="btn-refresh" onclick={() => invalidate('app:status')}>
		🔄 새로고침
	</button>
</div>

<section class="panel">
	<div class="filter-section">
		<div class="stats-row">
			<button class="stat-pill" class:on={statusFilter === ''} onclick={() => (statusFilter = '')}>
				전체 {data.stats.total}
			</button>
			<button class="stat-pill" class:on={statusFilter === 'queued'} onclick={() => (statusFilter = 'queued')}>
				대기 {data.stats.queued}
			</button>
			<button class="stat-pill accent" class:on={statusFilter === 'processing'} onclick={() => (statusFilter = 'processing')}>
				진행 {data.stats.processing}
			</button>
			<button class="stat-pill ok" class:on={statusFilter === 'done'} onclick={() => (statusFilter = 'done')}>
				완료 {data.stats.done}
			</button>
			<button class="stat-pill bad" class:on={statusFilter === 'failed'} onclick={() => (statusFilter = 'failed')}>
				실패 {data.stats.failed}
			</button>
		</div>

		<div class="type-filter-row">
			<button class="type-chip" class:on={typeFilter === ''} onclick={() => (typeFilter = '')}>
				전체 ({allEntries.length})
			</button>
			<button class="type-chip item" class:on={typeFilter === 'item'} onclick={() => (typeFilter = 'item')}>
				문제 분석 ({data.stats.itemsTotal})
			</button>
			<button class="type-chip report" class:on={typeFilter === 'report'} onclick={() => (typeFilter = 'report')}>
				영역 보고서 ({data.stats.reportsTotal})
			</button>
		</div>
	</div>

	{#if filteredEntries.length === 0}
		<p class="empty">해당 조건의 작업이 없습니다.</p>
	{:else}
		<div class="queue-list">
			{#each filteredEntries as entry (entry.id)}
				{#if entry.type === 'item'}
					{@const i = entry.item}
					{@const num = problemNumber(i)}
					<a class="queue-item" href="{base}/items?id={i.id}">
						<img class="thumb" src="{base}/api/items/{i.id}/image" alt="" loading="lazy" />
						<div class="q-body">
							<div class="q-row1">
								{#if typeFilter === ''}
									<span class="type-pill item">문제 분석</span>
								{/if}
								{#if i.analysis}
									<span class="badge topic">{i.analysis.classification.topic}</span>
								{/if}
								<span class="badge wb">{i.workbook.name}</span>
								{#if num}
									<span class="badge pnum">{num}</span>
								{/if}
								{#if i.analysis}
									<span class="badge etype">{i.analysis.error_analysis.error_type}</span>
								{/if}
								{#if i.status !== 'done'}
									<span class="badge {STATUS_TONE[i.status]}">{STATUS_LABEL[i.status]}</span>
								{/if}
								{#if entry.active}
									<span class="spinner"></span>
								{/if}
								<span class="badge date time-full">{when(i.created_at)}</span>
								<span class="badge date time-mobile">{formatDate(i.created_at)}</span>
							</div>
							{#if i.analysis}
								<p class="q-asks"><b>묻는 것:</b> {i.analysis.asks}</p>
								{#if i.analysis.classification.unit_major}
									<div class="q-tags">
										<span class="tag">{i.analysis.classification.unit_major}{i.analysis.classification.unit_minor ? ` › ${i.analysis.classification.unit_minor}` : ''}</span>
									</div>
								{/if}
							{:else if i.error}
								<p class="alert bad q-err">오류: {i.error} (시도: {i.attempts}회)</p>
							{/if}
						</div>
					</a>
				{:else}
					{@const r = entry.report}
					<a class="queue-item" href="{base}/areas?id={r.id}">
						<div class="report-icon">📊</div>
						<div class="q-body">
							<div class="q-row1">
								{#if typeFilter === ''}
									<span class="type-pill report">영역 보고서</span>
								{/if}
								<span class="badge topic">{r.topic}</span>
								<strong class="title">{r.topic} 영역 맞춤 코칭 보고서</strong>
								{#if r.status !== 'done'}
									<span class="badge {REPORT_STATUS_TONE[r.status]}">{REPORT_STATUS_LABEL[r.status]}</span>
								{/if}
								{#if entry.active}
									<span class="spinner"></span>
								{/if}
								<span class="badge date time-full">{when(r.created_at)}</span>
								<span class="badge date time-mobile">{formatDate(r.created_at)}</span>
							</div>
							{#if r.summary}
								<p class="q-asks">
									집계 오답 {r.summary.total_items}건 · 단원 {Object.keys(r.summary.unit_distribution).length}개 · 패턴 {r.summary.pattern_counts.length}개
								</p>
							{:else if r.error}
								<p class="alert bad q-err">오류: {r.error} (시도: {r.attempts}회)</p>
							{/if}
						</div>
					</a>
				{/if}
			{/each}
		</div>
	{/if}
</section>

<style>
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
		flex-wrap: wrap;
		gap: 12px;
	}
	h1 {
		font-size: 1.3rem;
		margin: 0;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.pulse-badge {
		background: var(--ok-soft);
		color: var(--ok);
		font-size: 0.75rem;
		font-weight: 700;
		padding: 2px 8px;
		border-radius: 999px;
		animation: pulse 1.5s infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.5; }
	}
	.btn-refresh {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 10px;
		padding: 8px 14px;
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--text);
		cursor: pointer;
	}

	.panel {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 16px;
	}

	.filter-section {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 16px;
		padding-bottom: 14px;
		border-bottom: 1px solid var(--line);
	}

	.stats-row {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 4px;
	}
	.stat-pill {
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 6px 2px;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text);
		cursor: pointer;
		text-align: center;
		white-space: nowrap;
		transition: all 0.15s;
	}
	.stat-pill:hover {
		border-color: var(--muted);
	}
	.stat-pill.on {
		background: var(--text);
		color: #ffffff;
		border-color: var(--text);
	}
	.stat-pill.accent.on {
		background: var(--accent);
		color: #ffffff;
		border-color: var(--accent);
	}
	.stat-pill.ok.on {
		background: var(--ok);
		color: #ffffff;
		border-color: var(--ok);
	}
	.stat-pill.bad.on {
		background: var(--bad);
		color: #ffffff;
		border-color: var(--bad);
	}

	.type-filter-row {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 6px;
	}
	.type-chip {
		background: none;
		border: 1px solid var(--line);
		border-radius: 20px;
		padding: 6px 4px;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
		cursor: pointer;
		text-align: center;
		white-space: nowrap;
	}
	.type-chip.on {
		background: var(--surface);
		color: var(--text);
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
	}
	.type-chip.item.on {
		color: #3b50df;
		border-color: #3b50df;
		box-shadow: 0 0 0 1px #3b50df;
	}
	.type-chip.report.on {
		color: #7e22ce;
		border-color: #7e22ce;
		box-shadow: 0 0 0 1px #7e22ce;
	}

	.empty {
		text-align: center;
		color: var(--muted);
		padding: 32px 0;
	}

	.queue-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.queue-item {
		color: inherit;
		text-decoration: none;
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 12px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 12px;
		transition: border-color 0.15s;
	}
	.queue-item:hover {
		border-color: var(--muted);
	}

	.type-pill {
		font-size: 0.74rem;
		font-weight: 700;
		padding: 2px 7px;
		border-radius: 6px;
		white-space: nowrap;
	}
	.type-pill.item {
		background: #eef2ff;
		color: #3b50df;
		border: 1px solid #c7d2fe;
	}
	.type-pill.report {
		background: #faf5ff;
		color: #7e22ce;
		border: 1px solid #e9d5ff;
	}

	.thumb {
		width: 54px;
		height: 54px;
		object-fit: cover;
		border-radius: 8px;
		border: 1px solid var(--line);
		background: #fff;
		flex-shrink: 0;
	}
	.report-icon {
		width: 54px;
		height: 54px;
		border-radius: 8px;
		background: #ede9fe;
		border: 1px solid #ddd6fe;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.5rem;
		flex-shrink: 0;
	}

	.q-body {
		flex: 1;
		min-width: 0;
	}
	.q-row1 {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 6px;
	}
	.q-row1 .title {
		font-size: 0.98rem;
		color: var(--text);
	}
	.q-row1 :global(.badge.date) {
		margin-left: auto;
	}
	.time-mobile {
		display: none;
	}

	.q-asks {
		margin: 4px 0 6px;
		font-size: 0.88rem;
		color: var(--text);
		line-height: 1.4;
	}
	.q-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.tag {
		font-size: 0.75rem;
		background: var(--surface);
		border: 1px solid var(--line);
		padding: 2px 7px;
		border-radius: 6px;
		color: var(--muted);
	}
	.tag.etype {
		color: #c2410c;
		background: #fff7ed;
		border-color: #ffedd5;
	}
	.q-err {
		margin: 6px 0 0;
		font-size: 0.82rem;
		padding: 6px 10px;
	}

	.spinner {
		width: 12px;
		height: 12px;
		border: 2px solid var(--line);
		border-top-color: var(--accent);
		border-radius: 50%;
		display: inline-block;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to { transform: rotate(360deg); }
	}


	.alert {
		padding: 8px 12px;
		border-radius: 8px;
		font-size: 0.88rem;
		margin: 0 0 12px;
	}
	.alert.bad {
		background: var(--bad-soft);
		color: var(--bad);
	}

	@media (max-width: 600px) {
		.time-full {
			display: none;
		}
		.time-mobile {
			display: inline-flex;
		}
		.panel {
			padding: 12px;
		}
		.queue-item {
			padding: 10px;
			gap: 10px;
		}
		.thumb,
		.report-icon {
			width: 48px;
			height: 48px;
		}
	}
</style>
