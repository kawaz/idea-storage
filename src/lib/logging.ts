export function log(data: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...data }))
}

export function logError(data: Record<string, unknown>) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...data }))
}
