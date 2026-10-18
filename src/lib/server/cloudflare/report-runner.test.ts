import { describe, expect, it, vi } from 'vitest';
import type { ItemRecord, ReportRecord } from '$lib/types';
import { validAnalysis } from '../analysis.fixture';
import { computeItemsFingerprint } from '../report';
import { generateReportFromSnapshot } from './report-runner';

const wb={id:'ssen-m3-2',name:'쎈 중3-2',publisher:'쎈',grade:'중3',semester:2};
function item(id:string,at:string):ItemRecord {
 const analysis=validAnalysis(); analysis.problem.number_guess='0255';
 return {schema_version:1,id,created_at:at,status:'done',error:null,attempts:1,workbook:wb,image:'image.jpg',flags:{ocr_missing:false,taxonomy_mismatch:[],guardrail:[]},analysis:analysis as ItemRecord['analysis'],meta:{provider:'omlx',model:'TEST-ONLY',prompt_version:'fixture',analyzed_at:at}};
}
const report:ReportRecord={schema_version:1,id:'20261017-080000-rep-abcd',created_at:'2026-10-17T08:00:00Z',topic:'대수',period:'2026-10',period_label:'2026-10',status:'queued',error:null,attempts:0,item_ids:[],items_fingerprint:'',summary:null,markdown:null,meta:null};
const fixture={testOnly:true as const,guideline:'# TEST-ONLY {{STUDENT_NAME}}',concepts:{'ALG-EXPANSION':'곱셈공식'},publishers:['쎈'],now:new Date('2026-10-17T09:00:00Z')};
describe('Node report from claimed D1 snapshot',()=>{
 it('preserves topic/period/prior recurrence/fingerprint and normalizes workbook mentions',async()=>{
  const current=item('20261003-080000-abcd','2026-10-03T08:00:00Z'),prior=item('20260930-080000-abcd','2026-09-30T08:00:00Z');
  const runner=vi.fn(async()=>({text:'# TEST-ONLY title\n\n| 문제 | 진단 |\n|---|---|\n| 0255 · 쎈 중3-1 | 확인 |',model:'TEST-ONLY fixture'}));
  const result=await generateReportFromSnapshot({report,records:[current,prior],provider:'omlx'},{...fixture,runner});
  expect(result.status).toBe('done'); expect(result.item_ids).toEqual([current.id]);
  expect(result.items_fingerprint).toBe(computeItemsFingerprint([current]));
  expect(result.summary?.recurrent_patterns[0]).toMatchObject({current_count:1,prior_count:1,trend:'유지'});
  expect(result.markdown).toContain('쎈 중3-2<br/>0255'); expect(result.markdown).not.toContain('# TEST-ONLY title');
  expect(result.meta).toMatchObject({model:'TEST-ONLY fixture',workbook_corrections:1,generated_at:fixture.now.toISOString()});
  expect(runner.mock.calls[0]).toBeDefined(); expect(report.status).toBe('queued');
 });
 it('rejects empty target without calling configured runner',async()=>{
  const runner=vi.fn(); await expect(generateReportFromSnapshot({report,records:[],provider:'omlx'},{...fixture,runner})).rejects.toThrow('오답'); expect(runner).not.toHaveBeenCalled();
 });
 it('propagates provider errors for durable retry rather than fake success',async()=>{
  await expect(generateReportFromSnapshot({report,records:[item('20261003-080000-abcd','2026-10-03T08:00:00Z')],provider:'omlx'},{...fixture,runner:async()=>{throw new Error('429 TEST-ONLY');}})).rejects.toThrow('429 TEST-ONLY');
 });
});
