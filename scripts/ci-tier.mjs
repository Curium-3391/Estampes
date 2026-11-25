// Default to full if the event or diff cannot establish a cheaper tier.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

function tierForPath(path) {
  // The UVA evidence directory includes fixtures consumed by the tests.
  if (path.startsWith("docs/rfc/unified-visual-architecture/evidence/")) return "full";
  if (/^(?:docs\/.*|[^/]+)\.md$/.test(path)) return "docs";

  // Only known paths can use the fast tier. Shared storage dependencies,
  // CI, lockfiles, test helpers/fixtures, and unknown paths require full.
  if (/^tests\/(?:persistence-|uva-|documents?-|pr1d-|storage\.|workspace|bundle|backup-restore|canvas-(?:state|history|save)|compose\.)/.test(path)) return "full";
  if (/^tests\/[^/]+\.test\.js$/.test(path)) return "fast";
  // These widget assets own document polling and persisted canvas edits.
  if (/^public\/(?:visual-surface\.html|workbench\.js|module-view\.js)$/.test(path)) return "full";
  if (/^(public\/|examples\/|cas-service\/|src\/(?:cas|builtin-modules|modules)\/)/.test(path)) return "fast";
  if (/^src\/image\/(?:engines|geometry|measure|ops-extra|pdf|quality|register|segment|view)\.js$/.test(path)) return "fast";

  return "full";
}

function selectTier() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") return "full";

  try {
    const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const shas = [pr.base.sha, pr.head.sha];
    if (!shas.every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error("Invalid pull request SHA");

    // Three-dot diff matches the PR changes. Treat renames as a deletion and
    // addition so moving a persistence file out of its directory still runs full.
    const paths = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", shas.join("..."), "--"], {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    }).split("\0").filter(Boolean);
    if (paths.length === 0) return "full";

    const tiers = paths.map(tierForPath);
    if (tiers.includes("full")) return "full";
    return tiers.includes("fast") ? "fast" : "docs";
  } catch (error) {
    console.warn("Could not classify pull request changes. Running full validation.", error.message);
    return "full";
  }
}

const tier = selectTier();
console.log(`Validation tier: ${tier}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tier=${tier}\n`);
