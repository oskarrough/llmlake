import { relative } from 'node:path'
import { Schema } from 'effect'
import {
  makeParseContext,
  parseSessionText,
  RowSchema,
  type Agent,
  type ClaudeCrossFileRegistry,
  type Row,
} from '../parse-session.ts'

const validateRow = Schema.validateSync(RowSchema)

export async function parseSessionRows(args: {
  src: string
  agent: Agent
  sessionsRoot: string
  codexSessionIndex: ReadonlyMap<string, string>
  claudeCrossFile?: ClaudeCrossFileRegistry
  sourceFile?: string
}): Promise<Row[]> {
  const sourceFile = args.sourceFile ?? relative(args.sessionsRoot, args.src)
  const ctx = makeParseContext(
    args.agent,
    sourceFile,
    args.sessionsRoot,
    args.codexSessionIndex,
    args.claudeCrossFile,
  )
  const parsed = await parseSessionText(await Bun.file(args.src).text(), ctx)
  const rows: Row[] = []
  for (const row of parsed) {
    try {
      rows.push(validateRow(row))
    } catch (cause) {
      throw new Error(
        `row validation failed at ${ctx.sourceFile}:${row.source_line}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      )
    }
  }
  return rows
}
