// Just enough semantic versioning for module compatibility: versions
// MAJOR.MINOR.PATCH[-pre], ranges of space-separated comparators
// (>=, <=, >, <, =, ^, ~, or a bare version) joined by ||.
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,40}))?$/;

export function parseVersion(v) {
  const m = VERSION.exec(String(v ?? "").trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}
export const isVersion = (v) => parseVersion(v) !== null;

export function compareVersions(a, b) {
  const x = typeof a === "string" ? parseVersion(a) : a, y = typeof b === "string" ? parseVersion(b) : b;
  if (!x || !y) throw new Error("Not a version: " + (x ? b : a));
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function comparator(text) {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(text);
  const op = m?.[1] ?? "=", v = parseVersion(m?.[2]);
  if (!v) throw new Error("Not a version range: " + JSON.stringify(text));
  if (op === "^") {
    const upper = v.major > 0 ? { major: v.major + 1, minor: 0, patch: 0 } : { major: 0, minor: v.minor + 1, patch: 0 };
    return (x) => compareVersions(x, v) >= 0 && compareVersions(x, { ...upper, pre: null }) < 0;
  }
  if (op === "~") return (x) => compareVersions(x, v) >= 0 && compareVersions(x, { major: v.major, minor: v.minor + 1, patch: 0, pre: null }) < 0;
  return {
    ">=": (x) => compareVersions(x, v) >= 0, "<=": (x) => compareVersions(x, v) <= 0,
    ">": (x) => compareVersions(x, v) > 0, "<": (x) => compareVersions(x, v) < 0, "=": (x) => compareVersions(x, v) === 0,
  }[op];
}

export function parseRange(range) {
  const text = String(range ?? "").trim();
  if (!text || text.length > 120) throw new Error("Not a version range: " + JSON.stringify(range));
  const alternatives = text.split("||").map((alt) => alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).map(comparator));
  return (version) => {
    const v = parseVersion(version);
    return !!v && alternatives.some((all) => all.every((test) => test(v)));
  };
}

export const satisfies = (version, range) => parseRange(range)(version);
