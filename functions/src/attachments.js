// Files on a duty — a screenshot of the bug, a recording of the broken flow, a log.
//
// BYTES NEVER PASS THROUGH THIS FUNCTION. It decides whether a caller may upload and how
// big the file may be, mints a URL the client PUTs to directly, and hands back short-lived
// download URLs when someone reads. That is the whole design, and it is what makes a video
// attachment possible at all: a function's isolate could not hold one.
//
// Objects are stored PRIVATE. A public blob is served from a stable URL to anyone who has
// it, and screenshots of a system being debugged are exactly the thing that should not be.
// Every read mints a fresh signed URL, minutes long, for a caller that has just been
// checked against the board.
//
// There is no commit step, by design of the platform: storage reports the upload itself.
// So an attachment row can exist for bytes that never arrived — a browser tab closed
// mid-upload. `listAttachments` is where that is reconciled: a row whose object is not
// there yet reads as `pending`, and one still missing long after its upload URL expired is
// swept, because at that point it never happened.

import { badRequest, forbidden, notFound, str } from "./http.js";
import { ulid } from "./ids.js";
import { putOp, deleteOp } from "./store.js";
import { projectOfDuty, authorOf } from "./identity.js";
import { loadDuty, stripMeta } from "./duties.js";

const attachmentId = () => "att_" + ulid();

/** Per duty. A board is a coordination surface, not a file share — twenty files on one
 *  duty means the duty is really several. */
export const MAX_ATTACHMENTS = 20;

/** The ceiling this function will sign for. The blob instance has its own `maxObjectBytes`
 *  and the smaller of the two wins; this one exists so the refusal names a number before
 *  anyone uploads 400MB and finds out from storage. */
export const MAX_BYTES = 50 * 1024 * 1024;

/**
 * The ceiling for bytes sent INLINE, base64 in the request body.
 *
 * The design is that bytes go straight to storage and never through here, and for anything
 * large that stands: an isolate cannot hold a video. But a caller whose only transport is
 * MCP has no way to make a PUT — it has a list of tools, not an HTTP client — and telling
 * such an agent to attach a screenshot was telling it to do something it cannot do. So
 * there is a small door: enough for a screenshot, a recording of a short interaction, or a
 * log, and not enough to make the function a file server.
 */
export const MAX_INLINE_BYTES = 2 * 1024 * 1024;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INV = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t["-".charCodeAt(0)] = 62; // URL-safe alphabet, accepted because callers send it
  t["_".charCodeAt(0)] = 63;
  return t;
})();

/**
 * Base64 → bytes, without `atob`.
 *
 * `atob` is the obvious way and it silently destroys the data. It answers with a string
 * whose code units are meant to be bytes, and a runtime that holds strings as UTF-8 —
 * which the local emulator does — cannot represent a lone 0x80: it becomes U+FFFD, and
 * `bytes[i] = charCodeAt(i)` truncates 65533 to 253. So every byte above 0x7F came back as
 * 253 and a PNG round-tripped to garbage of the right length, which is the worst shape a
 * corruption can take. Measured, not guessed: 256 known bytes in, first difference at 128.
 *
 * Six bits at a time, one code path, identical everywhere — the same reasoning as the
 * hand-rolled SHA-256 in hash.js, and for the same reason: a difference between the
 * developer's machine and production is the one place a bug must not be allowed to live.
 */
