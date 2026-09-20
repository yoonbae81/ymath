import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 테스트용 가짜 claude/codex 실행 파일을 만든다.
 * 넘겨받은 인자·stdin 을 로그 파일(JSON)에 남기고, 동작은 환경변수로 정한다:
 *   FAKE_LOG   로그 파일 경로
 *   FAKE_OUT   돌려줄 JSON 파일 경로
 *   FAKE_MODE  ok(기본) | fenced(코드펜스로 감쌈, codex) | error(오류 + 종료 코드 1) | nooutput(성공하지만 결과 없음)
 *              | response(agy: structured_output 없이 response 본문에만 JSON, 도구 진행 표시 포함) | denied(agy: 도구 권한 거부로 빈 응답)
 */
export function makeFakeCli(kind: 'claude' | 'codex' | 'agy'): string {
	const dir = mkdtempSync(join(tmpdir(), `ymath-fake-${kind}-`));
	const path = join(dir, kind);
	writeFileSync(
		path,
		`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const schemaFile = at('--output-schema') || at('--json-schema');
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({
    args, stdin, cwd: process.cwd(), promptArg: at('-p'),
    schemaAtRun: schemaFile && fs.existsSync(schemaFile) ? JSON.parse(fs.readFileSync(schemaFile, 'utf8')) : null,
  }));
  const mode = process.env.FAKE_MODE || 'ok';
  const out = fs.readFileSync(process.env.FAKE_OUT, 'utf8');
  if (mode === 'error' && ${JSON.stringify(kind)} === 'agy') {
    console.error('agy: authentication required');
    process.exit(1);
  }
  if (mode === 'error') {
    console.error('hook: SessionStart Completed');
    console.error('ERROR: {"type":"error","status":429,"error":{"message":"You have hit your usage limit"}}');
    process.exit(1);
  }
  if (${JSON.stringify(kind)} === 'agy') {
    if (mode === 'denied') {
      console.error('jetski: no output produced — a tool required the "command" permission');
      console.log(JSON.stringify({ status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] }));
    } else if (mode === 'nooutput') {
      console.log(JSON.stringify({ status: 'SUCCESS', response: '' }));
    } else if (mode === 'response') {
      console.log(JSON.stringify({ status: 'SUCCESS', response: JSON.stringify({ ...JSON.parse(out), toolAction: 'Outputting JSON', toolSummary: 'Output JSON' }) }));
    } else {
      console.log(JSON.stringify({ status: 'SUCCESS', response: '본문', structured_output: JSON.parse(out) }));
    }
    return;
  }
  if (${JSON.stringify(kind)} === 'claude') {
    console.log(JSON.stringify({ is_error: false, structured_output: JSON.parse(out), result: 'x' }));
    return;
  }
  if (mode === 'nooutput') return;
  fs.writeFileSync(at('-o'), mode === 'fenced' ? '\`\`\`json\\n' + out + '\\n\`\`\`' : out);
});
`
	);
	chmodSync(path, 0o755);
	return path;
}
