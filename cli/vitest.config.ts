import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

import dotenv from 'dotenv'

const isIntegrationSuite = process.env.HAPI_TEST_SUITE === 'integration'
const testEnv = isIntegrationSuite
    ? dotenv.config({
          path: '.env.integration-test',
      }).parsed
    : undefined

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: ['src/**/*.test.ts'],
        setupFiles: ['src/test/setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '**/*.config.*', '**/mockData/**'],
        },
        env: {
            ...process.env,
            ...(testEnv ?? {}),
        },
    },
    resolve: {
        alias: {
            '@': resolve('./src'),
        },
    },
})
