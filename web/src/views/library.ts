import type { HtmlBuilder } from 'foldkit/html';

import { categories, selectGames } from '../../../src/domain/library.js';
import { activeJob, Message, type Model } from '../model.js';
import { controls } from './controls.js';

export const library = (model: Model, html: HtmlBuilder<Message>) => {
	const state = model.state;
	const busy = !!model.pending;
	const locked = busy || activeJob(model);
	const { button, field } = controls(model, html);
	const games = state
		? [...selectGames(state.library, model.search, model.category)]
		: [];
	if (model.sort === 'playtime')
		games.sort(
			(firstGame, secondGame) =>
				secondGame.playtime_forever - firstGame.playtime_forever,
		);
	const selected = state?.library.games.find(
		(game) => game.appid === model.selected,
	);
	return [
		...(model.loading
			? [
					html.section(
						[html.Class('empty'), html.Role('status')],
						[html.h2([], ['Loading your library…'])],
					),
				]
			: !state
				? [
						html.section(
							[html.Class('empty')],
							[
								html.h2([], ['Library unavailable']),
								button('Retry', Message.Reloaded(), busy),
							],
						),
					]
				: !state.library.games.length
					? [
							html.section(
								[html.Class('empty')],
								[
									html.p([html.Class('eyebrow')], ['A CLEAN SHELF']),
									html.h2([], ['Make room for your next game.']),
									html.p(
										[],
										[
											'Import Steam or CLI JSON, or sync your own Steam ID to begin.',
										],
									),
								],
							),
						]
					: !games.length
						? [
								html.section(
									[html.Class('empty')],
									[
										html.h2([], ['No matching games']),
										html.p([], ['Try a different title or category.']),
									],
								),
							]
						: [
								html.div(
									[html.Class('table-wrap')],
									[
										html.table(
											[],
											[
												html.thead(
													[],
													[
														html.tr(
															[],
															['Game', 'Playtime', 'Automatic', 'Tags'].map(
																(label) =>
																	html.th([html.Scope('col')], [label]),
															),
														),
													],
												),
												html.tbody(
													[],
													games.map((game) =>
														html.tr(
															[
																html.Class(
																	game.appid === model.selected
																		? 'row-selected'
																		: '',
																),
															],
															[
																html.td(
																	[],
																	[
																		button(
																			game.name,
																			Message.Selected({
																				appid: game.appid,
																			}),
																			busy,
																			'game-title',
																		),
																		html.small(
																			[],
																			[
																				`#${game.appid} · ${game.reviewed ? 'Reviewed' : 'Not reviewed'}`,
																			],
																		),
																	],
																),
																html.td(
																	[],
																	[
																		`${(game.playtime_forever / 60).toFixed(1)} h`,
																	],
																),
																html.td(
																	[],
																	[
																		categories({
																			...game,
																			tags: [],
																		}).join(' · '),
																	],
																),
																html.td([], [game.tags.join(', ') || '—']),
															],
														),
													),
												),
											],
										),
									],
								),
							]),
		...(selected
			? [
					html.section(
						[html.Class('panel')],
						[
							html.h2([], [selected.name]),
							html.p(
								[],
								[
									'Separate tags with commas. Saving tags does not mark this game reviewed. Automatic playtime categories cannot be edited.',
								],
							),
							html.form(
								[html.OnSubmit(Message.Submitted({ action: 'tags' }))],
								[
									field('tags', 'Tags', locked),
									html.button(
										[
											html.Type('submit'),
											html.Disabled(locked),
											html.Class('primary'),
										],
										['Save tags'],
									),
								],
							),
						],
					),
				]
			: []),
	];
};
