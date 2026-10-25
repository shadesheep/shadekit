import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildConfigPackageSnapshot } from "./config-package.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("参数必须是 --name value 形式");
    args[argv[index].slice(2)] = argv[index + 1];
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  for (const required of ["spec", "name", "url", "out"]) {
    if (!args[required]) throw new Error(`必须提供 --${required}`);
  }
  let spec;
  try {
    spec = JSON.parse(await readFile(args.spec, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 JSON ${args.spec}: ${error.message}`);
  }
  const result = buildConfigPackageSnapshot({
    spec,
    name: args.name,
    url: args.url,
    ...(args["login-method"] ? { loginMethod: args["login-method"] } : {}),
    ...(args["required-vars"] !== undefined ? { requiredVars: args["required-vars"] === "" ? [] : args["required-vars"].split(",") } : {}),
  });
  if (result.issues.length > 0 || !result.package) {
    console.log(JSON.stringify({ status: "FAILED", issues: result.issues }, null, 2));
    return 1;
  }
  const serialized = `${JSON.stringify(result.package, null, 2)}\n`;
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, serialized, "utf8");
  console.log(serialized.trimEnd());
  return 0;
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.log(JSON.stringify({ status: "FAILED", message: error.message }, null, 2));
    process.exitCode = 1;
  });
}
