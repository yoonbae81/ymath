import { describe, expect, it } from 'vitest';
import { exec } from './exec';

describe('exec', () => {
	it('표준출력과 종료 코드를 돌려준다', async () => {
		const r = await exec('node', ['-e', 'console.log("안녕"); console.error("e"); process.exit(3)'], { timeoutMs: 5000 });
		expect(r).toMatchObject({ code: 3, stdout: '안녕\n', stderr: 'e\n', timedOut: false });
	});

	it('stdin 으로 입력을 넘긴다', async () => {
		const r = await exec('node', ['-e', 'process.stdin.pipe(process.stdout)'], { input: '긴 프롬프트', timeoutMs: 5000 });
		expect(r.stdout).toBe('긴 프롬프트');
	});

	it('stdin 을 읽지 않고 끝나는 프로세스에서도 죽지 않는다', async () => {
		const r = await exec('node', ['-e', '0'], { input: 'x'.repeat(1_000_000), timeoutMs: 5000 });
		expect(r.code).toBe(0);
	});

	it('시간 초과면 강제 종료하고 timedOut 을 알린다', async () => {
		const r = await exec('node', ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 200 });
		expect(r.timedOut).toBe(true);
	});

	it('없는 명령은 reject', async () => {
		await expect(exec('this-command-does-not-exist', [], { timeoutMs: 1000 })).rejects.toThrow();
	});
});
