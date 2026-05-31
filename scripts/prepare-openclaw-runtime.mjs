import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const runtimeRoot = path.join(root, "runtime");
const envRoot = path.join(runtimeRoot, "openclaw-env");
const nodeRoot = path.join(envRoot, "nodejs");
const openclawVersion = process.env.OPENCLAW_VERSION || "2026.5.27";
const targetArch = process.env.TARGET_ARCH || process.arch;
const nodeVersion = (process.env.NODE_RUNTIME_VERSION || process.version).replace(/^v/, "");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function copyIfMissing(from, to) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

fs.rmSync(runtimeRoot, { recursive: true, force: true });
fs.mkdirSync(envRoot, { recursive: true });
fs.writeFileSync(path.join(envRoot, "package.json"), JSON.stringify({ private: true }, null, 2));

run("npm", ["install", "--prefix", envRoot, `openclaw@${openclawVersion}`, "typebox@1.1.38", "--omit=dev"]);

const rootTypebox = path.join(envRoot, "node_modules", "typebox");
const nestedTypebox = path.join(envRoot, "node_modules", "openclaw", "node_modules", "typebox");
copyIfMissing(rootTypebox, nestedTypebox);

const nodeArch = targetArch === "x64" ? "x64" : "arm64";
const archiveName = `node-v${nodeVersion}-darwin-${nodeArch}.tar.gz`;
const downloadUrl = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;
const archivePath = path.join(runtimeRoot, archiveName);
fs.mkdirSync(nodeRoot, { recursive: true });
run("curl", ["-L", downloadUrl, "-o", archivePath]);
run("tar", ["-xzf", archivePath, "-C", nodeRoot]);
fs.rmSync(archivePath, { force: true });

const nodeBin = path.join(nodeRoot, `node-v${nodeVersion}-darwin-${nodeArch}`, "bin", "node");
if (!fs.existsSync(nodeBin)) {
  throw new Error(`Node runtime was not created at ${nodeBin}`);
}

console.log(`Prepared OpenClaw ${openclawVersion} runtime for darwin-${nodeArch}`);
