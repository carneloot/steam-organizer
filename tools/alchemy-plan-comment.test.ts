import { expect, it } from 'vitest';

import { renderPlanComment } from './alchemy-plan-comment.js';

const snapshot = {
	resources: [
		{ fqn: 'Library', action: 'create', bindings: [] },
		{
			fqn: 'Web',
			action: 'noop',
			bindings: [{ sid: 'Access', action: 'update' }],
		},
	],
	actions: [{ fqn: 'Web/Build', action: 'run' }],
};
it('summarizes resources, bindings, and build actions without counting noops', () => {
	const body = renderPlanComment(
		snapshot,
		'abc123',
		'https://example.test/run',
		0,
	);
	expect(body).toContain('<!-- alchemy-production-plan -->');
	expect(body).toContain('Planning succeeded.');
	expect(body).toContain('**3 planned changes.**');
	expect(body).toContain('| <code>Web/Access</code> | update |');
	expect(body).toContain('| <code>Web</code> | noop |');
	expect(body).toContain('| <code>Web/Build</code> | run |');
	expect(body).toContain('Revision: `abc123`');
});
it('reports failure without implying a successful empty plan', () => {
	const body = renderPlanComment(null, 'abc123', 'https://example.test/run', 1);
	expect(body).toContain('Planning failed.');
	expect(body).not.toContain('planned changes');
	expect(body).not.toContain('Planning succeeded.');
});
it('redacts secrets before escaping names and excludes resource properties', () => {
	const planWithProperties = {
		resources: [
			{
				fqn: 'Web/<private-token>|`\nfriend@example.test',
				action: 'create',
				bindings: [],
				props: { sensitive: 'do-not-publish' },
			},
		],
		actions: [],
	};
	const body = renderPlanComment(
		planWithProperties,
		'abc123',
		'https://example.test/run',
		0,
		['<private-token>', 'friend@example.test'],
	);
	expect(body).not.toContain('private-token');
	expect(body).not.toContain('friend@example.test');
	expect(body).not.toContain('do-not-publish');
	expect(body).toContain('[redacted]&#124;&#96; [redacted]');
});
it('bounds UTF-8 comment size without cutting multibyte text', () => {
	const body = renderPlanComment(
		{
			resources: [],
			actions: Array.from({ length: 500 }, (_, index) => ({
				fqn: `Build${index}/${'界'.repeat(100)}`,
				action: 'run',
			})),
		},
		'abc123',
		'https://example.test/run',
		0,
	);
	expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(60_000);
	expect(body).toContain('Plan entries truncated.');
	expect(body).not.toContain('\uFFFD');
	expect(body).toContain('**500 planned changes.**');
});
it('applies the size limit after redaction expands short secrets', () => {
	const body = renderPlanComment(
		{
			resources: [],
			actions: Array.from({ length: 500 }, () => ({
				fqn: 'tiny'.repeat(100),
				action: 'run',
			})),
		},
		'abc123',
		'https://example.test/run',
		0,
		['tiny'],
	);
	expect(body).not.toContain('tiny');
	expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(60_000);
	expect(body).toContain('Plan entries truncated.');
});
