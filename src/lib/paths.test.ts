import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { getConfigDir, getDataDir, getStateDir, getRecipesDir, getQueueDir, getDoneDir, getFailedDir } from './paths.ts'

describe('paths', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.XDG_CONFIG_HOME
    delete process.env.XDG_DATA_HOME
    delete process.env.XDG_STATE_HOME
  })

  afterEach(() => {
    process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME
    process.env.XDG_DATA_HOME = originalEnv.XDG_DATA_HOME
    process.env.XDG_STATE_HOME = originalEnv.XDG_STATE_HOME
  })

  describe('getConfigDir', () => {
    test('uses XDG_CONFIG_HOME when set', () => {
      process.env.XDG_CONFIG_HOME = '/tmp/test-config'
      expect(getConfigDir()).toBe('/tmp/test-config/idea-storage/')
    })

    test('falls back to ~/.config/ when XDG_CONFIG_HOME is not set', () => {
      const home = process.env.HOME
      expect(getConfigDir()).toBe(`${home}/.config/idea-storage/`)
    })
  })

  describe('getDataDir', () => {
    test('uses XDG_DATA_HOME when set', () => {
      process.env.XDG_DATA_HOME = '/tmp/test-data'
      expect(getDataDir()).toBe('/tmp/test-data/idea-storage/')
    })

    test('falls back to ~/.local/share/ when XDG_DATA_HOME is not set', () => {
      const home = process.env.HOME
      expect(getDataDir()).toBe(`${home}/.local/share/idea-storage/`)
    })
  })

  describe('getStateDir', () => {
    test('uses XDG_STATE_HOME when set', () => {
      process.env.XDG_STATE_HOME = '/tmp/test-state'
      expect(getStateDir()).toBe('/tmp/test-state/idea-storage/')
    })

    test('falls back to ~/.local/state/ when XDG_STATE_HOME is not set', () => {
      const home = process.env.HOME
      expect(getStateDir()).toBe(`${home}/.local/state/idea-storage/`)
    })
  })

  describe('getRecipesDir', () => {
    test('returns configDir/recipes/', () => {
      process.env.XDG_CONFIG_HOME = '/tmp/test-config'
      expect(getRecipesDir()).toBe('/tmp/test-config/idea-storage/recipes/')
    })
  })

  describe('getQueueDir', () => {
    test('returns stateDir/queue/', () => {
      process.env.XDG_STATE_HOME = '/tmp/test-state'
      expect(getQueueDir()).toBe('/tmp/test-state/idea-storage/queue/')
    })
  })

  describe('getDoneDir', () => {
    test('returns stateDir/done/', () => {
      process.env.XDG_STATE_HOME = '/tmp/test-state'
      expect(getDoneDir()).toBe('/tmp/test-state/idea-storage/done/')
    })
  })

  describe('getFailedDir', () => {
    test('returns stateDir/failed/', () => {
      process.env.XDG_STATE_HOME = '/tmp/test-state'
      expect(getFailedDir()).toBe('/tmp/test-state/idea-storage/failed/')
    })
  })

  describe('trailing slash consistency', () => {
    test('all directory paths end with /', () => {
      process.env.XDG_CONFIG_HOME = '/tmp/c'
      process.env.XDG_DATA_HOME = '/tmp/d'
      process.env.XDG_STATE_HOME = '/tmp/s'

      expect(getConfigDir()).toEndWith('/')
      expect(getDataDir()).toEndWith('/')
      expect(getStateDir()).toEndWith('/')
      expect(getRecipesDir()).toEndWith('/')
      expect(getQueueDir()).toEndWith('/')
      expect(getDoneDir()).toEndWith('/')
      expect(getFailedDir()).toEndWith('/')
    })
  })
})
