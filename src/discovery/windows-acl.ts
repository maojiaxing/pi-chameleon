import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

/** A single restricted, local DACL reader avoids process startup per file operation. */
const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Check-Access($request) {
 $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
 $allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
 $sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
 $root = [string]$request.root
 $item = Get-Item -LiteralPath $root -Force
 if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or !$item.PSIsContainer) { throw 'unsafe' }
 $acl = [System.IO.Directory]::GetAccessControl($root, $sections)
 if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unsafe' }
 if ($request.ensure) {
  $needsWrite = !$acl.AreAccessRulesProtected
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
   if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) { $needsWrite = $true }
  }
  if ($needsWrite) {
   $private = New-Object System.Security.AccessControl.DirectorySecurity
   $private.SetOwner($sid)
   $private.SetAccessRuleProtection($true, $false)
   foreach ($principal in $allowed) {
    $identity = New-Object System.Security.Principal.SecurityIdentifier($principal)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $private.AddAccessRule($rule)
   }
   [System.IO.Directory]::SetAccessControl($root, $private)
  }
 }
 foreach ($path in @($root) + @($request.paths)) {
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
  if ($item.PSIsContainer) { $acl = [System.IO.Directory]::GetAccessControl($path, $sections) }
  else { $acl = [System.IO.File]::GetAccessControl($path, $sections) }
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unsafe' }
  if ($path -eq $root -and !$acl.AreAccessRulesProtected) { throw 'unsafe' }
  $readable = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
   if ($rule.AccessControlType -eq 'Allow') {
    if ($allowed -notcontains $rule.IdentityReference.Value) { throw 'unsafe' }
    if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData) -ne 0) { $readable = $true }
   }
  }
  if (!$readable) { throw 'unsafe' }
 }
}
while ($null -ne ($line = [Console]::In.ReadLine())) {
 $request = $null
 try {
  $request = ConvertFrom-Json -InputObject $line
  Check-Access $request
  [Console]::Out.WriteLine(([string]$request.id) + ':OK')
 } catch {
  if ($null -ne $request) { [Console]::Out.WriteLine(([string]$request.id) + ':UNTRUSTED') }
  else { [Console]::Out.WriteLine('INVALID') }
 }
 [Console]::Out.Flush()
}
`;

interface PendingCheck {
	resolve(): void;
	reject(): void;
	timer: ReturnType<typeof setTimeout>;
}
interface Validator {
	child: ChildProcessWithoutNullStreams;
	pending: Map<number, PendingCheck>;
	idle?: ReturnType<typeof setTimeout>;
}
let validator: Validator | undefined;
let sequence = 0;

function failure(): Error { return new Error("STORAGE_UNTRUSTED"); }
function retire(worker: Validator): void {
	if (validator === worker) validator = undefined;
	if (worker.idle) clearTimeout(worker.idle);
	for (const check of worker.pending.values()) { clearTimeout(check.timer); check.reject(); }
	worker.pending.clear();
	worker.child.kill();
}
function scheduleIdle(worker: Validator): void {
	if (worker.pending.size || worker.idle) return;
	worker.idle = setTimeout(() => {
		worker.idle = undefined;
		if (worker.pending.size) return;
		if (validator === worker) validator = undefined;
		worker.child.stdin.end();
	}, 500);
	worker.idle.unref();
}
function getValidator(): Validator {
	if (validator) return validator;
	const env: NodeJS.ProcessEnv = {};
	for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name];
	const child = spawn(resolve(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
		["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
		{ env, windowsHide: true, stdio: "pipe" });
	const worker: Validator = { child, pending: new Map() };
	validator = worker;
	// No raw PowerShell diagnostics (paths, principal names, environment) escape this seam.
	child.stderr.resume();
	child.once("error", () => retire(worker));
	child.once("exit", () => retire(worker));
	child.stdin.on("error", () => retire(worker));
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		const match = /^(\d+):(OK|UNTRUSTED)$/.exec(line);
		if (!match) { retire(worker); return; }
		const id = Number(match[1]);
		const check = worker.pending.get(id);
		if (!check) return;
		clearTimeout(check.timer);
		worker.pending.delete(id);
		if (match[2] === "OK") check.resolve(); else check.reject();
		scheduleIdle(worker);
	});
	return worker;
}

/** Only local storage paths travel over the pipe; relay credentials never do. */
export async function validateWindowsAccess(root: string, paths: readonly string[], ensure: boolean): Promise<void> {
	if (process.platform !== "win32") return;
	const worker = getValidator();
	if (worker.idle) { clearTimeout(worker.idle); worker.idle = undefined; }
	const id = ++sequence;
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => retire(worker), 10_000);
		worker.pending.set(id, { resolve, reject: () => reject(failure()), timer });
		worker.child.stdin.write(`${JSON.stringify({ id, root, paths, ensure })}\n`, (error) => {
			if (error) retire(worker);
		});
	});
}
