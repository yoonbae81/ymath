/** Replaced by Vite so the Worker build can remove the complete Node fallback graph. */
import { error } from '@sveltejs/kit';

export const NODE_RUNTIME = __YMATH_NODE_RUNTIME__;

export function requireWorkerDatabase(platform: { env?: { DB?: unknown } } | undefined, nodeRuntime = NODE_RUNTIME): void {
	if (!nodeRuntime && !platform?.env?.DB) error(503, '데이터베이스에 연결할 수 없습니다');
}
