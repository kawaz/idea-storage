import { describe, expect, test } from 'bun:test'
import { parseRecipe, loadRecipes } from './recipe.ts'
import { join } from 'node:path'

const configExamplesDir = join(import.meta.dir, '../../config-examples')

describe('parseRecipe', () => {
  test('parses recipe-diary.md (real file)', async () => {
    const recipe = await parseRecipe(join(configExamplesDir, 'recipe-diary.md'))
    expect(recipe.name).toBe('diary')
    expect(recipe.filePath).toEndWith('recipe-diary.md')
    expect(recipe.match.minLines).toBe(100)
    expect(recipe.match.minAge).toBe(7200)
    expect(recipe.match.project).toBeUndefined()
    expect(recipe.match.maxLines).toBeUndefined()
    expect(recipe.match.requireSessionEnd).toBeUndefined()
    expect(recipe.priority).toBe(0) // default
    expect(recipe.onExisting).toBe('append') // default
    expect(recipe.prompt).toContain('AI日誌を書いてください')
  })

  test('parses recipe-diary-work.md with match.project', async () => {
    const recipe = await parseRecipe(join(configExamplesDir, 'recipe-diary-work.md'))
    expect(recipe.name).toBe('diary-work')
    expect(recipe.match.project).toBe('*/emeradaco/*')
    expect(recipe.match.minLines).toBe(50)
    expect(recipe.priority).toBe(10)
  })

  test('parses recipe-diary-stdout.md with output_mode', async () => {
    const recipe = await parseRecipe(join(configExamplesDir, 'recipe-diary-stdout.md'))
    expect(recipe.name).toBe('diary-stdout')
    expect(recipe.outputMode).toBe('stdout')
    expect(recipe.match.minLines).toBe(100)
    expect(recipe.match.minAge).toBe(7200)
    expect(recipe.priority).toBe(0)
  })

  test('applies default values for missing fields', async () => {
    const recipe = await parseRecipe(join(configExamplesDir, 'recipe-diary.md'))
    expect(recipe.priority).toBe(0)
    expect(recipe.onExisting).toBe('append')
  })

  test('extracts name from filename by removing recipe- prefix and .md suffix', async () => {
    const recipe = await parseRecipe(join(configExamplesDir, 'recipe-diary-work.md'))
    expect(recipe.name).toBe('diary-work')
  })
})

describe('loadRecipes', () => {
  test('loads all recipe-*.md files from directory', async () => {
    const recipes = await loadRecipes(configExamplesDir)
    expect(recipes.length).toBeGreaterThanOrEqual(3)

    const names = recipes.map(r => r.name).sort()
    expect(names).toContain('diary')
    expect(names).toContain('diary-work')
    expect(names).toContain('diary-stdout')
  })

  test('every loaded recipe has required fields', async () => {
    const recipes = await loadRecipes(configExamplesDir)
    for (const recipe of recipes) {
      expect(recipe.name).toBeTruthy()
      expect(recipe.filePath).toBeTruthy()
      expect(typeof recipe.priority).toBe('number')
      expect(recipe.onExisting).toMatch(/^(append|separate|skip)$/)
      expect(recipe.prompt).toBeTruthy()
    }
  })
})
