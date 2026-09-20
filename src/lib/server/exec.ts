import { spawn } from 'node:child_process';

export interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface ExecOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** stdin 으로 넘길 내용. 없으면 stdin 을 닫는다. */
	input?: string;
	timeoutMs: number;
}

/** 외부 명령을 실행한다. 시간 초과면 SIGKILL 하고 timedOut 으로 알린다. 실행 파일이 없으면 reject. */
export function exec(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, opts.timeoutMs);

		child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
		child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		});
		// 자식이 stdin 을 읽지 않고 끝나면 EPIPE 가 나므로 무시한다
		child.stdin.on('error', () => {});
		child.stdin.end(opts.input ?? '');
	});
}
