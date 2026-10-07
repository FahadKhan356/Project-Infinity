/**
 * Guards the one thing that can silently rot: the SQL under drizzle/ is the
 * source of truth, src/db/schema.ts is a hand-written mirror of it. These
 * tests fail the build if they disagree.
 *
 * Every migration is read, not just the first, so a table added in a later
 * migration is held to the same standard.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- libpg-query ships no
   types for the PostgreSQL parse tree; the node shapes read below are
   documented in the libpg_query protobuf, not in TypeScript. */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, before, describe } from 'node:test';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as pgQuery from 'libpg-query';
import * as schema from '../src/db/schema';

type SqlTable = { name: string; columns: Set<string> };
type Fk = { table: string; cols: string[]; refTable: string; refCols: string[] };

const sqlTables = new Map<string, SqlTable>();
const uniques = new Map<string, Set<string>>();
const foreignKeys: Fk[] = [];

const addUnique = (table: string, cols: string[]) => {
  if (!cols.length) return;
  if (!uniques.has(table)) uniques.set(table, new Set());
  uniques.get(table)!.add(cols.join(','));
};

before(async () => {
  await pgQuery.loadModule();
  const dir = path.join(process.cwd(), 'drizzle');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length > 0, 'no migrations found');

  const ddl = (
    await Promise.all(files.map((f) => readFile(path.join(dir, f), 'utf8')))
  ).join('\n');
  const { stmts } = await pgQuery.parse(ddl);

  for (const { stmt } of stmts as any[]) {
    if (stmt.CreateStmt) {
      const name = stmt.CreateStmt.relation.relname;
      const columns = new Set<string>();
      for (const el of stmt.CreateStmt.tableElts ?? []) {
        if (el.ColumnDef) {
          const col = el.ColumnDef.colname;
          columns.add(col);
          for (const { Constraint: c } of el.ColumnDef.constraints ?? []) {
            if (c?.contype === 'CONSTR_UNIQUE' || c?.contype === 'CONSTR_PRIMARY') addUnique(name, [col]);
            if (c?.contype === 'CONSTR_FOREIGN') {
              foreignKeys.push({
                table: name, cols: [col],
                refTable: c.pktable.relname,
                refCols: (c.pk_attrs ?? []).map((a: any) => a.String.sval),
              });
            }
          }
        }
        if (el.Constraint) {
          const c = el.Constraint;
          if (c.contype === 'CONSTR_UNIQUE' || c.contype === 'CONSTR_PRIMARY') {
            addUnique(name, (c.keys ?? []).map((a: any) => a.String.sval));
          }
          if (c.contype === 'CONSTR_FOREIGN') {
            foreignKeys.push({
              table: name,
              cols: (c.fk_attrs ?? []).map((a: any) => a.String.sval),
              refTable: c.pktable.relname,
              refCols: (c.pk_attrs ?? []).map((a: any) => a.String.sval),
            });
          }
        }
      }
      sqlTables.set(name, { name, columns });
    }

    if (stmt.IndexStmt?.unique && !stmt.IndexStmt.whereClause) {
      const cols = (stmt.IndexStmt.indexParams ?? [])
        .map((p: any) => p.IndexElem?.name)
        .filter(Boolean);
      addUnique(stmt.IndexStmt.relation.relname, cols);
    }

    for (const cmd of stmt.AlterTableStmt?.cmds ?? []) {
      const table = stmt.AlterTableStmt.relation.relname;
      const alter = cmd.AlterTableCmd;

      // Later migrations change tables as often as they create them, so the
      // mirror has to be held to those too.
      if (alter?.subtype === 'AT_AddColumn' && alter.def?.ColumnDef) {
        const column = alter.def.ColumnDef;
        sqlTables.get(table)?.columns.add(column.colname);
        for (const { Constraint: cc } of column.constraints ?? []) {
          if (cc?.contype === 'CONSTR_UNIQUE' || cc?.contype === 'CONSTR_PRIMARY') {
            addUnique(table, [column.colname]);
          }
        }
      }
      if (alter?.subtype === 'AT_DropColumn' && alter.name) {
        sqlTables.get(table)?.columns.delete(alter.name);
      }

      const c = alter?.def?.Constraint;
      if (c?.contype === 'CONSTR_UNIQUE' || c?.contype === 'CONSTR_PRIMARY') {
        addUnique(table, (c.keys ?? []).map((k: any) => k.String.sval));
      }
      if (c?.contype === 'CONSTR_FOREIGN') {
        foreignKeys.push({
          table,
          cols: (c.fk_attrs ?? []).map((a: any) => a.String.sval),
          refTable: c.pktable.relname,
          refCols: (c.pk_attrs ?? []).map((a: any) => a.String.sval),
        });
      }
    }
  }
});

const drizzleTables = () =>
  Object.values(schema)
    .filter((v) => is(v, PgTable))
    .map((t) => getTableConfig(t as PgTable));

describe('migration SQL', () => {
  test('parses under the PostgreSQL grammar', () => {
    assert.ok(sqlTables.size > 0, 'no CREATE TABLE statements found');
  });

  test('every foreign key targets a unique-constrained column set', () => {
    const problems: string[] = [];
    for (const fk of foreignKeys) {
      if (!sqlTables.has(fk.refTable)) {
        problems.push(`${fk.table}(${fk.cols}) -> unknown table ${fk.refTable}`);
        continue;
      }
      if (fk.refCols.length === 0) continue; // references the primary key
      const target = [...fk.refCols].sort().join(',');
      const found = [...(uniques.get(fk.refTable) ?? [])].some(
        (u) => u.split(',').sort().join(',') === target,
      );
      if (!found) problems.push(`${fk.table}(${fk.cols}) -> ${fk.refTable}(${fk.refCols}) has no UNIQUE`);
    }
    assert.deepEqual(problems, [], `unsatisfiable foreign keys:\n${problems.join('\n')}`);
  });
});

describe('Drizzle schema mirrors the SQL', () => {
  test('every Drizzle table exists in the migration', () => {
    const missing = drizzleTables()
      .map((t) => t.name)
      .filter((n) => !sqlTables.has(n));
    assert.deepEqual(missing, [], `tables in schema.ts but not in SQL: ${missing.join(', ')}`);
  });

  test('every SQL table is modelled in Drizzle', () => {
    const modelled = new Set(drizzleTables().map((t) => t.name));
    const missing = [...sqlTables.keys()].filter((n) => !modelled.has(n));
    assert.deepEqual(missing, [], `tables in SQL but not in schema.ts: ${missing.join(', ')}`);
  });

  test('column names match exactly, in both directions', () => {
    const problems: string[] = [];
    for (const t of drizzleTables()) {
      const sqlTable = sqlTables.get(t.name);
      if (!sqlTable) continue;
      const drizzleCols = new Set(t.columns.map((c) => c.name));
      for (const c of drizzleCols) {
        if (!sqlTable.columns.has(c)) problems.push(`${t.name}.${c} is in schema.ts but not in SQL`);
      }
      for (const c of sqlTable.columns) {
        if (!drizzleCols.has(c)) problems.push(`${t.name}.${c} is in SQL but not in schema.ts`);
      }
    }
    assert.deepEqual(problems, [], `column drift:\n${problems.join('\n')}`);
  });
});
