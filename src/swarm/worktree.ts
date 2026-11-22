import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type Worktree = { path: string; base: string; remove: () => void };

const git = (cwd: string, args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * SCALE_PLAN P3: one detached git worktree per worker under `tempDir`, checked out at `base` of `repo`. The target's working tree and branch are never touched
 * (a detached worktree moves no branch); removing the worktree is the orchestrator's duty (P3 left it behind).
 */
export const createWorktree = (repo: string, base: string, tempDir: string, name: string): Worktree => {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`bad worktree name: ${name}`);
  const dir = path.resolve(tempDir, name);
  if (fs.existsSync(dir)) throw new Error(`worktree path exists: ${dir}`);
  fs.mkdirSync(path.resolve(tempDir), { recursive: true });
  const commit = git(repo, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
  git(repo, ["worktree", "add", "--detach", dir, commit]);
  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    try {
      git(repo, ["worktree", "remove", "--force", dir]);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    try {
      git(repo, ["worktree", "prune"]);
    } catch {
      // nothing to prune
    }
  };
  return { path: dir, base: commit, remove };
};
