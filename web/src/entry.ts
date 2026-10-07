import { Runtime } from 'foldkit';

import { Model, init, update, view, subscriptions } from './main.js';
import './style.css';

Runtime.run(
	Runtime.makeApplication({
		Model,
		init,
		update,
		view,
		subscriptions,
		container: document.getElementById('root'),
	}),
);
