import type { Document, HtmlBuilder } from 'foldkit/html';

import { selectGames } from '../../../src/domain/library.js';
import { activeJob, Message, type Model } from '../model.js';
import { controls } from './controls.js';
import { library } from './library.js';
import { panels } from './panels.js';

export const view = (model: Model, html: HtmlBuilder<Message>): Document => {
	const state = model.state;
	const busy = !!model.pending;
	const { button, open, action, field, check } = controls(model, html);
	const nav = (name: string, label = name) =>
		button(
			`${label}  ${state ? selectGames(state.library, '', name).length : 0}`,
			Message.Changed({ field: 'category', value: name }),
			false,
			model.category === name ? 'nav selected' : 'nav',
		);
	const job = state?.job;
	return {
		title: 'Steam library organizer',
		body: html.div(
			[html.Class('workspace')],
			[
				html.aside(
					[html.Class('sidebar')],
					[
						html.div([html.Class('wordmark')], ['S / O']),
						html.p([html.Class('eyebrow')], ['YOUR COLLECTION']),
						html.h2([], ['Your library']),
						html.nav(
							[html.AriaLabel('Library categories')],
							[
								nav('', 'All games'),
								html.h3([], ['Automatic']),
								...['Unplayed', 'Sampled', 'Played', 'Recently played'].map(
									(categoryName) => nav(categoryName),
								),
								html.h3([], ['Editable tags']),
								...[
									...new Set(
										state?.library.games.flatMap((game) => game.tags) ?? [],
									),
								]
									.sort()
									.map((categoryName) => nav(categoryName)),
							],
						),
						html.div(
							[html.Class('sidebar-footer')],
							[
								html.p([], ['Share the organizer with friends.']),
								html.p(
									[html.Class('muted')],
									[
										'Each authenticated identity has an isolated library, category definitions, and jobs.',
									],
								),
							],
						),
					],
				),
				html.main(
					[],
					[
						html.header(
							[],
							[
								html.div(
									[],
									[
										html.p(
											[html.Class('eyebrow')],
											['STEAM / LIBRARY ORGANIZER'],
										),
										html.h1([], [model.category || 'All games']),
										html.p(
											[html.Class('muted')],
											[
												`${state?.library.games.length ?? 0} games in your collection`,
											],
										),
									],
								),
								html.div(
									[html.Class('actions')],
									[open('import', 'Import'), open('sync', 'Sync Steam')],
								),
							],
						),
						html.div(
							[html.Class('utility')],
							[
								open('criteria', 'Category criteria'),
								open('classify', 'Classify'),
								open('steam-collections', 'Steam memberships'),
								open('restore', 'Restore backup'),
								html.a([html.Href('/api/export?format=json')], ['Export JSON']),
								html.a([html.Href('/api/export?format=csv')], ['Export CSV']),
								html.a([html.Href('/api/backup')], ['Download backup']),
							],
						),
						...(state && !state.configured.sync
							? [
									html.p(
										[html.Class('muted')],
										[
											'Steam sync needs a server API key. Offline imports and category definitions are still available.',
										],
									),
								]
							: []),
						...(state && !state.configured.classify
							? [
									html.p(
										[html.Class('muted')],
										[
											'Classification needs server TypeSafe credentials. Offline imports and category definitions are still available.',
										],
									),
								]
							: []),
						...(model.error
							? [
									html.div(
										[html.Role('alert'), html.Class('feedback error')],
										[
											model.error,
											button('Retry loading', Message.Reloaded(), busy),
										],
									),
								]
							: []),
						...(model.notice
							? [
									html.p(
										[html.Role('status'), html.Class('feedback')],
										[model.notice],
									),
								]
							: []),
						...(job
							? [
									html.section(
										[
											html.Class('job'),
											html.AriaLabel('Classification progress'),
										],
										[
											html.p(
												[html.Role('status')],
												[
													`Classification ${job.status} · ${job.completed} / ${job.total}${job.current ? ` · ${job.current}` : ''}`,
												],
											),
											html.progress([
												html.Max(String(job.total || 1)),
												html.Value(String(job.completed)),
											]),
											...(job.error
												? [html.p([html.Role('alert')], [job.error])]
												: []),
											...(activeJob(model)
												? [
														action(
															'jobs/cancel',
															'Cancel at game boundary',
															busy,
														),
													]
												: []),
											...(job.status === 'failed' ||
											(!activeJob(model) && job.completed < job.total)
												? [
														check(
															'I understand that clearing an uncertain paid lock can cause duplicate charges. Do not do this for an ordinary network retry.',
															model.recoveryConfirmed,
															Message.ToggledRecovery(),
															busy,
														),
														action(
															'classify/recover',
															'Clear uncertain paid lock',
															busy || !model.recoveryConfirmed,
														),
													]
												: []),
										],
									),
								]
							: []),
						...panels(model, html),
						html.div(
							[html.Class('filters')],
							[
								field('search', 'Search games'),
								html.label(
									[],
									[
										'Sort by',
										html.select(
											[
												html.Value(model.sort),
												html.OnChange((value) =>
													Message.Changed({ field: 'sort', value }),
												),
											],
											[
												html.option([html.Value('name')], ['Title A–Z']),
												html.option([html.Value('playtime')], ['Most played']),
											],
										),
									],
								),
							],
						),
						...library(model, html),
						html.footer(
							[],
							[
								'Libraries and category definitions are private to your sign-in. Classification continues after the tab closes.',
							],
						),
					],
				),
			],
		),
	};
};
