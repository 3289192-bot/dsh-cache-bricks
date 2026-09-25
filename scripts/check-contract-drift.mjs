// Contract-drift check across the historical 0.1.6 core and supported rc.2 core.
//
// This historical comparison records whether the client's referenced members
// remained compatible across the two cores:
// a member the OLDER core has and the NEWER one dropped would break the fork
// on that core. Additive differences (a newer core adding optional members)
// are fine and reported as such.
//
//   node scripts/check-contract-drift.mjs [newerRuntimeDir] [olderRuntimeDir]
//
// Defaults follow the current user's DSH home and global npm directories.
// Exit code 1 means a member was removed between the two cores.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [newerRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh-017'), 'runtime', 'node_modules'), olderRoot = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')] = process.argv.slice(2)

/** Contract files this plugin's client half depends on, and the members it uses. */
const TARGETS = [
  {
    label: 'conversation',
    file: ['@deepseek-ai/dsh-client-ui-conversation', 'lib/types/client/contract/conversation.d.ts'],
    members: ['ConversationNodeDefinition', 'ConversationNodeContext', 'ConversationViewNode', 'ConversationMatch', 'ConversationPublication'],
  },
  {
    label: 'chat-nodes',
    file: ['@deepseek-ai/dsh-client-ui-chat', 'lib/types/client/contract/chat-nodes.d.ts'],
    members: ['ChatConversationViewNode', 'ChatNodeDataMap'],
  },
]

/** Strip comments and blank lines so only declarations are compared. */
function significant(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('*') && !line.startsWith('/*') && !line.startsWith('//'))
}

/** Body of one `interface X {` / `export type X =` / `export interface X {` block. */
function memberBlock(lines, member) {
  const start = lines.findIndex((line) => new RegExp(`(interface|type)\\s+${member}\\b`).test(line))
  if (start === -1) return undefined
  const body = []
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    body.push(line)
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (i > start && depth <= 0) break
  }
  return body
}

let removed = 0
for (const target of TARGETS) {
  const newer = significant(readFileSync(join(newerRoot, ...target.file), 'utf8'))
  const older = significant(readFileSync(join(olderRoot, ...target.file), 'utf8'))
  console.log(`\n=== ${target.label} (${target.file[0]}) ===`)
  for (const member of target.members) {
    const a = memberBlock(newer, member)
    const b = memberBlock(older, member)
    if (a === undefined || b === undefined) {
      console.log(`  ${member}: MISSING in ${a === undefined ? 'newer' : 'older'} core`)
      removed += 1
      continue
    }
    const onlyNewer = a.filter((line) => !b.includes(line))
    const onlyOlder = b.filter((line) => !a.includes(line))
    if (onlyNewer.length === 0 && onlyOlder.length === 0) {
      console.log(`  ${member}: identical`)
      continue
    }
    if (onlyOlder.length > 0) {
      removed += onlyOlder.length
      console.log(`  ${member}: ${onlyOlder.length} member(s) present ONLY in the older core (breaking):`)
      for (const line of onlyOlder) console.log(`      - ${line}`)
    }
    if (onlyNewer.length > 0) {
      console.log(`  ${member}: +${onlyNewer.length} optional member(s) only in the newer core (compatible)`)
    }
  }
}

console.log(removed === 0
  ? '\nOK: no contract member was dropped between the two cores.'
  : `\nFAIL: ${removed} member(s) dropped between the cores; adapt src/client before shipping one bundle.`)
process.exit(removed === 0 ? 0 : 1)
