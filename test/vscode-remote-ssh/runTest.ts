import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runTests, runVSCodeCommand } from "@vscode/test-electron";
import Xvfb from "xvfb";

const SSH_IMAGE = "weld-remote-ssh-test:local";
const SSH_USER = "weld";
const SSH_HOST_ALIAS = "weld-remote-ssh-test";
const CONTAINER_REPO_PATH = "/repo";
const CONTAINER_EXTENSION_PATH = "/extension";
const CONFLICT_FILE = "tracked.txt";
const INTERNAL_SSH_PORT = "22";

interface StartedContainer {
	name: string;
	hostName: string;
	port: string;
}

function buildSshImage(extensionDevelopmentPath: string): void {
	const testDirectory = path.join(
		extensionDevelopmentPath,
		"test/vscode-remote-ssh",
	);
	run(
		"docker",
		[
			"build",
			"-t",
			SSH_IMAGE,
			"-f",
			path.join(testDirectory, "Dockerfile"),
			testDirectory,
		],
		{ stdio: "inherit" },
	);
}

function run(
	command: string,
	args: string[],
	options: { cwd?: string; stdio?: "pipe" | "inherit" } = {},
): string {
	const stdio = options.stdio ?? "pipe";
	if (stdio === "inherit") {
		execFileSync(command, args, {
			cwd: options.cwd,
			stdio: "inherit",
		});
		return "";
	}
	return execFileSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: "pipe",
	}).trim();
}

function runGit(args: string[], cwd: string): string {
	return run("git", args, { cwd });
}

function createConflictedRepo(): string {
	const repoPath = mkdtempSync(path.join(tmpdir(), "weld-remote-repo-"));
	chmodSync(repoPath, 0o755);
	runGit(["init"], repoPath);
	runGit(["config", "user.name", "Weld Remote Test"], repoPath);
	runGit(["config", "user.email", "weld-remote@example.com"], repoPath);
	runGit(["config", "merge.conflictStyle", "merge"], repoPath);
	writeFileSync(path.join(repoPath, CONFLICT_FILE), "base\n");
	runGit(["add", "--", CONFLICT_FILE], repoPath);
	runGit(["commit", "-m", "base"], repoPath);
	const baseBranch = runGit(["branch", "--show-current"], repoPath);

	runGit(["checkout", "-b", "other"], repoPath);
	writeFileSync(path.join(repoPath, CONFLICT_FILE), "remote\n");
	runGit(["add", "--", CONFLICT_FILE], repoPath);
	runGit(["commit", "-m", "remote"], repoPath);

	runGit(["checkout", baseBranch], repoPath);
	writeFileSync(path.join(repoPath, CONFLICT_FILE), "local\n");
	runGit(["add", "--", CONFLICT_FILE], repoPath);
	runGit(["commit", "-m", "local"], repoPath);

	try {
		runGit(["merge", "other"], repoPath);
	} catch {
		// git exits 1 for the expected conflict.
	}

	const status = runGit(["status", "--short", "--", CONFLICT_FILE], repoPath);
	if (!status.startsWith("UU ")) {
		throw new Error(`Expected conflicted repo, got git status: ${status}`);
	}
	return repoPath;
}

function createSshKey(tempRoot: string): {
	privateKey: string;
	publicKey: string;
} {
	const privateKey = path.join(tempRoot, "id_ed25519");
	run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", privateKey, "-q"]);
	return {
		privateKey,
		publicKey: readFileSync(`${privateKey}.pub`, "utf8").trim(),
	};
}

