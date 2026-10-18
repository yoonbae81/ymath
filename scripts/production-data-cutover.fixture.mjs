import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'ymath-cutover-'));
 const source=join(root,'source'),id='20261017-080000-abcd',reportId='20261017-080001-rep-abcd';
 await mkdir(join(source,'items',id),{recursive:true}); await mkdir(join(source,'reports'));
 const workbook={id:'fixture',name:'Fixture',publisher:'P',grade:'중2',semester:2};
 const record={schema_version:1,id,status:'done',created_at:'2026-10-17T08:00:00Z',image:'image.jpg',workbook,analysis:{asks:'TEST ONLY'},meta:{provider:'codex',analyzed_at:'2026-10-17T08:01:00Z'},flags:{},feedback:[]};
 await writeFile(join(source,'items',id,'record.json'),JSON.stringify(record));
 await writeFile(join(source,'items',id,'image.jpg'),Buffer.from([255,216,255,0,1,2]));
 await writeFile(join(source,'items',id,'ocr.md'),'TEST ONLY OCR');
 await writeFile(join(source,'items',id,'analysis-codex.json'),JSON.stringify({analysis:record.analysis,meta:record.meta,flags:record.flags}));
 await writeFile(join(source,'reports',reportId+'.json'),JSON.stringify({id:reportId,status:'done',created_at:record.created_at,item_ids:[id],markdown:'TEST ONLY REPORT'}));
 await writeFile(join(source,'session-secret'),'MUST NEVER BE COPIED');
 const workbooks=join(root,'workbooks.json');
 await writeFile(workbooks,JSON.stringify({publisherOrder:['P'],workbooks:[{...workbook,id:'older',grade:'고1'},workbook]}));
 return {root,source,workbooks,id,reportId,record,snapshot:join(root,'snapshot'),backup:join(root,'backup')};
}

