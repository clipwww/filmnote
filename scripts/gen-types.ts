/**
 * 從資料庫目錄產生 app/types/database.types.ts。
 *
 * 為什麼不用 `supabase gen types`：該指令即使給了 --db-url 仍會啟動一個
 * pg_meta 容器，實測 CLI 2.20 / 2.30 / 2.48 全都要求 Docker。本機沒有 Docker，
 * 而僅僅為了產型別而綁一個容器執行環境並不划算。
 *
 * 產出的形狀對齊 supabase-js 的 GenericSchema：
 *   Tables[T] = { Row, Insert, Update, Relationships }
 *   Views[V]  = { Row, Relationships }
 *   Functions[F] = { Args, Returns }
 *   Enums[E] = 字面值聯集
 *
 * 已知落差（不影響欄位自動完成與 RLS 行為）：
 *   · Views 的 Insert/Update 不產生（本專案的 view 全為唯讀）
 *   · Functions 回傳 setof composite 時以 Record<string, unknown>[] 表示
 *
 *   npm run db:types
 */

import { writeFile } from 'node:fs/promises'
import process from 'node:process'
import { Client } from 'pg'

const OUT = 'app/types/database.types.ts'

interface Col {
  table: string
  kind: string
  column: string
  pg_type: string
  is_nullable: boolean
  has_default: boolean
  is_generated: boolean
  is_identity: boolean
  enum_name: string | null
  dims: number
}

interface Rel {
  table: string
  constraint_name: string
  columns: string[]
  referenced_relation: string
  referenced_columns: string[]
  is_one_to_one: boolean
}

interface Fn { name: string, args: { name: string, type: string, enum_name: string | null }[], returns: string, returns_set: boolean, returns_enum: string | null }

const SCALAR: Record<string, string> = {
  int2: 'number',
  int4: 'number',
  int8: 'number',
  numeric: 'number',
  float4: 'number',
  float8: 'number',
  oid: 'number',
  bool: 'boolean',
  json: 'Json',
  jsonb: 'Json',
  text: 'string',
  varchar: 'string',
  bpchar: 'string',
  char: 'string',
  name: 'string',
  uuid: 'string',
  date: 'string',
  time: 'string',
  timetz: 'string',
  timestamp: 'string',
  timestamptz: 'string',
  interval: 'string',
  bytea: 'string',
  inet: 'string',
  cidr: 'string',
  citext: 'string',
  void: 'undefined',
  record: 'Record<string, unknown>',
}

function tsType(pgType: string, enumName: string | null, dims: number): string {
  const base = enumName
    ? `Database["public"]["Enums"]["${enumName}"]`
    : SCALAR[pgType] ?? 'unknown'
  return dims > 0 ? `${base}${'[]'.repeat(dims)}` : base
}

