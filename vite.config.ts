import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
    },

    // Inject env vars so process.env.VITE_APP_ID etc work in src
    define: {
      'process.env.VITE_APP_ID': JSON.stringify(env.VITE_APP_ID || '67985'),
      'process.env.VITE_CLIENT_ID': JSON.stringify(env.VITE_CLIENT_ID || ''),
    },

    plugins: [
      react(),

      VitePWA({
        registerType: "autoUpdate",
        manifest: {
          name: "MILLIEFX TRADING APP",
          short_name: "MILLIEFX",
          theme_color: "#6003d2",
          background_color: "#0108da",
          display: "standalone",
          start_url: "/",
          icons: [
            {
              src: "/logo192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "/logo512.png",
              sizes: "512x512",
              type: "image/png",
            },
          ],
        },
      }),
    ],

    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
