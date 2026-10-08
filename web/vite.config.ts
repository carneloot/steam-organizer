import { foldkit } from '@foldkit/vite-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	plugins: [foldkit({ devToolsMcpPort: false })],
	server: {
		host: '0.0.0.0',
		port: 5173,
		strictPort: true,
		allowedHosts: ['.onamp.dev'],
		proxy: {
			'/api': {
				target: 'http://localhost:8787',
				changeOrigin: true,
				configure(proxy) {
					proxy.on('proxyReq', (outgoing, incoming) => {
						// Only forward mutations that originated from the development UI.
						const origin = incoming.headers.origin;
						if (origin && new URL(origin).host === incoming.headers.host) {
							outgoing.setHeader('origin', 'http://localhost:8787');
						}
					});
				},
			},
		},
	},
});
