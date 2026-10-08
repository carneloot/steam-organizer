import type { HtmlBuilder } from 'foldkit/html';

import { selectGames } from '../../../src/domain/library.js';
import { activeJob, Message, type Model } from '../model.js';
import { controls } from './controls.js';

export const panels = (model: Model, html: HtmlBuilder<Message>) => {
	const state = model.state;
	const busy = !!model.pending;
	const locked = busy || activeJob(model);
	const { open, action, field, textarea, check, confirm, file } = controls(
		model,
		html,
	);
	const games = state
		? selectGames(state.library, model.search, model.category)
		: [];
	const titles: Record<string, string> = {
		import: 'Import Steam or CLI JSON',
		restore: 'Restore a library backup',
		sync: 'Sync your Steam library',
		criteria: 'Category definitions',
		collections: 'Import collection names as definitions',
		'steam-collections': 'Import Steam collection memberships',
		classify: 'Classify games',
	};
	const panel = model.panel;
	const panelContent =
		panel === 'criteria'
			? [
					html.p(
						[],
						[
							`Category definitions are saved privately for ${state?.library.steamId ? `Steam ID ${state.library.steamId}` : 'this offline library'}, under your sign-in. They follow this library across browsers. Unsaved drafts stay in this tab.`,
						],
					),
					html.p(
						[html.Class('muted')],
						[
							'Use a JSON object mapping category names to nonempty descriptions, for example { "Cozy": "Relaxing games without time pressure." }. Automatic playtime categories cannot be edited.',
						],
					),
					file(),
					textarea('criteria', 'Category names and descriptions'),
					action('criteria', 'Save criteria', locked || !state),
					action('download-criteria', 'Download criteria JSON', busy),
					open('collections', 'Import collection names'),
				]
			: panel === 'sync'
				? [
						field('steamId', 'Your 17-digit Steam ID', locked),
						html.p(
							[],
							[
								'Everyone enters their own Steam ID. API keys stay on the server.',
							],
						),
						confirm(
							'Replace my library with my owned Steam games. Matching tags are preserved.',
						),
						action(
							'sync',
							'Sync Steam library',
							locked || !model.confirmed || !state?.configured.sync,
						),
					]
				: panel === 'classify'
					? [
							html.p(
								[],
								[
									`Scope: ${games.length} matching games. Only unreviewed games are included by default. Saved category definitions are snapshotted when you start. One game runs at a time.`,
								],
							),
							html.p(
								[html.Class('muted')],
								[
									'Classification continues on the server after this tab closes. Reopen to see saved progress. Failed runs do not retry paid work automatically.',
								],
							),
							check(
								'Include reviewed games. Reclassification may incur another charge.',
								model.all,
								Message.ToggledAll(),
							),
							confirm(
								'Send game names and descriptions for paid TypeSafe classification. Charges may apply.',
							),
							action(
								'classify',
								'Start classification',
								locked || !model.confirmed || !state?.configured.classify,
							),
						]
					: panel
						? [
								file(),
								textarea('text', 'JSON contents'),
								html.p(
									[],
									[
										panel === 'collections' || panel === 'steam-collections'
											? 'Steam file: userdata/<account-id>/config/cloudstorage/cloud-storage-namespace-1.json. Dynamic filters cannot be reconstructed.'
											: 'Accepts Steam GetOwnedGames JSON, raw game arrays, CLI Library files, and CLI export JSON. CLI tags and review flags are preserved.',
									],
								),
								...(panel === 'collections'
									? [
											html.p(
												[],
												[
													'Names become an editable local draft only. No library games or tags change.',
												],
											),
											action(panel, 'Load editable draft', busy),
										]
									: [
											confirm(
												panel === 'steam-collections'
													? 'Attach static memberships as tags to matching existing games only. Do not replace the library or create unknown games.'
													: 'Replace the library and remove games absent from this file. Imported tags and review flags are preserved.',
											),
											action(
												panel,
												panel === 'steam-collections'
													? 'Attach memberships'
													: 'Confirm import',
												locked || !model.confirmed,
											),
										]),
							]
						: [];
	return panel
		? [
				html.section(
					[html.Class('panel')],
					[
						html.div(
							[html.Class('panel-heading')],
							[html.h2([], [titles[panel] ?? panel]), open('', 'Close panel')],
						),
						html.form(
							[
								html.Class('panel-fields'),
								html.OnSubmit(Message.Submitted({ action: panel })),
							],
							panelContent,
						),
					],
				),
			]
		: [];
};
