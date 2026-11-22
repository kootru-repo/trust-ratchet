import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "wtv-"));
export const git = (cwd: string, args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A repo whose check (node check.js) passes when a.txt says ok. Returns its path and head. */
export const fixtureRepo = (): { repo: string; head: string } => {
  const repo = tmp();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "ok\n");
  fs.writeFileSync(path.join(repo, "check.js"), 'process.exit(require("fs").readFileSync("a.txt","utf8").includes("ok") ? 0 : 1);\n');
  git(repo, ["add", "a.txt", "check.js"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return { repo, head: git(repo, ["rev-parse", "HEAD"]).trim() };
};

/** The diff that turns a.txt into `text`, made in a scratch clone so `repo` is untouched. */
export const diffTo = (repo: string, text: string): string => {
  const c = tmp();
  fs.rmSync(c, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", repo, c], { stdio: "ignore" });
  fs.writeFileSync(path.join(c, "a.txt"), text);
  const d = git(c, ["diff"]);
  fs.rmSync(c, { recursive: true, force: true });
  return d;
};
