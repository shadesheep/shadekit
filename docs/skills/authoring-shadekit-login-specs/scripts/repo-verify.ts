import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { validateDeliverables } from "./validate.mjs";

type Issue = { code?: string; rule?: string; opIndex?: number; varName?: string; path?: string; message: string };
type VerificationInput = { repo: string; spec: unknown; package: unknown };

function issueShape(issues: Issue[]) {
  return issues.map(({ code, rule, opIndex, varName, path }) => ({ code, rule, opIndex, varName, path }));
}

function different(label: string, official: unknown, snapshot: unknown) {
  return isDeepStrictEqual(official, snapshot) ? [] : [label];
}

async function exists(path: string) {
  try { await access(path); return true; } catch { return false; }
}

async function identifyRepository(repo: string) {
  const root = resolve(repo);
  const packagePath = resolve(root, "package.json");
  const validatePath = resolve(root, "entrypoints/tools/account-switch/spec/validate.ts");
  const packageModulePath = resolve(root, "entrypoints/tools/account-switch/spec/package.ts");
  if (!(await exists(packagePath)) || !(await exists(validatePath)) || !(await exists(packageModulePath))) return undefined;
  try {
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    if (manifest.name !== "shadekit") return undefined;
  } catch { return undefined; }
  return { root, validatePath, packageModulePath };
}

function notRun(message: string, snapshot: ReturnType<typeof validateDeliverables>) {
  return {
    status: "NOT_RUN" as const,
    official: { specIssues: [], packageIssues: [], packageMatches: false },
    snapshot,
    differences: [message],
  };
}

export function verificationStatus(input: { snapshotFailed: boolean; officialFailed: boolean; differences: string[] }) {
  return !input.snapshotFailed && !input.officialFailed && input.differences.length === 0
    ? "REPO_VERIFIED" as const
    : "FAILED" as const;
}

export async function verifyWithRepository(input: VerificationInput) {
  const snapshot = validateDeliverables({ spec: input.spec, package: input.package });
  const repository = await identifyRepository(input.repo);
  if (!repository) return notRun("仓库不存在或不是 ShadeKit 根目录", snapshot);
  if (!(await exists(resolve(repository.root, "node_modules/tsx/package.json")))) {
    return notRun("仓库依赖 tsx 不可用；未自动安装依赖", snapshot);
  }

  const validateModule = await import(pathToFileURL(repository.validatePath).href);
  const packageModule = await import(pathToFileURL(repository.packageModulePath).href);
  const officialSpecIssues = validateModule.validateLoginSpec(input.spec) as Issue[];
  const officialPackageIssues = packageModule.validateConfigPackage(input.package) as Issue[];
  const differences = [
    ...different("LoginSpec 静态校验结果不一致", issueShape(officialSpecIssues), issueShape(snapshot.specIssues)),
    ...different("策略包校验结果不一致", issueShape(officialPackageIssues), issueShape(snapshot.packageIssues)),
  ];

  let packageMatches = false;
  const raw = input.package as { environments?: Array<{ name?: string; url?: string; loginMethod?: string }>; requiredVars?: Array<{ name?: string }> };
  const environment = raw?.environments?.[0];
  if (environment?.name && environment.url && raw.environments?.length === 1) {
    const requiredVars = (raw.requiredVars ?? []).flatMap((item) => typeof item.name === "string" ? [item.name] : []);
    const built = packageModule.buildConfigPackage({
      name: environment.name,
      tags: [],
      loginMethod: environment.loginMethod,
      strategyConfig: { spec: input.spec },
    }, environment.url, requiredVars);
    packageMatches = !built.package && !input.package ? true : Boolean(
      built.package && isDeepStrictEqual(JSON.parse(JSON.stringify(built.package)), input.package),
    );
    if (built.issues.length > 0) officialPackageIssues.push(...built.issues);
    if (!packageMatches) differences.push("官方 buildConfigPackage 构造结果与交付包不一致");
  } else {
    differences.push("官方包构造需要且仅支持一个具有 name/url 的环境");
  }

  const snapshotFailed = Object.values(snapshot).some((issues) => issues.length > 0);
  const officialFailed = officialSpecIssues.length > 0 || officialPackageIssues.length > 0 || !packageMatches;
  return {
    status: verificationStatus({ snapshotFailed, officialFailed, differences }),
    official: { specIssues: officialSpecIssues, packageIssues: officialPackageIssues, packageMatches },
    snapshot,
    differences,
  };
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("参数必须是 --name value 形式");
    args[argv[index].slice(2)] = argv[index + 1];
  }
  return args;
}

async function readJson(path: string) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`无法读取 JSON ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function main(argv: string[]) {
  const args = parseArgs(argv);
  if (!args.spec || !args.package) throw new Error("必须提供 --spec 与 --package");
  const [spec, pkg] = await Promise.all([readJson(args.spec), readJson(args.package)]);
  const result = await verifyWithRepository({
    repo: args.repo ?? process.env.SHADEKIT_REPO ?? process.cwd(),
    spec,
    package: pkg,
  });
  console.log(JSON.stringify(result, null, 2));
  return result.status === "REPO_VERIFIED" ? 0 : result.status === "NOT_RUN" ? 2 : 1;
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.log(JSON.stringify({ status: "FAILED", message: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  });
}
