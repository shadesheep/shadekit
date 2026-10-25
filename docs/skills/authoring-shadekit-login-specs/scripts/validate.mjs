import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { validateLoginSpecSnapshot } from "./login-spec-validator.mjs";
import { findSessionGateIssues } from "./session-gate.mjs";
import { validateConfigPackageSnapshot } from "./config-package.mjs";

export function validateDeliverables(input) {
  const specIssues = validateLoginSpecSnapshot(input.spec);
  const packageIssues = validateConfigPackageSnapshot(input.package);
  const equalityIssues = [];
  const environments = input.package && Array.isArray(input.package.environments) ? input.package.environments : [];
  environments.forEach((environment, index) => {
    if (environment && "spec" in environment && !isDeepStrictEqual(environment.spec, input.spec)) {
      equalityIssues.push({
        code: "CONFIG_INVALID",
        message: `environments[${index}].spec 与独立 LoginSpec 不一致`,
        path: `environments[${index}].spec`,
      });
    }
  });
  const gateIssues = specIssues.length === 0 ? findSessionGateIssues(input.spec) : [];
  return { specIssues, packageIssues, equalityIssues, gateIssues };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("参数必须是 --name value 形式");
    args[argv[index].slice(2)] = argv[index + 1];
  }
  return args;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 JSON ${path}: ${error.message}`);
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.spec || !args.package) throw new Error("必须提供 --spec 与 --package");
  const [spec, pkg] = await Promise.all([readJson(args.spec), readJson(args.package)]);
  const result = validateDeliverables({ spec, package: pkg });
  const failed = Object.values(result).some((issues) => issues.length > 0);
  console.log(JSON.stringify({ status: failed ? "FAILED" : "SNAPSHOT_STATIC_VALIDATED", ...result }, null, 2));
  return failed ? 1 : 0;
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.log(JSON.stringify({ status: "FAILED", message: error.message }, null, 2));
    process.exitCode = 1;
  });
}
