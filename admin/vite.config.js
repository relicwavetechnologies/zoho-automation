import path from "path";
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(function (_a) {
    var _b;
    var mode = _a.mode;
    // Local Vite shares the backend-owned environment source. Deployed builds
    // receive the same value at container start through runtime-config.js.
    var backendEnv = loadEnv(mode, path.resolve(__dirname, '../advance-backend'), 'LOGO_DEV_');
    return {
        plugins: [react()],
        define: {
            'import.meta.env.VITE_LOGO_DEV_PUBLISHABLE_KEY': JSON.stringify((_b = backendEnv.LOGO_DEV_PUBLISHABLE_KEY) !== null && _b !== void 0 ? _b : ''),
        },
        resolve: {
            alias: {
                "@": path.resolve(__dirname, "./src"),
            },
        },
        server: {
            port: 5173,
            strictPort: true,
        },
    };
});
