import { defineConfig } from "tsup"

export default defineConfig([
    {
        // Browser-safe entry: no Node.js built-ins, no tiktoken
        entry: { index: "src/index.ts" },
        format: ["esm"],
        dts: true,
        clean: false,
        sourcemap: true,
        splitting: false,
        treeshake: true,
        target: "es2022",
        platform: "browser",
        external: ["xstate", "zod"],
        esbuildOptions(options) {
            options.conditions = ["browser", "import", "module"]
        },
    },
    {
        // Node-only entry: tiktoken, fs utilities
        entry: { node: "src/node.ts" },
        format: ["esm"],
        dts: true,
        clean: false,
        sourcemap: true,
        splitting: false,
        treeshake: true,
        target: "es2022",
        platform: "node",
        external: ["xstate", "zod"],
        esbuildOptions(options) {
            options.conditions = ["node", "import", "module"]
        },
    },
])
