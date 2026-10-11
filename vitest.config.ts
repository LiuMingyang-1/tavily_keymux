import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          CLIENT_TOKENS: JSON.stringify({
            alma: "a".repeat(64),
            hermes: "h".repeat(64),
          }),
          ADMIN_TOKEN: "m".repeat(64),
          TAVILY_API_KEYS: JSON.stringify({
            primary: "tvly-test-primary",
            secondary: "tvly-test-secondary",
          }),
        },
      },
    }),
  ],
  test: { testTimeout: 15_000 },
});
