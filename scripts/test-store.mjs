export function testStore() {
const collections = new Map();
const table = (name) => { if (!collections.has(name)) collections.set(name, new Map()); return collections.get(name); };
const matches = (row, where = []) => where.every(({ field, op, value }) => op === "in" ? value.includes(row[field]) : op === ">" ? row[field] > value : op === "<=" ? row[field] <= value : row[field] === value);
const store = {
  delete: async (c, keys) => { let n = 0; for (const k of keys) n += table(c).delete(k) ? 1 : 0; return n; },
  get: async (c, k) => table(c).get(k) || null,
  getOrFail: async (c, k) => { const row = table(c).get(k); if (!row) throw new Error("not found"); return row; },
  getMany: async (c, keys) => new Map(keys.filter(k => table(c).has(k)).map(k => [k, table(c).get(k)])),
  putOne: async (c, k, data) => { table(c).set(k, { ...structuredClone(data), key: k }); return k; },
  query: async (c, { where, limit = 100, order = [], cursor } = {}) => {
    const rows = [...table(c).values()].filter(r => matches(r, where)).sort((a, b) => {
      for (const { field, dir } of order) if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * (dir === "desc" ? -1 : 1);
      return 0;
    });
    const offset = cursor ? Number(cursor.replace("test:", "")) : 0;
    return { rows: rows.slice(offset, offset + limit), cursor: rows.length > offset + limit ? `test:${offset + limit}` : null };
  },
  countAtMost: async (c, where, cap) => [...table(c).values()].filter(r => matches(r, where)).slice(0, cap).length,
  ensureUniqueIndex: async () => true,
  transaction: async ops => {
    for (const op of ops) {
      if (op.collection === "duties" && op.data.api_ref && [...table("duties").values()].some(r => r.key !== op.key && r.api_ref === op.data.api_ref)) throw new Error("unique constraint violation");
    }
    for (const op of ops) await store.putOne(op.collection, op.key, op.data);
  },
};

return { store, table };
}