function quoteKey(k: string): string {
  return /^[A-Z_$][\w$]*$/i.test(k) ? k : JSON.stringify(k)
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('缺少 DATABASE_URL。')
    process.exit(1)
  }
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()

  const { rows: cols } = await db.query<Col>(`
    select c.relname as table,
           case c.relkind when 'r' then 'table' when 'v' then 'view' when 'm' then 'matview' end as kind,
           a.attname as column,
           coalesce(bt.typname, t.typname) as pg_type,
           not a.attnotnull as is_nullable,
           (a.atthasdef and a.attgenerated = '') as has_default,
           (a.attgenerated <> '') as is_generated,
           (a.attidentity <> '') as is_identity,
           case when coalesce(bt.typtype, t.typtype) = 'e' then coalesce(bt.typname, t.typname) end as enum_name,
           case when t.typcategory = 'A' then 1 else 0 end as dims
    from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      join pg_type t on t.oid = a.atttypid
      left join pg_type bt on bt.oid = t.typelem and t.typcategory = 'A'
    where n.nspname = 'public' and c.relkind in ('r','v')
    order by c.relname, a.attnum`)

  const { rows: enums } = await db.query<{ name: string, labels: string[] }>(`
    select t.typname as name, array_agg(e.enumlabel::text order by e.enumsortorder) as labels
    from pg_type t join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' group by t.typname order by t.typname`)

  const { rows: rels } = await db.query<Rel>(`
    select c.conname as constraint_name,
           src.relname as table,
           array_agg(sa.attname::text order by k.ord) as columns,
           tgt.relname as referenced_relation,
           array_agg(ta.attname::text order by k.ord) as referenced_columns,
           coalesce(bool_or(ix.indisunique), false) as is_one_to_one
    from pg_constraint c
      join pg_class src on src.oid = c.conrelid
      join pg_class tgt on tgt.oid = c.confrelid
      join pg_namespace n on n.oid = src.relnamespace
      join lateral unnest(c.conkey, c.confkey) with ordinality as k(scol, tcol, ord) on true
      join pg_attribute sa on sa.attrelid = c.conrelid and sa.attnum = k.scol
      join pg_attribute ta on ta.attrelid = c.confrelid and ta.attnum = k.tcol
      left join pg_index ix on ix.indrelid = c.conrelid and ix.indisunique
        and ix.indkey::int2[] @> c.conkey and c.conkey @> ix.indkey::int2[]
    where c.contype = 'f' and n.nspname = 'public'
    group by c.conname, src.relname, tgt.relname
    order by src.relname, c.conname`)

  const { rows: fns } = await db.query<Fn>(`
    select p.proname as name,
           coalesce((select jsonb_agg(jsonb_build_object(
                       -- proargtypes 是 oidvector（0 起算），proargnames 是一般陣列（1 起算）
                       'name', coalesce(p.proargnames[i + 1], 'arg' || i),
                       'type', at.typname,
                       'enum_name', case when at.typtype = 'e' then at.typname end) order by i)
                     from generate_subscripts(p.proargtypes, 1) as i
                     join pg_type at on at.oid = p.proargtypes[i]), '[]'::jsonb) as args,
           rt.typname as returns,
           p.proretset as returns_set,
           case when rt.typtype = 'e' then rt.typname end as returns_enum
    from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_type rt on rt.oid = p.prorettype
    where n.nspname = 'public' and p.prokind = 'f'
      and rt.typname <> 'trigger'  -- trigger 函式無法經 PostgREST 呼叫
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')
        or has_function_privilege('service_role', p.oid, 'execute'))
    order by p.proname`)

  await db.end()

  const byTable = new Map<string, Col[]>()
  for (const c of cols) {
    if (!byTable.has(c.table))
      byTable.set(c.table, [])
    byTable.get(c.table)!.push(c)
  }
  const relsByTable = new Map<string, Rel[]>()
  for (const r of rels) {
    if (!relsByTable.has(r.table))
      relsByTable.set(r.table, [])
    relsByTable.get(r.table)!.push(r)
  }

  const L: string[] = []
  L.push('// 由 `npm run db:types` 從資料庫目錄產生。請勿手動編輯。')
  L.push('// 產生器：scripts/gen-types.ts（不需要 Docker，見該檔說明）')
  L.push('')
  L.push('export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]')
  L.push('')
  L.push('export interface Database {')
  L.push('  public: {')

  for (const kind of ['table', 'view'] as const) {
    const names = [...byTable.keys()].filter(t => byTable.get(t)![0]!.kind === kind).sort()
    L.push(`    ${kind === 'table' ? 'Tables' : 'Views'}: {`)
    if (!names.length)
      L.push('      [_ in never]: never')
    for (const t of names) {
      const tc = byTable.get(t)!
      L.push(`      ${quoteKey(t)}: {`)
      L.push('        Row: {')
      for (const c of tc)
        L.push(`          ${quoteKey(c.column)}: ${tsType(c.pg_type, c.enum_name, c.dims)}${c.is_nullable ? ' | null' : ''}`)
      L.push('        }')
      if (kind === 'table') {
        L.push('        Insert: {')
        for (const c of tc) {
          if (c.is_generated)
            continue
          const optional = c.is_nullable || c.has_default || c.is_identity
          L.push(`          ${quoteKey(c.column)}${optional ? '?' : ''}: ${tsType(c.pg_type, c.enum_name, c.dims)}${c.is_nullable ? ' | null' : ''}`)
        }
        L.push('        }')
        L.push('        Update: {')
        for (const c of tc) {
          if (c.is_generated)
            continue
          L.push(`          ${quoteKey(c.column)}?: ${tsType(c.pg_type, c.enum_name, c.dims)}${c.is_nullable ? ' | null' : ''}`)
        }
        L.push('        }')
      }
      const rr = relsByTable.get(t) ?? []
      if (!rr.length) {
        L.push('        Relationships: []')
      }
      else {
        L.push('        Relationships: [')
        for (const r of rr) {
          L.push('          {')
          L.push(`            foreignKeyName: ${JSON.stringify(r.constraint_name)}`)
          L.push(`            columns: ${JSON.stringify(r.columns)}`)
          L.push(`            isOneToOne: ${r.is_one_to_one}`)
          L.push(`            referencedRelation: ${JSON.stringify(r.referenced_relation)}`)
          L.push(`            referencedColumns: ${JSON.stringify(r.referenced_columns)}`)
          L.push('          },')
        }
        L.push('        ]')
      }
      L.push('      }')
    }
    L.push('    }')
  }

  L.push('    Functions: {')
  if (!fns.length)
    L.push('      [_ in never]: never')
  for (const f of fns) {
    L.push(`      ${quoteKey(f.name)}: {`)
    if (!f.args.length) {
      L.push('        Args: Record<PropertyKey, never>')
    }
    else {
      L.push('        Args: {')
      for (const a of f.args)
        L.push(`          ${quoteKey(a.name)}: ${tsType(a.type, a.enum_name, 0)}`)
      L.push('        }')
    }
    const base = f.returns === 'record'
      ? 'Record<string, unknown>'
      : tsType(f.returns, f.returns_enum, 0)
    L.push(`        Returns: ${base}${f.returns_set ? '[]' : ''}`)
    L.push('      }')
  }
  L.push('    }')

  L.push('    Enums: {')
  for (const e of enums)
    L.push(`      ${quoteKey(e.name)}: ${e.labels.map(l => JSON.stringify(l)).join(' | ')}`)
  L.push('    }')
  L.push('    CompositeTypes: {')
  L.push('      [_ in never]: never')
  L.push('    }')
  L.push('  }')
  L.push('}')
  L.push('')

  await writeFile(OUT, L.join('\n'), 'utf8')
  console.log(`${OUT}：${byTable.size} 個關聯、${fns.length} 支函式、${enums.length} 個 enum`)
}

await main()
