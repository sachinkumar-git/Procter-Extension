import { defineConfig, loadEnv } from "vite";
import { assertSafeApiUrl } from "./src/api-client.ts";

const envDir = "../..";

export default defineConfig(({ mode }) => {
  // Fails the build rather than shipping an extension that sends over HTTP.
  assertSafeApiUrl(
    loadEnv(mode, envDir).VITE_API_BASE_URL ?? "http://localhost:3000",
  );
  return {
    envDir,
    base: "./",
    build: {
      outDir: "dist",
      emptyOutDir: true,
      modulePreload: false,
      rollupOptions: {
        input: { background: "src/background.ts", popup: "popup.html" },
        output: {
          format: "es",
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name].js",
          assetFileNames: "[name][extname]",
        },
      },
    },
  };
});
