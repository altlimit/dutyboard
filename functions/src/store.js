// A thin shape-normalising layer over `env.datastore`, so the handlers read like the
// domain and not like the wire.
//
// Two things it normalises. First, a batch get answers positionally with nulls for
// misses on one path and omits misses on another — handlers should not care, so this
// resolves by key either way. Second, documents come back as `{key, data, created,
// updated}` and every handler wants the two merged; `flat()` does that once.

import { notFound } from "./http.js";

export function makeStore(env, instance, namespace) {
  if (!env.datastore) {
    throw new Error("this function has no datastore grant — deploy it with --grants datastore:<instance>=full");
  }
  const target = namespace ? { instance, namespace } : { instance };

  const store = {
    target,

    /** Upsert. `docs` is `[{ key?, data }]`; a missing key gets the instance's auto-id. */
    async put(collection, docs) {
      const res = await env.datastore.put(target, collection, docs);
      return res.keys;
    },

    async putOne(collection, key, data) {
      const keys = await store.put(collection, [{ key, data }]);
      return keys[0];
    },

    /** Point-read one document, or null. */
    async get(collection, key) {
      const res = await env.datastore.get(target, collection, [key]);
      return pick(res.documents, key);
    },

    async getOrFail(collection, key, what) {
      const doc = await store.get(collection, key);
      if (!doc) throw notFound(`${what || collection} '${key}' not found`);
      return doc;
    },

    /** Point-read many; returns a Map keyed by document key, misses absent. */
    async getMany(collection, keys) {
      if (!keys.length) return new Map();
      const res = await env.datastore.get(target, collection, keys);
      const out = new Map();
      for (const d of res.documents || []) if (d && d.key != null) out.set(String(d.key), flat(d));
      return out;
    },

    /**
     * Structured query. Returns `{ rows, cursor }` with rows already flattened.
     *
     * A `keys_only` query answers `{ keys: [...] }` rather than `{ documents: [...] }` —
     * it never reads the data column at all. Both shapes are normalised to rows carrying
     * at least `key`, so a caller that only wanted keys does not have to know which field
     * the answer arrived in. Reading only `documents` here silently returns nothing for
     * every keys-only query, which looks exactly like "there was nothing to delete".
     */
    async query(collection, request) {
      const res = await env.datastore.query(target, collection, request);
      if (Array.isArray(res.keys)) {
        return { rows: res.keys.map((key) => ({ key: String(key) })), cursor: res.cursor || null };
      }
      return { rows: (res.documents || []).map(flat), cursor: res.cursor || null };
    },

    async delete(collection, keys) {
      const res = await env.datastore.delete(target, collection, keys);
      return res.deleted;
    },

    /** Atomic multi-collection write — the reason this service is a function at all. */
    async transaction(operations) {
      return env.datastore.transaction(target, operations);
    },
  };
  return store;
}

/** Merge a `{key, data, created, updated}` envelope into one object. */
export function flat(doc) {
  if (!doc) return null;
  return { ...(doc.data || {}), key: String(doc.key), _created: doc.created, _updated: doc.updated };
}

function pick(documents, key) {
  for (const d of documents || []) {
    if (d && d.key != null && String(d.key) === String(key)) return flat(d);
  }
  // The positional form: a single-key get answers `[doc]` or `[null]`.
  if (documents && documents.length === 1 && documents[0] && documents[0].key == null) return flat(documents[0]);
  return null;
}

/** A transaction `put` op. Handlers build the whole document — duty rows are small,
 *  and we have just read the row we are changing, so a field-level mutate would buy
 *  nothing but a second set of semantics to get wrong. */
export const putOp = (collection, key, data) => ({ op: "put", collection, key, data });
export const deleteOp = (collection, key) => ({ op: "delete", collection, key });
