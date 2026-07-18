// Turn a free-text city name into a stable, URL- and key-safe slug used as the
// city document's primary key (so "San Francisco" and "san francisco" collide into
// one city rather than creating duplicates).
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
