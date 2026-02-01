import { describe, expect, test } from 'bun:test'
import { errorMessage, exitWithError } from './errors.ts'

describe('errorMessage', () => {
  test('extracts message from Error instance', () => {
    expect(errorMessage(new Error('something went wrong'))).toBe('something went wrong')
  })

  test('extracts message from Error subclass', () => {
    expect(errorMessage(new TypeError('type error'))).toBe('type error')
  })

  test('converts string to string', () => {
    expect(errorMessage('plain string')).toBe('plain string')
  })

  test('converts number to string', () => {
    expect(errorMessage(42)).toBe('42')
  })

  test('converts null to string', () => {
    expect(errorMessage(null)).toBe('null')
  })

  test('converts undefined to string', () => {
    expect(errorMessage(undefined)).toBe('undefined')
  })

  test('converts object to string', () => {
    expect(errorMessage({ key: 'value' })).toBe('[object Object]')
  })
})

describe('exitWithError', () => {
  test('prints error message from Error to stderr and exits with code 1', () => {
    const originalExit = process.exit
    const originalError = console.error
    let exitCode: number | undefined
    let errorOutput = ''

    process.exit = ((code: number) => { exitCode = code }) as never
    console.error = (msg: string) => { errorOutput = msg }

    try {
      exitWithError(new Error('fatal error'))
    } finally {
      process.exit = originalExit
      console.error = originalError
    }

    expect(exitCode).toBe(1)
    expect(errorOutput).toBe('Error: fatal error')
  })

  test('prints plain string directly', () => {
    const originalExit = process.exit
    const originalError = console.error
    let exitCode: number | undefined
    let errorOutput = ''

    process.exit = ((code: number) => { exitCode = code }) as never
    console.error = (msg: string) => { errorOutput = msg }

    try {
      exitWithError('direct message')
    } finally {
      process.exit = originalExit
      console.error = originalError
    }

    expect(exitCode).toBe(1)
    expect(errorOutput).toBe('Error: direct message')
  })

  test('handles unknown error values', () => {
    const originalExit = process.exit
    const originalError = console.error
    let exitCode: number | undefined
    let errorOutput = ''

    process.exit = ((code: number) => { exitCode = code }) as never
    console.error = (msg: string) => { errorOutput = msg }

    try {
      exitWithError(123)
    } finally {
      process.exit = originalExit
      console.error = originalError
    }

    expect(exitCode).toBe(1)
    expect(errorOutput).toBe('Error: 123')
  })
})
