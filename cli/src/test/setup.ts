import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.HAPI_HOME) {
    process.env.HAPI_HOME = mkdtempSync(join(tmpdir(), 'hapi-test-'))
}
