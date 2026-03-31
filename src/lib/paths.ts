import { join } from 'node:path'

const APP_NAME = 'idea-storage'

function home(): string {
  const h = process.env.HOME
  if (!h) throw new Error('HOME environment variable is not set')
  return h
}

/** $XDG_CONFIG_HOME/idea-storage/ or ~/.config/idea-storage/ */
export function getConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(home(), '.config')
  return `${join(base, APP_NAME)}/`
}

/** $XDG_DATA_HOME/idea-storage/ or ~/.local/share/idea-storage/ */
export function getDataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(home(), '.local', 'share')
  return `${join(base, APP_NAME)}/`
}

/** $XDG_STATE_HOME/idea-storage/ or ~/.local/state/idea-storage/ */
export function getStateDir(): string {
  const base = process.env.XDG_STATE_HOME || join(home(), '.local', 'state')
  return `${join(base, APP_NAME)}/`
}

/** configDir (where recipe-*.md files live) */
export function getRecipesDir(): string {
  return getConfigDir()
}

/** stateDir/queue/ */
export function getQueueDir(): string {
  return `${getStateDir()}queue/`
}

/** stateDir/done/ */
export function getDoneDir(): string {
  return `${getStateDir()}done/`
}

/** stateDir/failed/ */
export function getFailedDir(): string {
  return `${getStateDir()}failed/`
}
