import { describe, expect, it } from 'vitest';
import { runnerAuthorized } from './runner-auth';

describe('runner authentication', () => {
	it('requires the configured bearer token and rejects missing or wrong credentials', () => {
		expect(runnerAuthorized(new Request('http://local', { headers: { authorization: 'Bearer secret' } }), 'secret')).toBe(true);
		expect(runnerAuthorized(new Request('http://local'), 'secret')).toBe(false);
		expect(runnerAuthorized(new Request('http://local', { headers: { authorization: 'Bearer nope' } }), 'secret')).toBe(false);
		expect(runnerAuthorized(new Request('http://local', { headers: { authorization: 'Bearer secret' } }))).toBe(false);
	});
});
