// Whether a click on a link is a plain one — not a middle click, nor one with a key held to open it in
// a new tab or window. A page that handles links itself (opening a duty over the office, say) should
// only take the plain ones, and leave the rest to the browser.
export const plainClick = (event) =>
  !(event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
