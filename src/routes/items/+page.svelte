<script lang="ts">
	import 'katex/dist/katex.min.css';
	import { goto, invalidate } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { AJAX_HEADER, AJAX_VALUE } from '$lib/ajax';
	import { renderMath, renderMarkdown } from '$lib/math';
	import { formatDate, formatDateTime, formatDateTimeFull } from '$lib/time';
	import { problemNumber } from '$lib/report-links';
	import { STATUS_LABEL, STATUS_TONE, hasActive } from '$lib/status';
	import {
		ERROR_TYPES,
		FEEDBACK_ASKS_COMMENT,
		FEEDBACK_CHOICES,
		FEEDBACK_COMMENT_MAX,
		FEEDBACK_LABEL,
		PROVIDERS,
		PROVIDER_LABEL,
		currentFeedback,
		getAvailablePeriods,
		isItemInPeriod,
		type FeedbackChoice,
		type ItemRecord,
		type Provider
	} from '$lib/types';

	let { data } = $props();

	let topic = $state('');
	let workbook = $state('');
	let errorType = $state('');
	// 분석이 끝났는데 아직 반응을 남기지 않은 것만 본다
	let onlyUnreviewed = $state(false);
	// 즐겨찾기(나중에 다시 볼 오답)만 본다
	let onlyFavorite = $state(false);
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

	const unreviewed = (i: ItemRecord) => i.status === 'done' && !currentFeedback(i);
	const unreviewedCount = $derived(data.items.filter(unreviewed).length);
	const favoriteCount = $derived(data.items.filter((i) => i.favorite).length);

	const filtered = $derived(
		data.items.filter(
			(i) =>
				(!topic || i.analysis?.classification.topic === topic) &&
				(!workbook || i.workbook.id === workbook) &&
				(!errorType || i.analysis?.error_analysis.error_type === errorType) &&
				(!onlyUnreviewed || unreviewed(i)) &&
				(!onlyFavorite || i.favorite) &&
				isItemInPeriod(i.created_at, period)
		)
	);
	const filtering = $derived(!!(topic || workbook || errorType || onlyUnreviewed || onlyFavorite || period));

	// 진행 중인 항목이 있으면 3초마다 새로 읽는다
	$effect(() => {
		if (!hasActive(data.items)) return;
		const t = setInterval(() => invalidate('app:items'), 3000);
		return () => clearInterval(t);
	});

	// 오답분석을 열면 확인 시각을 기록한다. 한 번 열 때 하나만 기록하고, 닫았다 다시 열면 다시 기록한다. 게스트(공유 링크)는 기록하지 않는다
	let markedViewId = $state<string | null>(null);
	$effect(() => {
		if (!openId) {
			markedViewId = null;
			return;
		}
		const i = open;
		if (readonly || !i || i.status !== 'done' || !i.analysis || markedViewId === i.id) return;
		markedViewId = i.id;
		markViewed(i.id);
	});

	async function markViewed(id: string) {
		try {
			const res = await fetch(`${base}/api/items/${id}/viewed`, { method: 'POST', headers: { [AJAX_HEADER]: AJAX_VALUE } });
			// 기록에 실패해도 화면은 그대로 쓴다. 다음에 다시 열 때 기록된다
			if (res.ok) await invalidate('app:items');
		} catch {
			// 네트워크 오류도 마찬가지로 조용히 넘긴다
		}
	}

	// 분석 반응(라디오). 이미 남긴 답이 있으면 '수정'을 눌러야 다시 열린다
	let fbChoice = $state<FeedbackChoice | null>(null);
	let fbComment = $state('');
	let fbEditing = $state(false);

	// 페이지를 연 직후 바로 저장하는 것을 막는 최소 읽기 시간. 그 전에는 결과를 골라도 확인이 비활성 상태로 남는다(별도 안내는 없음)
	const FEEDBACK_DWELL_MS = 40_000;
	let feedbackUnlocked = $state(false);
	$effect(() => {
		const t = setTimeout(() => (feedbackUnlocked = true), FEEDBACK_DWELL_MS);
		return () => clearTimeout(t);
	});

	function show(id: string | null) {
		actionError = null;
		providerChoice = null;
		fbChoice = null;
		fbComment = '';
		fbEditing = false;
		const url = new URL(page.url);
		if (id) url.searchParams.set('id', id);
		else url.searchParams.delete('id');
		goto(url, { keepFocus: true, noScroll: true });
	}

	async function call(method: string, path: string, after?: () => void, body?: unknown) {
		busy = true;
		actionError = null;
		try {
			const headers: Record<string, string> = { [AJAX_HEADER]: AJAX_VALUE };
			if (body !== undefined) headers['content-type'] = 'application/json';
			const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
	// 별은 눌리자마자 채워지게(터치 피드백) 서버 저장을 기다리지 않는다. 저장에 실패하면 되돌린다
	async function toggleFavorite(i: ItemRecord) {
		const target = !i.favorite;
		i.favorite = target;
		try {
			const res = await fetch(`${base}/api/items/${i.id}/favorite`, {
				method: 'POST',
				headers: { [AJAX_HEADER]: AJAX_VALUE, 'content-type': 'application/json' },
				body: JSON.stringify({ favorite: target })
			});
			if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? `요청 실패(${res.status})`);
			await invalidate('app:items');
		} catch (e) {
			i.favorite = !target;
			actionError = e instanceof Error ? e.message : '즐겨찾기를 저장하지 못했어요';
		}
	}
	function editFeedback(i: ItemRecord) {
		const f = currentFeedback(i);
		fbChoice = f?.choice ?? null;
		fbComment = f?.comment ?? '';
		fbEditing = true;
	}
	const sendFeedback = (i: ItemRecord) =>
		call(
			'POST',
			`${base}/api/items/${i.id}/feedback`,
			() => {
				fbEditing = false;
				fbChoice = null;
				fbComment = '';
			},
			{ choice: fbChoice, comment: fbChoice && FEEDBACK_ASKS_COMMENT.includes(fbChoice) ? fbComment : '' }
		);
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

<div class="count">
	<span>{filtering ? `${filtered.length} / ` : ''}총 {data.items.length}건{#if unreviewedCount} · 미확인 {unreviewedCount}건{/if}{#if favoriteCount} · 즐겨찾기 {favoriteCount}건{/if}</span>
	<label class="only-unreviewed"><input type="checkbox" bind:checked={onlyUnreviewed} /> 미확인</label>
	<label class="only-unreviewed only-favorite" title="즐겨찾기만 보기"><input type="checkbox" bind:checked={onlyFavorite} aria-label="즐겨찾기만 보기" /><span class="star" class:on={onlyFavorite}>★</span></label>
</div>

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
						{#if unreviewed(i)}<span class="badge bad">미확인</span>{/if}
						{#if i.favorite}<span class="badge fav-star" title="즐겨찾기">★</span>{/if}
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
						{#if a && open.viewed_at}
							<span class="badge viewed" title="이 오답분석을 마지막으로 열 때의 시각">마지막 확인 {formatDateTimeFull(open.viewed_at)}</span>
						{/if}
					</div>
				</div>
				<button class="close" aria-label="닫기" onclick={() => show(null)}>✕</button>
			</header>

			{#if showPhotos}
				<div class="photo-box">
					<img class="photo" src="{base}/api/items/{open.id}/image" alt="오답 사진" />
					{#if !readonly}
						<button
							type="button"
							class="fav-toggle"
							class:on={open.favorite}
							onclick={() => toggleFavorite(open)}
							aria-pressed={!!open.favorite}
							aria-label={open.favorite ? '즐겨찾기 해제' : '즐겨찾기에 추가'}
							title={open.favorite ? '즐겨찾기 해제' : '즐겨찾기에 추가'}
						>★</button>
					{:else if open.favorite}
						<span class="fav-toggle on" title="즐겨찾기">★</span>
					{/if}
				</div>
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
							<li><strong>먼저 알아야 할 것:</strong> <span class="md">{@html renderMath(a.error_analysis.prerequisites.join(' · '))}</span></li>
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

				{#if open.status === 'done' && !readonly}
					{@const done = currentFeedback(open)}
					<section class="feedback">
						<h3 class="band">오답노트 피드백</h3>
						{#if done && !fbEditing}
							<p class="fb-done">
								<span class="badge ok">✓ 확인함</span>
								{FEEDBACK_LABEL[done.choice]}
								<button class="link" disabled={busy} onclick={() => editFeedback(open)}>수정</button>
							</p>
							{#if done.comment}<p class="muted">“{done.comment}”</p>{/if}
						{:else}
							<fieldset class="fb-choices" disabled={busy}>
								<legend class="sr-only">분석에 대한 내 생각</legend>
								{#each FEEDBACK_CHOICES as c (c)}
									<label class="fb-choice" class:on={fbChoice === c}>
										<span class="fb-icon">{FEEDBACK_LABEL[c].split(' ')[0]}</span>
										<span class="fb-text">{FEEDBACK_LABEL[c].split(' ').slice(1).join(' ')}</span>
										<input type="radio" name="feedback" value={c} bind:group={fbChoice} />
									</label>
								{/each}
							</fieldset>
							{#if fbChoice && FEEDBACK_ASKS_COMMENT.includes(fbChoice)}
								<textarea
									class="fb-comment"
									rows="2"
									maxlength={FEEDBACK_COMMENT_MAX}
									placeholder={fbChoice === 'wrong_diagnosis' ? '어느 부분이 다른지 (선택)' : '어려운 부분 (선택)'}
									bind:value={fbComment}
								></textarea>
							{/if}
							<div class="fb-actions">
								<button class="btn primary" disabled={busy || !fbChoice} onclick={() => sendFeedback(open)}>✅ 확인</button>
								{#if done}<button class="btn" disabled={busy} onclick={() => (fbEditing = false)}>취소</button>{/if}
							</div>
						{/if}
					</section>
				{/if}

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
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--muted);
		margin: 12px 2px 8px;
		font-size: 0.9rem;
	}
	.only-unreviewed {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
		white-space: nowrap;
	}
	.only-unreviewed input {
		width: 16px;
		height: 16px;
		margin: 0;
		accent-color: var(--accent);
	}
	.only-favorite .star {
		color: var(--muted);
		font-size: 15px;
		line-height: 1;
	}
	.only-favorite .star.on {
		color: var(--warn);
	}
	.badge.fav-star {
		background: var(--warn-soft);
		color: var(--warn);
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
	.photo-box {
		position: relative;
		margin-bottom: 8px;
	}
	.photo-box .photo {
		margin-bottom: 0;
	}
	.fav-toggle {
		position: absolute;
		top: 8px;
		right: 8px;
		width: 40px;
		height: 40px;
		border-radius: 10px;
		border: 1px solid var(--line);
		background: rgb(255 255 255 / 0.88);
		color: var(--muted);
		font-size: 17px;
		line-height: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		padding: 0;
	}
	.fav-toggle:active {
		transform: scale(0.92);
	}
	.fav-toggle.on {
		color: var(--warn);
		border-color: var(--warn);
		background: var(--warn-soft);
	}
	span.fav-toggle {
		cursor: default;
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
	.btn.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	/* 5개를 폰에서도 한 줄에 가로로 놓는다: 아이콘 · 글자 · 라디오를 세로로 쌓은 칸 */
	.fb-choices {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 6px;
		border: none;
		padding: 0;
		margin: 12px 0 0;
		min-width: 0;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.fb-choice {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		padding: 10px 2px 8px;
		border: 1px solid var(--line);
		border-radius: 12px;
		cursor: pointer;
		text-align: center;
		white-space: nowrap;
	}
	.fb-choice.on {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.fb-icon {
		font-size: 1.3rem;
		line-height: 1;
	}
	.fb-text {
		font-size: 0.8rem;
		font-weight: 600;
	}
	.fb-choice input {
		width: 16px;
		height: 16px;
		margin: 2px 0 0;
		accent-color: var(--accent);
	}
	.fb-comment {
		width: 100%;
		box-sizing: border-box;
		margin-top: 10px;
		padding: 10px 12px;
		border-radius: 12px;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		resize: vertical;
	}
	.fb-actions {
		display: flex;
		gap: 10px;
		margin-top: 12px;
	}
	.fb-done {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.link {
		border: none;
		background: none;
		color: var(--accent);
		font: inherit;
		font-weight: 600;
		text-decoration: underline;
		cursor: pointer;
		padding: 0;
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
		.feedback,
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
