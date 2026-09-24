// Files out of a paste event — a screenshot, a file copied from the file manager.
//
// A paste with plain text in it is left alone, so copying from a spreadsheet (which also
// offers an image of the cells) still types the text. When there are files, the paste is
// consumed so it does not also land in whatever field has focus.

export function pastedFiles(event) {
  const data = event.clipboardData;
  const files = [...(data?.files || [])];
  if (!files.length || data.types.includes("text/plain")) return [];
  event.preventDefault();
  // Every pasted screenshot is called "image.png"; give each its own name so they can be told apart.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return files.map((f, i) =>
    /^image\.\w+$/.test(f.name)
      ? new File([f], `pasted-${stamp}${files.length > 1 ? `-${i + 1}` : ""}.${f.name.split(".").pop()}`, { type: f.type })
      : f,
  );
}
