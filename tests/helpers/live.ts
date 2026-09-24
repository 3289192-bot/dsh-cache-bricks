/**
 * Authentication for the live test helpers.
 *
 * The plugin route runs the harness's own request policy, so an unauthenticated
 * call is refused exactly like `/api` would refuse it. A test that talks to a
 * running instance therefore has to do what the browser does: exchange the
 * launcher's single-use token (printed in the newest web log) for the
 * authority-bound session cookie.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Cookie header for a running instance, or undefined when it cannot be obtained. */
export async function liveCookie(base: string, home: string): Promise<string | undefined> {
  let token: string | undefined
  try {
    const dir = join(home, 'logs')
    const files = readdirSync(dir)
      .filter((name) => /^web-.*\.out\.log$/u.test(name))
      .sort((left, right) => statSync(join(dir, right)).mtimeMs - statSync(join(dir, left)).mtimeMs)
    if (files.length > 0) {
      token = /token=([A-Za-z0-9_-]+)/u.exec(readFileSync(join(dir, files[0]!), 'utf8'))?.[1]
    }
  } catch {
    return undefined
  }
  if (token === undefined) return undefined
  try {
    const response = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
    const jar = (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
    return jar === '' ? undefined : jar
  } catch {
    return undefined
  }
}

/** GET JSON from a plugin route with the live cookie attached. */
export async function liveGet(base: string, path: string, cookie: string | undefined): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  })
  return response.ok ? await response.json() : undefined
}
