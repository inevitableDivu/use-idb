import { appendFile, readFile, writeFile } from "node:fs/promises";

const [labelsJson, existingVersion = "", mode = ""] = process.argv.slice(2);
if (!labelsJson) {
  throw new Error("Pass the merged pull request labels as a JSON array.");
}

const labels = JSON.parse(labelsJson);
const releaseLabels = ["release:patch", "release:minor", "release:major"];
if (!Array.isArray(labels)) {
  throw new TypeError("Pull request labels must be provided as a JSON array.");
}

const selected = labels.filter((label) => releaseLabels.includes(label));
if (selected.length !== 1) {
  throw new Error(
    `Expected exactly one release label (${releaseLabels.join(", ")}); found ${selected.length}.`,
  );
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new TypeError(`Expected a stable MAJOR.MINOR.PATCH version, got "${version}".`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const packagePath = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const current = parseVersion(packageJson.version);
const next = [...current];
switch (selected[0]) {
  case "release:major":
    next[0]++;
    next[1] = 0;
    next[2] = 0;
    break;
  case "release:minor":
    next[1]++;
    next[2] = 0;
    break;
  case "release:patch":
    next[2]++;
    break;
}

let version = next.join(".");
if (existingVersion && compareVersions(existingVersion, version) > 0) {
  version = existingVersion;
}

packageJson.version = version;
if (mode !== "--dry-run") {
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
console.log(version);
