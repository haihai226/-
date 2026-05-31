import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const runtimeRoot = path.join(root, "runtime");
const envRoot = path.join(runtimeRoot, "openclaw-env");
const nodeRoot = path.join(envRoot, "nodejs");
const openclawVersion = process.env.OPENCLAW_VERSION || "2026.5.27";
const targetPlatform = process.env.TARGET_PLATFORM || process.platform;
const targetArch = process.env.TARGET_ARCH || process.arch;
const nodeVersion = (process.env.NODE_RUNTIME_VERSION || process.version).replace(/^v/, "");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function copyIfMissing(from, to) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

function nodeArchName() {
  return targetArch === "x64" ? "x64" : "arm64";
}

function downloadNodeRuntime() {
  const arch = nodeArchName();
  fs.mkdirSync(nodeRoot, { recursive: true });

  if (targetPlatform === "win32") {
    const archiveName = `node-v${nodeVersion}-win-${arch}.zip`;
    const downloadUrl = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;
    const archivePath = path.join(runtimeRoot, archiveName);
    run("curl", ["-L", downloadUrl, "-o", archivePath]);
    run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath ${quotePowerShell(archivePath)} -DestinationPath ${quotePowerShell(nodeRoot)} -Force`
    ]);
    fs.rmSync(archivePath, { force: true });
    const nodeBin = path.join(nodeRoot, `node-v${nodeVersion}-win-${arch}`, "node.exe");
    if (!fs.existsSync(nodeBin)) throw new Error(`Node runtime was not created at ${nodeBin}`);
    return `win-${arch}`;
  }

  if (targetPlatform === "darwin") {
    const archiveName = `node-v${nodeVersion}-darwin-${arch}.tar.gz`;
    const downloadUrl = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;
    const archivePath = path.join(runtimeRoot, archiveName);
    run("curl", ["-L", downloadUrl, "-o", archivePath]);
    run("tar", ["-xzf", archivePath, "-C", nodeRoot]);
    fs.rmSync(archivePath, { force: true });
    const nodeBin = path.join(nodeRoot, `node-v${nodeVersion}-darwin-${arch}`, "bin", "node");
    if (!fs.existsSync(nodeBin)) throw new Error(`Node runtime was not created at ${nodeBin}`);
    return `darwin-${arch}`;
  }

  throw new Error(`Unsupported target platform: ${targetPlatform}`);
}

fs.rmSync(runtimeRoot, { recursive: true, force: true });
fs.mkdirSync(envRoot, { recursive: true });
fs.writeFileSync(path.join(envRoot, "package.json"), JSON.stringify({ private: true }, null, 2));

run("npm", ["install", "--prefix", envRoot, `openclaw@${openclawVersion}`, "typebox@1.1.38", "--omit=dev"]);

const rootTypebox = path.join(envRoot, "node_modules", "typebox");
const nestedTypebox = path.join(envRoot, "node_modules", "openclaw", "node_modules", "typebox");
copyIfMissing(rootTypebox, nestedTypebox);

const runtimeTarget = downloadNodeRuntime();
console.log(`Prepared OpenClaw ${openclawVersion} runtime for ${runtimeTarget}`);
