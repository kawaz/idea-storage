import { join } from 'node:path'
import { getConfigDir } from './paths.ts'
import type { Config } from '../types/index.ts'

function defaultConfig(): Config {
  const home = process.env.HOME ?? '/'
  return {
    claudeDirs: [`${home}/.claude`],
    minAgeMinutes: 120,
    maxAgeMinutes: 10080,
  }
}

export async function loadConfig(): Promise<Config> {
  const defaults = defaultConfig()
  const configPath = join(getConfigDir(), 'config.ts')

  try {
    const file = Bun.file(configPath)
    if (!(await file.exists())) {
      return defaults
    }

    const mod = await import(configPath)
    const userConfig: Partial<Config> = mod.default ?? {}

    return {
      ...defaults,
      ...userConfig,
    }
  } catch {
    return defaults
  }
}