function startContainer(
	repoPath: string,
	publicKey: string,
	extensionDevelopmentPath: string,
): StartedContainer {
	const name = `weld-remote-ssh-${process.pid}-${Date.now()}`;
	run(
		"docker",
		[
			"run",
			"-d",
			"--rm",
			"--name",
			name,
			"-e",
			`WELD_REMOTE_SSH_PUBKEY=${publicKey}`,
			"-v",
			`${repoPath}:${CONTAINER_REPO_PATH}:Z`,
			"-v",
			`${extensionDevelopmentPath}:${CONTAINER_EXTENSION_PATH}:ro,Z`,
			SSH_IMAGE,
			"bash",
			"-lc",
			[
				`mkdir -p /home/${SSH_USER}/.ssh`,
				`printf '%s\\n' "$WELD_REMOTE_SSH_PUBKEY" > /home/${SSH_USER}/.ssh/authorized_keys`,
				`chown ${SSH_USER}:${SSH_USER} /home/${SSH_USER}/.ssh/authorized_keys`,
				`chmod 600 /home/${SSH_USER}/.ssh/authorized_keys`,
				"/usr/sbin/sshd -D -e",
			].join(" && "),
		],
		{ stdio: "inherit" },
	);
	try {
		const hostName = run("docker", [
			"inspect",
			"-f",
			"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
			name,
		]);
		if (!hostName) {
			throw new Error(`Could not resolve container IP for ${name}.`);
		}
		return { name, hostName, port: INTERNAL_SSH_PORT };
	} catch (error: unknown) {
		run("docker", ["rm", "-f", name], { stdio: "inherit" });
		throw error;
	}
}

function installRemoteExtensionFromSource(containerName: string): void {
	const remoteExtensionPath = `/home/${SSH_USER}/.vscode-server/extensions/pknowles.meld-auto-merge-source`;
	run(
		"docker",
		[
			"exec",
			"-u",
			SSH_USER,
			containerName,
			"bash",
			"-lc",
			[
				`mkdir -p /home/${SSH_USER}/.vscode-server/extensions`,
				`rm -rf ${remoteExtensionPath}`,
				`ln -s ${CONTAINER_EXTENSION_PATH} ${remoteExtensionPath}`,
			].join(" && "),
		],
		{ stdio: "inherit" },
	);
}

function dumpRemoteDiagnostics(containerName: string): void {
	run(
		"docker",
		[
			"exec",
			"-u",
			SSH_USER,
			containerName,
			"bash",
			"-lc",
			[
				"set +e",
				"echo '--- remote extension source ---'",
				`ls -la ${CONTAINER_EXTENSION_PATH}`,
				`cat ${CONTAINER_EXTENSION_PATH}/package.json | sed -n '1,80p'`,
				"echo '--- remote installed extensions ---'",
				`find /home/${SSH_USER}/.vscode-server/extensions -maxdepth 2 -type f -name package.json -print`,
				"echo '--- remote server logs mentioning Weld ---'",
				`find /home/${SSH_USER}/.vscode-server -type f -name '*.log' -print0 | xargs -0 grep -i -n 'weld\\|meld-auto-merge\\|extensionDevelopmentPath' || true`,
			].join(" && "),
		],
		{ stdio: "inherit" },
	);
}

function sshArgs(
	privateKey: string,
	hostName: string,
	port: string,
	command: string,
): string[] {
	return [
		"-i",
		privateKey,
		"-p",
		port,
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=no",
		"-o",
		"UserKnownHostsFile=/dev/null",
		`${SSH_USER}@${hostName}`,
		command,
	];
}

function waitForSsh(privateKey: string, hostName: string, port: string): void {
	const deadline = Date.now() + 60_000;
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			run("ssh", sshArgs(privateKey, hostName, port, "true"));
			return;
		} catch (error: unknown) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
	}
	throw new Error(`Timed out waiting for SSH container: ${lastError}`);
}

function prepareRemoteGit(
	containerName: string,
	privateKey: string,
	hostName: string,
	port: string,
): void {
	run("docker", ["exec", containerName, "git", "--version"], {
		stdio: "inherit",
	});
	run(
		"ssh",
		sshArgs(
			privateKey,
			hostName,
			port,
			`git config --global --add safe.directory ${CONTAINER_REPO_PATH} && git -C ${CONTAINER_REPO_PATH} status --short`,
		),
		{ stdio: "inherit" },
	);
}

function writeRemoteSshConfig(
	tempRoot: string,
	privateKey: string,
	hostName: string,
	port: string,
): string {
	const configPath = path.join(tempRoot, "ssh_config");
	writeFileSync(
		configPath,
		[
			`Host ${SSH_HOST_ALIAS}`,
			`  HostName ${hostName}`,
			`  Port ${port}`,
			`  User ${SSH_USER}`,
			`  IdentityFile ${privateKey}`,
			"  BatchMode yes",
			"  StrictHostKeyChecking no",
			"  UserKnownHostsFile /dev/null",
			"  LogLevel ERROR",
			"",
		].join("\n"),
	);
	return configPath;
}

