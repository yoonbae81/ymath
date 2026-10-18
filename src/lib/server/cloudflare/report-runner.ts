/** Node-only report processing. All records arrive from the claimed D1 snapshot. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ItemRecord, Provider, ReportRecord } from '$lib/types';
import { getPeriodRange, isItemInPeriod } from '$lib/types';
import { buildReportPrompt, calculateReportSummary, computeItemsFingerprint } from '../report';
import { loadWorkbooks, promptsDir, renderPrompt, settings } from '../config';
import { loadTaxonomy } from '../taxonomy';
import { runText } from '../llm';
import { formatProblemCells, normalizeWorkbookMentions, problemRefsFrom, stripLeadingTitle } from '$lib/report-links';

export interface ReportFixtureDependencies {
 testOnly: true;
 guideline: string;
 concepts: Record<string,string>;
 publishers: string[];
 runner: (prompt:string,provider:Provider)=>Promise<{text:string;model:string}>;
 now?: Date;
}

export async function generateReportFromSnapshot(input:{report:ReportRecord;records:ItemRecord[];provider?:Provider}, fixture?:ReportFixtureDependencies):Promise<ReportRecord> {
 const { report, records }=input;
 const topics=records.filter(r=>r.status==='done' && r.analysis!==null && r.analysis.classification.topic===report.topic);
 const targets=topics.filter(r=>isItemInPeriod(r.created_at,report.period,fixture?.now));
 if(!targets.length) throw new Error(`'${report.topic}' 영역의 해당 기간에 분석 완료된 오답이 없습니다.`);
 const {start}=getPeriodRange(report.period,fixture?.now);
 const prior=start===null ? [] : topics.filter(r=>new Date(r.created_at).getTime()<start);
 let concepts:Record<string,string>={};
 if(fixture) concepts=fixture.concepts;
 else { try { concepts=Object.fromEntries([...loadTaxonomy().conceptById.values()].map(c=>[c.id,c.desc])); } catch { /* preserve legacy fallback */ } }
 const summary=calculateReportSummary(targets,prior,concepts);
 const raw=fixture?.guideline ?? await readFile(join(promptsDir(),'report.md'),'utf8');
 if(!raw.trim()) throw new Error('report.md 지침 파일이 비어 있습니다');
 const guideline=renderPrompt(raw);
 const prompt=buildReportPrompt({guideline,topic:report.topic,periodLabel:report.period_label,summary,items:targets});
 const provider='omlx';
 const response=fixture ? await fixture.runner(prompt,provider) : await runText(provider,prompt);
 if(!response.text.trim()) throw new Error('보고서 본문이 비어 있습니다');
 let publishers=targets.map(r=>r.workbook.publisher).filter(Boolean);
 if(fixture) publishers=[...publishers,...fixture.publishers];
 else { try { publishers=[...publishers,...loadWorkbooks().map(w=>w.publisher)]; } catch { /* fallback to record publishers */ } }
 const refs=problemRefsFrom(targets);
 const fix=normalizeWorkbookMentions(response.text,refs,publishers);
 const markdown=stripLeadingTitle(formatProblemCells(fix.markdown,refs,publishers));
 return {...report,status:'done',error:null,attempts:report.attempts+1,item_ids:targets.map(r=>r.id),items_fingerprint:computeItemsFingerprint(targets),summary,markdown,meta:{model:response.model,prompt_version:createHash('sha1').update(guideline).digest('hex').slice(0,8),generated_at:(fixture?.now??new Date()).toISOString(),...(fix.corrections.length?{workbook_corrections:fix.corrections.length}:{}),...(fix.stray.length?{stray_workbooks:fix.stray}:{})}};
}
