import { Schema } from 'effect';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PlanSnapshot = Schema.Struct({
	resources: Schema.Array(
		Schema.Struct({
			fqn: Schema.String,
			action: Schema.String,
			bindings: Schema.Array(
				Schema.Struct({ sid: Schema.String, action: Schema.String }),
			),
		}),
	),
	actions: Schema.Array(
		Schema.Struct({ fqn: Schema.String, action: Schema.String }),
	),
});

export function renderPlanComment(
	snapshot: typeof PlanSnapshot.Type | null,
	revision: string,
	runUrl: string,
	exitCode: number,
	secretValues: ReadonlyArray<string> = [],
) {
	const secrets = secretValues
		.filter((value) => value.length >= 4)
		.sort((left, right) => right.length - left.length);
	const redact = (value: string) =>
		secrets.reduce(
			(text, secret) => text.split(secret).join('[redacted]'),
			value,
		);
	const escapeCell = (value: string) =>
		redact(value)
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('|', '&#124;')
			.replaceAll('`', '&#96;')
			.replace(/[\r\n]/g, ' ');
	const entries = snapshot
		? [
				...snapshot.resources.flatMap((resource) => [
					{ fqn: resource.fqn, action: resource.action },
					...resource.bindings.map((binding) => ({
						fqn: `${resource.fqn}/${binding.sid}`,
						action: binding.action,
					})),
				]),
				...snapshot.actions,
			]
		: [];
	let body = `<!-- alchemy-production-plan -->\n## Alchemy production plan\n\n${exitCode === 0 && snapshot ? 'Planning succeeded.' : 'Planning failed. No successful plan is available.'}\n\nRevision: \`${redact(revision)}\` · [Workflow run](${redact(runUrl)})\n\n`;
	if (snapshot) {
		body += `**${entries.filter((entry) => entry.action !== 'noop').length} planned changes.**\n\n| Resource or action | Planned action |\n| --- | --- |\n`;
		for (const entry of entries) {
			const row = `| <code>${escapeCell(entry.fqn)}</code> | ${escapeCell(entry.action)} |\n`;
			if (Buffer.byteLength(body + row, 'utf8') > 55_000) {
				body +=
					'\nPlan entries truncated. The GitHub comment size limit was reached.\n';
				break;
			}
			body += row;
		}
	}
	return (
		body +
		'\nThis is a plan, not a deployment. Raw logs and resource properties are not included.\n'
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const {
		PLAN_SNAPSHOT_FILE,
		PLAN_COMMENT_FILE,
		PLAN_SHA,
		PLAN_RUN_URL,
		PLAN_EXIT_CODE,
	} = process.env;
	if (!PLAN_SNAPSHOT_FILE || !PLAN_COMMENT_FILE || !PLAN_SHA || !PLAN_RUN_URL)
		throw new Error('Plan comment paths and revision metadata are required.');
	const snapshot = existsSync(PLAN_SNAPSHOT_FILE)
		? Schema.decodeSync(Schema.fromJsonString(PlanSnapshot))(
				readFileSync(PLAN_SNAPSHOT_FILE, 'utf8'),
			)
		: null;
	const secrets = Object.entries(process.env)
		.filter(([name]) =>
			/API_KEY|AUTH|CREDENTIAL|PASSWORD|PRIVATE|SECRET|TOKEN|ACCESS_EMAILS|ACCOUNT_ID/i.test(
				name,
			),
		)
		.flatMap(([name, value]) =>
			name === 'ACCESS_EMAILS'
				? [
						value ?? '',
						...(value ?? '').split(',').map((email) => email.trim()),
					]
				: [value ?? ''],
		);
	writeFileSync(
		PLAN_COMMENT_FILE,
		renderPlanComment(
			snapshot,
			PLAN_SHA,
			PLAN_RUN_URL,
			Number(PLAN_EXIT_CODE ?? '1'),
			secrets,
		),
	);
}
