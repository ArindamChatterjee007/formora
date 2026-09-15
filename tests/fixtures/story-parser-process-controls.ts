const input = new Uint8Array(1);
if (await Deno.stdin.read(input) !== 1) throw new Error("fixture_input_missing");
if (Deno.args[0] === "wasm") {
  const module = new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0,
    1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 7, 1, 3, 114, 117, 110, 0, 0,
    10, 9, 1, 7, 0, 3, 64, 12, 0, 11, 11]));
  const instance = new WebAssembly.Instance(module);
  Deno.stdout.writeSync(new TextEncoder().encode('{"wasm_started":true}'));
  (instance.exports.run as () => void)();
} else if (Deno.args[0] === "permissions") {
  const probes: Array<[Deno.PermissionName, () => unknown]> = [
    ["read", () => Deno.readTextFile("/etc/hosts")],
    ["write", () => Deno.writeTextFile("/formora-forbidden-write", "fixture")],
    ["net", () => fetch("http://127.0.0.1:65534/forbidden")],
    ["run", () => new Deno.Command("/bin/true").output()],
    ["ffi", () => Deno.dlopen("/formora-forbidden-library", {})],
    ["sys", () => Deno.systemMemoryInfo()],
  ];
  for (const [name] of probes) {
    if ((await Deno.permissions.query({ name })).state !== "denied") throw new Error("explicit_denial_missing");
  }
  const denied = [];
  for (const [name, invoke] of probes) {
    let refused = false;
    try { await invoke(); }
    catch (error) {
      if (!(error instanceof Deno.errors.NotCapable)) throw new Error("wrong_denial");
      refused = true;
    }
    if (!refused) throw new Error("permission_escape");
    denied.push(name);
  }
  Deno.stdout.writeSync(new TextEncoder().encode(JSON.stringify({ denied })));
} else throw new Error("unknown_fixture");