function writeUserSettings(userDataDir: string, sshConfigPath: string): void {
	const userDir = path.join(userDataDir, "User");
	mkdirSync(userDir, { recursive: true });
	writeFileSync(
		path.join(userDir, "settings.json"),
		JSON.stringify(
			{
				"remote.SSH.configFile": sshConfigPath,
				"remote.SSH.remotePlatform": {
					[SSH_HOST_ALIAS]: "linux",
				},
				"remote.SSH.useLocalServer": false,
				"weld.remoteSmokeTest": true,
			},
			null,
			2,
		),
	);
}

async function main(): Promise<void> {
	const currentFile = fileURLToPath(import.meta.url);
	const currentDir = path.dirname(currentFile);
	const extensionDevelopmentPath = path.resolve(currentDir, "../..");
	const extensionTestsPath = path.resolve(currentDir, "suite/index.cjs");
	const tempRoot = mkdtempSync(path.join(tmpdir(), "weld-remote-ssh-"));
	const userDataDir = path.join(tempRoot, "user-data");
	const repoPath = createConflictedRepo();
	let container: StartedContainer | null = null;
	let xvfb: Xvfb | null = null;

	try {
		const { privateKey, publicKey } = createSshKey(tempRoot);
		buildSshImage(extensionDevelopmentPath);
		container = startContainer(
			repoPath,
			publicKey,
			extensionDevelopmentPath,
		);
		installRemoteExtensionFromSource(container.name);
		xvfb = process.platform === "linux" ? new Xvfb({ silent: true }) : null;
		waitForSsh(privateKey, container.hostName, container.port);
		prepareRemoteGit(
			container.name,
			privateKey,
			container.hostName,
			container.port,
		);
		const sshConfigPath = writeRemoteSshConfig(
			tempRoot,
			privateKey,
			container.hostName,
			container.port,
		);
		writeUserSettings(userDataDir, sshConfigPath);

		await runVSCodeCommand(
			["--install-extension", "ms-vscode-remote.remote-ssh", "--force"],
			{ spawn: { stdio: "inherit" } },
		);

		if (xvfb) {
			xvfb.startSync();
		}

		const remoteAuthority = `ssh-remote+${SSH_HOST_ALIAS}`;
		const remoteRepoUri = `vscode-remote://${remoteAuthority}${CONTAINER_REPO_PATH}`;
		const remoteExtensionDevelopmentPath = `vscode-remote://${remoteAuthority}${CONTAINER_EXTENSION_PATH}`;
		const extensionTestsEnv = Object.fromEntries([
			["WELD_REMOTE_AUTHORITY", remoteAuthority],
			["WELD_REMOTE_REPO_URI", remoteRepoUri],
			["WELD_REMOTE_FILE_URI", `${remoteRepoUri}/${CONFLICT_FILE}`],
		]);
		await runTests({
			extensionDevelopmentPath: remoteExtensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				"--folder-uri",
				remoteRepoUri,
				`--user-data-dir=${userDataDir}`,
				"--skip-welcome",
				"--skip-release-notes",
			],
			extensionTestsEnv,
		});
	} catch (error: unknown) {
		if (container) {
			try {
				dumpRemoteDiagnostics(container.name);
			} catch (diagnosticsError: unknown) {
				process.stderr.write(
					`Could not dump remote diagnostics: ${
						diagnosticsError instanceof Error
							? diagnosticsError.message
							: String(diagnosticsError)
					}\n`,
				);
			}
		}
		throw error;
	} finally {
		if (xvfb) {
			xvfb.stopSync();
		}
		if (container) {
			run("docker", ["rm", "-f", container.name], { stdio: "inherit" });
		}
		rmSync(repoPath, { recursive: true, force: true });
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	process.stderr.write("VS Code Remote SSH smoke test failed\n");
	const details =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr.write(`${details}\n`);
	process.exitCode = 1;
});
