import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const outdir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ymath-wrangler-check-'));
try {
	const wrangler = new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url);
	const result = spawnSync(process.execPath, [wrangler.pathname, 'deploy', '--dry-run', '--outdir', outdir], {
		cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024
	});
	if (result.status !== 0) throw new Error(`Local Wrangler dry-run failed:\n${result.stdout}\n${result.stderr}`);
	const bundle = await readFile(join(outdir, '_worker.js'), 'utf8');
	const forbidden = [
		[/node_modules\/sharp|@img\/sharp|sharp\.mjs|(?:from\s*|import\s*\()\s*["']sharp["']/, 'sharp/native image processing'],
		[/(?:from\s*|import\s*\()\s*["'](?:node:)?(?:fs|path|os)(?:\/[^"']*)?["']/, 'Node filesystem/path imports'],
		[/(?:from\s*|import\s*\()\s*["'](?:node:)?child_process["']|node-built-in-modules:child_process/, 'child_process/CLI imports'],
		[/\b(?:writeFileSync|writeFile|appendFileSync|mkdirSync|rmSync)\s*\(/, 'filesystem writes'],
		[/(?:^|[/'"])[^'"\s]+\.(?:node|dylib|so)(?:["'\s]|$)|@img\//, 'native addon']
	];
	const violations = forbidden.filter(([pattern]) => pattern.test(bundle)).map(([, label]) => label);
	if (violations.length) throw new Error(`Actual Wrangler Worker bundle contains Node-only dependencies: ${violations.join(', ')}`);
	console.log('Worker runtime boundary PASS: complete Wrangler dry-run bundle has no sharp, Node filesystem, CLI, permanent-write, or native-addon code');
} finally {
	await rm(outdir, { recursive: true, force: true });
}
