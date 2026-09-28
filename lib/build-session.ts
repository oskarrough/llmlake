import { relative } from "node:path";
import { Schema } from "effect";
import {
  makeParseContext,
  parseSessionText,
  RowSchema,
  type Agent,
  type ClaudeCrossFileRegistry,
  type Row,
} from "../parse-session.ts";

const validateRow = Schema.validateSync(RowSchema);

// Inline screenshots (codex returns tool images as data URIs) can push one row past duckdb's JSON object cap; parquet keeps a size stub, the source jsonl keeps the bytes. Only payloads over 64 KB: small data URIs are usually content (an inline icon in written HTML) and must survive.
const DATA_IMAGE = /data:(image\/[\w.+-]+);base64,[A-Za-z0-9+/=]{65536,}/g;

export function stripInlineImages(v: unknown): unknown {
  if (typeof v === "string")
    return v.replace(
      DATA_IMAGE,
      (m, mime: string) =>
        `[${mime} ${((m.length * 3) / 4 / 1e6).toFixed(1)} MB]`,
    );
  if (Array.isArray(v)) return v.map(stripInlineImages);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, stripInlineImages(x)]),
    );
  return v;
}

export async function parseSessionRows(args: {
  src: string;
  agent: Agent;
  sessionsRoot: string;
  codexSessionIndex: ReadonlyMap<string, string>;
  claudeCrossFile?: ClaudeCrossFileRegistry;
  sourceFile?: string;
}): Promise<Row[]> {
  const sourceFile = args.sourceFile ?? relative(args.sessionsRoot, args.src);
  const ctx = makeParseContext(
    args.agent,
    sourceFile,
    args.sessionsRoot,
    args.codexSessionIndex,
    args.claudeCrossFile,
  );
  const parsed = await parseSessionText(await Bun.file(args.src).text(), ctx);
  const rows: Row[] = [];
  for (const row of parsed) {
    try {
      rows.push(validateRow(stripInlineImages(row)));
    } catch (cause) {
      throw new Error(
        `row validation failed at ${ctx.sourceFile}:${row.source_line}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }
  }
  return rows;
}
