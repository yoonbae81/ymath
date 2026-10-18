export function runnerAuthorized(request: Request, token?: string): boolean {
	if (!token) return false;
	const actual = request.headers.get('authorization') ?? '';
	const expected = `Bearer ${token}`;
	let diff = actual.length ^ expected.length;
	for (let i = 0; i < Math.max(actual.length, expected.length); i++) diff |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
	return diff === 0;
}
