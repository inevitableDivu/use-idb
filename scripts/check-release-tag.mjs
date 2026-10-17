import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (!tag) {
  console.error("Pass a version tag (for example, v1.2.3) or set GITHUB_REF_NAME.");
  process.exitCode = 1;
} else if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error(`Release tag "${tag}" must use the vMAJOR.MINOR.PATCH format.`);
  process.exitCode = 1;
} else if (tag.slice(1) !== packageJson.version) {
  console.error(
    `Release tag "${tag}" does not match package.json version "${packageJson.version}".`,
  );
  process.exitCode = 1;
} else {
  console.log(`Release tag ${tag} matches package version ${packageJson.version}.`);
}
