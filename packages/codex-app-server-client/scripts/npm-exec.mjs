import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function execNpmSync(args, options) {
  const inheritedNpmCli = process.env.npm_execpath;
  if (
    inheritedNpmCli &&
    basename(inheritedNpmCli) === "npm-cli.js" &&
    existsSync(inheritedNpmCli)
  ) {
    return execFileSync(process.execPath, [inheritedNpmCli, ...args], options);
  }

  if (process.platform !== "win32") {
    return execFileSync("npm", args, options);
  }

  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) {
    throw new Error(`Unable to locate the npm CLI beside ${process.execPath}.`);
  }
  return execFileSync(process.execPath, [npmCli, ...args], options);
}