function fromBase64(value, field) {
  const src = String(value).replace(/^data:[^;]*;base64,/, "").replace(/[\s=]+/g, "");
  const out = new Uint8Array(Math.floor((src.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    const six = code < 128 ? B64_INV[code] : -1;
    if (six < 0) throw badRequest(`'${field}' is not valid base64`);
    acc = (acc << 6) | six;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  // A trailing group of one character carries no whole byte and means the input was
  // truncated — worth refusing rather than storing a file that is quietly short.
  if (src.length % 4 === 1) throw badRequest(`'${field}' is not valid base64 (truncated)`);
  return out.subarray(0, n);
}

/** How long after minting an upload URL a row with no object behind it is assumed dead.
 *  Comfortably longer than the URL's own life, so a slow upload is never swept mid-flight. */
const ABANDONED_AFTER_MS = 60 * 60 * 1000;

function requireBlob(ctx) {
  if (!ctx.env.blob || !ctx.cfg.blobInstance) {
    throw badRequest("attachments are not configured for this deployment (no blob instance)");
  }
  return { instance: ctx.cfg.blobInstance };
}

const view = (row, extra) => ({
  id: row.key,
  name: row.name,
  content_type: row.content_type,
  size: row.size,
  author_type: row.author_type,
  author_id: row.author_id,
  author_name: row.author_name || null,
  created_at: row.created_at,
  ...extra,
});

/**
 * `POST /duty/attach` — reserve a file on a duty and hand back a URL to PUT it to.
 *
 * The caller uploads the bytes itself:
 *
 *   PUT <upload_url>   with the returned headers, and exactly `size` bytes
 *
 * The size is signed into the URL, so it is a real bound rather than a promise — sending
 * more is refused by storage, not by us.
 *
 * OR, for a caller that cannot make a PUT — an agent whose whole transport is MCP — pass
 * `content_base64` instead of `size` and the bytes are stored here, in this call. Small
 * files only; see MAX_INLINE_BYTES for why that door is narrow.
 */
export async function attachToDuty(ctx, body) {
  const target = requireBlob(ctx);
  const duty = await loadDuty(ctx, body.duty_id);
  const project = await projectOfDuty(ctx.caller, duty, ctx.store);

  const name = str(body.name, "name", { required: true, max: 200 });
  const contentType = str(body.content_type, "content_type", { max: 120, fallback: "application/octet-stream" });
  const inline = body.content_base64 != null ? fromBase64(body.content_base64, "content_base64") : null;

  // Not `intIn`: that clamps, and a clamped size would sign a URL for fewer bytes than the
  // client is about to send — a confusing failure at storage instead of a clear one here.
  const size = inline ? inline.byteLength : Number(body.size);
  if (!Number.isFinite(size) || size <= 0) {
    throw badRequest("'size' must be the file's size in bytes, or send the file as 'content_base64'");
  }
  if (inline && size > MAX_INLINE_BYTES) {
    throw badRequest(
      `'${name}' is ${(size / 1048576).toFixed(1)}MB, and an inline upload is limited to ` +
        `${MAX_INLINE_BYTES / 1048576}MB. Send 'size' instead and PUT the bytes to the ` +
        `upload_url that comes back — that path takes up to ${MAX_BYTES / 1048576}MB.`,
    );
  }
  if (size > MAX_BYTES) {
    throw badRequest(`'${name}' is ${(size / 1048576).toFixed(1)}MB — the limit is ${MAX_BYTES / 1048576}MB`);
  }

  const count = duty.attachment_count || 0;
  if (count >= MAX_ATTACHMENTS) {
    throw badRequest(`this duty already has ${count} attachments — the limit is ${MAX_ATTACHMENTS}`);
  }

  // Enough to trace an object back to what it belongs to without reading our datastore.
  const meta = { duty: duty.key, project: project.key };
  const stored = inline
    ? await ctx.env.blob.put(target, name, inline, { contentType, public: false, meta })
    : await ctx.env.blob.uploadUrl(target, { name, size, contentType, public: false, meta });

  const now = Date.now();
  const id = attachmentId();
  const row = {
    duty_id: duty.key,
    project_id: project.key,
    owner_uid: project.owner_uid,
    blob_id: stored.id,
    name,
    content_type: contentType,
    size,
    ...authorOf(ctx.caller, str(body.agent_id ?? ctx.defaultAgentId, "agent_id", { max: 64 })),
    created_at: now,
  };

  // The count moves with the row, in one transaction, so a poll or a claim can say "this
  // duty has two screenshots" without reading the attachments collection.
  await ctx.store.transaction([
    putOp("attachments", id, row),
    putOp("duties", duty.key, { ...stripMeta(duty), attachment_count: count + 1, updated_at: now }),
  ]);
  await ctx.publish(project.key, duty.key, { t: "duty", id: duty.key, status: duty.status });

  // Inline: the bytes are already stored, so there is nothing for the caller to do next and
  // no URL worth handing back — a signed download URL comes from /duty/attachments, minted
  // per read, and one issued here would be stale before anyone looked at it.
  if (inline) return { attachment_id: id, uploaded: true, name, size };

  return {
    attachment_id: id,
    upload_url: stored.upload_url,
    method: "PUT",
    // Storage signed these in. Sending the bytes without them fails the signature check.
    required_headers: stored.required_headers || { "content-type": contentType },
    expires_at: stored.expires_at,
    size,
  };
}

/**
 * `POST /duty/attachments` — what is on this duty, with a fresh URL for each.
 *
 * One blob read per attachment, which is why the count is capped. The URLs are minted per
 * request and expire in minutes: an agent fetches them immediately, and a link that leaks
 * later is worth nothing.
 */
export async function listAttachments(ctx, body) {
  const target = requireBlob(ctx);
  const duty = await loadDuty(ctx, body.duty_id);
  await projectOfDuty(ctx.caller, duty, ctx.store);

  const { rows } = await ctx.store.query("attachments", {
    where: [{ field: "duty_id", op: "=", value: duty.key }],
    order: [{ field: "created_at", dir: "asc" }],
    limit: MAX_ATTACHMENTS,
  });

  const now = Date.now();
  const out = [];
  const abandoned = [];
  for (const row of rows) {
    let found = null;
    try {
      found = await ctx.env.blob.get(target, row.blob_id);
    } catch {
      // Not there. Either the bytes are still on their way, or they never came.
      found = null;
    }
    if (found) {
      out.push(view(row, { url: found.download_url || (found.blob && found.blob.url) || null, expires_at: found.expires_at || null }));
    } else if (now - (row.created_at || 0) > ABANDONED_AFTER_MS) {
      abandoned.push(row.key);
    } else {
      out.push(view(row, { url: null, pending: true }));
    }
  }

  // Sweep what never arrived, and reconcile the count in the same breath.
  //
  // The count is set to what was actually just read, not decremented by what was swept.
  // Two things drift it, in both directions: a closed tab leaves a duty claiming a file
  // nobody can open, and two uploads landing together both read the same count and write
  // the same +1, so a duty with two files says one. The rows are the truth; this is where
  // the cached number is made to agree with them.
  const trueCount = out.length;
  const stale = await ctx.store.get("duties", duty.key);
  const cached = stale ? stale.attachment_count || 0 : 0;
  if (abandoned.length || cached !== trueCount) {
    await ctx.store.transaction([
      ...abandoned.map((key) => deleteOp("attachments", key)),
      putOp("duties", duty.key, {
        ...stripMeta(stale || duty),
        attachment_count: trueCount,
        // Not a change anyone made — reconciliation must not push the duty to the top of a
        // board ordered by updated_at.
        updated_at: stale ? stale.updated_at : duty.updated_at,
      }),
    ]);
  }

  return { duty_id: duty.key, attachments: out };
}

/**
 * Remove every attachment matching one field, and the objects behind them.
 *
 * Used when a duty is deleted and when a whole board is. The rows are the only record that
 * an object exists, so dropping them without deleting the objects is a leak that nothing
 * can ever find again — storage would hold those bytes for as long as the account does.
 *
 * Blob deletes are best-effort and batched: a failure here must not stop a board from being
 * deleted, and an orphaned object costs storage, where a half-deleted board costs trust.
 */
export async function sweepAttachments(ctx, match) {
  if (!ctx.env.blob || !ctx.cfg.blobInstance) return 0;
  const target = { instance: ctx.cfg.blobInstance };
  let total = 0;
  for (;;) {
    const { rows } = await ctx.store.query("attachments", {
      where: [{ field: match.field, op: "=", value: match.value }],
      limit: 200,
    });
    if (!rows.length) break;
    await ctx.env.blob.delete(target, rows.map((r) => r.blob_id).filter(Boolean)).catch(() => {});
    await ctx.store.delete("attachments", rows.map((r) => r.key));
    total += rows.length;
    if (rows.length < 200) break;
  }
  return total;
}

/** `POST /duty/attachment/delete` — remove a file from a duty, and from storage. */
export async function deleteAttachment(ctx, body) {
  const target = requireBlob(ctx);
  const key = str(body.attachment_id, "attachment_id", { required: true, max: 64 });
  const row = await ctx.store.get("attachments", key);
  if (!row) throw notFound(`attachment '${key}' not found`);

  const duty = await loadDuty(ctx, row.duty_id);
  const project = await projectOfDuty(ctx.caller, duty, ctx.store);
  if (row.project_id !== project.key) throw forbidden("that attachment is not on this board");

  // The row first: a row pointing at an object that is gone is a broken link on the page,
  // where an object with no row is invisible and merely costs storage. Neither is good,
  // but only one of them is confusing.
  const now = Date.now();
  await ctx.store.transaction([
    deleteOp("attachments", key),
    putOp("duties", duty.key, {
      ...stripMeta(duty),
      attachment_count: Math.max(0, (duty.attachment_count || 0) - 1),
      updated_at: now,
    }),
  ]);
  await ctx.env.blob.delete(target, [row.blob_id]).catch(() => {});
  await ctx.publish(project.key, duty.key, { t: "duty", id: duty.key, status: duty.status });

  return { ok: true, deleted: key };
}
