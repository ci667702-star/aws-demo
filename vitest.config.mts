import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "e2e/**", "legacy-cra/**"],
    setupFiles: ["./tests/setup.ts"],
    restoreMocks: true,
    // jsdom UI 테스트는 여러 화면을 렌더링하므로, 전체를 병렬로 돌릴 때 기본 5초를 넘을 수 있다
    testTimeout: 15_000,
  },
});
