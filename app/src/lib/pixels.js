// Pixel art for the office, drawn as grids of letters — one letter a pixel, "." for nothing — and
// turned into SVG rects. Scales to any size without blurring and costs no image files.
//
// The furniture uses fixed mid-tone colours that read on a light page and a dark one; what has to
// follow the theme (walls, floors) is drawn in CSS around these.

/** Runs of one colour along a row become one rect: a fraction of the elements one per pixel would be. */
export function pixelRects(rows, palette, top = 0) {
  const out = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      if (ch !== "." && palette[ch]) out.push({ x, y: y + top, w: end - x, fill: palette[ch] });
      x = end;
    }
  });
  return out;
}

const INK = "#2b2f36";

export const SPRITES = {
  coffee: {
    rows: [
      ".KKKKKKK.",
      ".KSSSSSK.",
      ".KSRRGSK.",
      ".KSSSSSK.",
      ".KKKKKKK.",
      ".K.....K.",
      ".K.KKK.K.",
      ".K..W..K.",
      ".K.WWW.K.",
      "KKKKKKKKK",
    ],
    palette: { K: "#4a505a", S: "#7d8794", R: "#e0574b", G: "#5fc27e", W: "#f2efe8" },
  },
  fridge: {
    rows: [
      "KKKKKKKK",
      "KWWWWWWK",
      "KWWWWWHK",
      "KWWWWWHK",
      "KKKKKKKK",
      "KWWWWWWK",
      "KWWWWWHK",
      "KWWWWWHK",
      "KWWWWWHK",
      "KWWWWWWK",
      "KWWWWWWK",
      "KKKKKKKK",
    ],
    palette: { K: "#59606b", W: "#dfe4ea", H: "#8c96a3" },
  },
  counter: {
    rows: [
      "TTTTTTTTTTTTTTTT",
      "BBBBBBBBBBBBBBBB",
      "BDDDDDBBDDDDDDBB",
      "BD...DBBD....DBB",
      "BDDDDDBBDDDDDDBB",
      "BBBBBBBBBBBBBBBB",
    ],
    palette: { T: "#b9c1cb", B: "#8a6f52", D: "#6f573f" },
  },
  couch: {
    rows: [
      "..CCCCCCCCCCCCCCCC..",
      ".CCCCCCCCCCCCCCCCCC.",
      "AACCCCCCCCCCCCCCCCAA",
      "AALLLLLLLLLLLLLLLLAA",
      "AALLLLLLLLLLLLLLLLAA",
      "AAAAAAAAAAAAAAAAAAAA",
      ".F................F.",
    ],
    palette: { C: "#7b5ea7", A: "#664b8f", L: "#8f72bb", F: INK },
  },
  table: {
    rows: [
      ".TTTTTTTTTT.",
      "TTTTTTTTTTTT",
      ".E........E.",
      ".E........E.",
      ".E........E.",
    ],
    palette: { T: "#a88456", E: "#7a5f3e" },
  },
  plant: {
    rows: [
      "..G..G..",
      ".GGLGGL.",
      "GLGGLGGG",
      ".GGGLGG.",
      "..GLGG..",
      "...GG...",
      ".PPPPPP.",
      ".PPPPPP.",
      "..PPPP..",
    ],
    palette: { G: "#3f8f4f", L: "#63b56f", P: "#b4673e" },
  },
  arcade: {
    rows: [
      ".KKKKKKKK.",
      "KCCCCCCCCK",
      "KCYYYYYYCK",
      "KKKKKKKKKK",
      "KSSSSSSSSK",
      "KSGGBGGBSK",
      "KSBGGGGGSK",
      "KSGGGBGGSK",
      "KSSSSSSSSK",
      "KKKKKKKKKK",
      ".KDRDDDYK.",
      ".KDDDDDDK.",
      ".KCCCCCCK.",
      ".KCCCCCCK.",
      ".KCCCCCCK.",
      ".KKKKKKKK.",
    ],
    palette: { K: "#2b2f36", C: "#c4473f", Y: "#f2c94c", S: "#1c2a3a", G: "#3fb37f", B: "#6fb2ff", D: "#4a505a", R: "#e0574b" },
  },
  pingpong: {
    rows: [
      "........N........",
      "R.......N......B.",
      "RWWWWWWWNWWWWWWWB",
      "WGGGGGGGNGGGGGGGW",
      "WGGGGGGGWGGGGGGGW",
      "WWWWWWWWWWWWWWWWW",
      "DDDDDDDDDDDDDDDDD",
      ".E.............E.",
      ".E.............E.",
    ],
    palette: { G: "#2f7d5b", W: "#e8efe9", N: "#c9d1cb", D: "#1f5a41", E: "#4a505a", R: "#e0574b", B: "#3b6fd8" },
  },
  beanbag: {
    rows: [
      "..OOOO..",
      ".OOOOOO.",
      "OOLOOOOO",
      "OOOOOOOO",
      ".OOOOOO.",
    ],
    palette: { O: "#d0783a", L: "#e8975a" },
  },
  mug: {
    rows: ["WWW.", "WWWW", "WWW.", ".W.."],
    palette: { W: "#f2efe8" },
  },
};

/** One member of a team. Skin, hair and shirt come from `characterLook`. */
const HEAD = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHSSSSHH..",
  "..HSESSESH..",
  "...SSSSSS...",
  "...SSMMSS...",
  "....SSSS....",
];

export const PERSON = {
  // At a desk, from the front: arms on the keyboard, in two frames for typing.
  desk: {
    width: 12,
    height: 12,
    body: [...HEAD, "..TTTTTTTT..", ".TTTTTTTTTT.", ".TTTTTTTTTT."],
    frames: [[".SSTTTTTTSS."], ["..SSTTTTSS.."]],
  },
  // On their feet in the breakroom, a mug in hand.
  stand: {
    width: 12,
    height: 16,
    body: [
      ...HEAD,
      "..TTTTTTTT..",
      ".TTTTTTTTTT.",
      ".TTTTTTTTTT.",
      ".STTTTTTTTSC",
      ".S.TTTTTT.SC",
      "...PPPPPP...",
      "...PP..PP...",
      "...PP..PP...",
      "...KK..KK...",
    ],
    frames: [],
  },
};
