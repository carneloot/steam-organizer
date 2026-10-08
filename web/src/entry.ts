import { Runtime } from 'foldkit';

import { Model } from './model.js';
import { subscriptions } from './subscriptions.js';
import { init, update } from './update.js';
import { view } from './views/view.js';
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
