import { describe, expect, test } from 'bun:test'
import { errorMessage, exitWithError, CliError } from './errors.ts'

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

describe('CliError', () => {
  test('is an instance of Error', () => {
    const err = new CliError('something went wrong')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(CliError)
  })

  test('has name CliError', () => {
    const err = new CliError('test')
    expect(err.name).toBe('CliError')
  })

  test('has message', () => {
    const err = new CliError('something went wrong')
    expect(err.message).toBe('something went wrong')
  })

  test('has exitCode property defaulting to 1', () => {
    const err = new CliError('test')
    expect(err.exitCode).toBe(1)
  })

  test('accepts custom exitCode', () => {
    const err = new CliError('test', 2)
    expect(err.exitCode).toBe(2)
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
