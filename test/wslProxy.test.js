import { test } from "node:test";
import assert from "node:assert/strict";
import { PROXY_TASK_NAME, aliasToRegExp, findWslHostIp, ensureWslProxy, system32Exe } from "../src/wslProxy.js";

const ALIAS = "vEthernet (WSL*)";
const IFACES = {
  "Loopback": [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  "vEthernet (WSL (Hyper-V firewall))": [
    { address: "fe80::1", family: "IPv6", internal: false },
    { address: "172.28.0.1", family: "IPv4", internal: false }
  ]
};

test("system32Exe builds a full path from SystemRoot with a fallback", () => {
  assert.equal(system32Exe("netsh.exe", "D:\\Win"), "D:\\Win\\System32\\netsh.exe");
  assert.equal(system32Exe("netsh.exe", undefined), "C:\\Windows\\System32\\netsh.exe");
  assert.equal(system32Exe("schtasks.exe", "relative\\dir"), "C:\\Windows\\System32\\schtasks.exe");
});

test("aliasToRegExp handles wildcard and literal parentheses", () => {
  const re = aliasToRegExp(ALIAS);
  assert.ok(re.test("vEthernet (WSL (Hyper-V firewall))"));
  assert.ok(re.test("vEthernet (WSL)"));
  assert.ok(re.test("VETHERNET (wsl)"));
  assert.ok(!re.test("Ethernet"));
});

test("findWslHostIp skips internal and IPv6, null without match", () => {
  assert.equal(findWslHostIp(ALIAS, IFACES), "172.28.0.1");
  assert.equal(findWslHostIp(ALIAS, { Ethernet: IFACES.Loopback }), null);
  assert.equal(findWslHostIp(ALIAS, { "vEthernet (WSL)": [{ address: "10.0.0.1", family: 4, internal: false }] }), "10.0.0.1");
  assert.equal(findWslHostIp("vEthernet (WSL*)", { "vEthernet (WSL)": [{ address: "::1", family: "IPv6", internal: false }] }), null);
});

test("findWslHostIp ignores link-local 169.254.* addresses", () => {
  const ifaces = { "vEthernet (WSL)": [
    { address: "169.254.1.2", family: "IPv4", internal: false },
    { address: "172.28.0.1", family: "IPv4", internal: false }
  ] };
  assert.equal(findWslHostIp(ALIAS, ifaces), "172.28.0.1");
  assert.equal(findWslHostIp(ALIAS, { "vEthernet (WSL)": [ifaces["vEthernet (WSL)"][0]] }), null);
});

function setup({ enabled = true, interfaces = IFACES, results = [], timeoutMs = 20, pollMs = 5 } = {}) {
  const calls = [];
  const logs = [];
  const queue = [...results];
  const run = async (command, args) => {
    calls.push([command, ...args].join(" "));
    return queue.length ? queue.shift() : { code: 0, stdout: "" };
  };
  const logger = { log: m => logs.push(["log", m]), error: m => logs.push(["error", m]) };
  const config = { port: 7399, wslProxy: { enabled, interfaceAlias: ALIAS, wslSubnet: "172.16.0.0/12" } };
  const go = () => ensureWslProxy({
    config, logger, interfaces: () => interfaces, run, sleep: async () => {}, timeoutMs, pollMs, systemRoot: "D:\\Win"
  });
  return { go, calls, logs };
}

const SHOW = "D:\\Win\\System32\\netsh.exe interface portproxy show v4tov4";
const ACTIVE = { code: 0, stdout: "Listen on ipv4:\n\nAddress         Port        Address         Port\n--------------- ----------  --------------- ----------\n172.28.0.1      7399        127.0.0.1       7399\n" };
const EMPTY = { code: 0, stdout: "" };

test("disabled", async () => {
  const t = setup({ enabled: false });
  assert.equal(await t.go(), "disabled");
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.logs, [["log", "WSL proxy disabled in config.json"]]);
});

test("no-wsl", async () => {
  const t = setup({ interfaces: {} });
  assert.equal(await t.go(), "no-wsl");
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.logs, [["log", 'WSL network interface "vEthernet (WSL*)" not found (WSL not running or mirrored networking) - proxy skipped']]);
});

test("active never runs the task", async () => {
  const t = setup({ results: [ACTIVE] });
  assert.equal(await t.go(), "active");
  assert.deepEqual(t.calls, [SHOW]);
  assert.deepEqual(t.logs, [["log", "WSL proxy active: 172.28.0.1:7399 -> 127.0.0.1:7399"]]);
});

test("created after running the task", async () => {
  const t = setup({ results: [EMPTY, EMPTY, EMPTY, ACTIVE] });
  assert.equal(await t.go(), "created");
  assert.deepEqual(t.calls, [SHOW, `D:\\Win\\System32\\schtasks.exe /run /tn ${PROXY_TASK_NAME}`, SHOW, SHOW]);
  assert.deepEqual(t.logs, [["log", "WSL proxy ready: from WSL use http://172.28.0.1:7399"]]);
});

test("no-task when schtasks fails", async () => {
  const t = setup({ results: [EMPTY, { code: 1, stdout: "" }] });
  assert.equal(await t.go(), "no-task");
  assert.deepEqual(t.calls, [SHOW, `D:\\Win\\System32\\schtasks.exe /run /tn ${PROXY_TASK_NAME}`]);
  assert.deepEqual(t.logs, [["error", 'Cannot run scheduled task "wsl-ai-center proxy" - run setup.cmd once (needs admin)']]);
});

test("timeout when the proxy never appears", async () => {
  const t = setup({ timeoutMs: 10, pollMs: 5 });
  assert.equal(await t.go(), "timeout");
  assert.equal(t.logs.length, 1);
  assert.equal(t.logs[0][0], "error");
  assert.match(t.logs[0][1], /^WSL proxy not created within \d+(\.\d+)? s - see %ProgramFiles%\\wsl-ai-center\\wsl-proxy\.log$/);
});

test("never rejects", async () => {
  const logs = [];
  const result = await ensureWslProxy({
    config: { port: 1, wslProxy: { enabled: true, interfaceAlias: ALIAS } },
    logger: { log: () => {}, error: m => logs.push(m) },
    interfaces: () => IFACES, run: async () => { throw new Error("boom"); }, sleep: async () => {}
  });
  assert.equal(result, "timeout");
  assert.equal(logs.length, 1);
});
