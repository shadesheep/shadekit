import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { simulateLoginSpec } from "./simulator.mjs";

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
  if (!args.spec || !args.fixture) throw new Error("必须提供 --spec 与 --fixture");
  const [spec, fixture] = await Promise.all([readJson(args.spec), readJson(args.fixture)]);
  const result = await simulateLoginSpec(spec, fixture);
  console.log(JSON.stringify(result, null, 2));
  return result.status === "PASS" ? 0 : result.status === "NOT_SIMULATED" ? 2 : 1;
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.log(JSON.stringify({ status: "FAIL", issues: [error.message] }, null, 2));
    process.exitCode = 1;
  });
}
