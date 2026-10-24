/**
 * 通用登录（generic）扁平参数的组合校验。
 *
 * 纯函数、无浏览器 API：DomainsPanel 保存前调用，错误定位到具体配置项。
 * 规则与执行器语义同源（strategies/generic-recipe.ts 的迁移函数）：
 * - successType 留空 = 默认 `any[formGone, urlChanged]`，不要求 successValue
 * - 一旦选择判定方式，判定值必填；timeout 的判定值必须是正数毫秒
 * - authSource 声明了来源，则 authKey 必填
 * - loginPageUrl 支持绝对地址、相对路径与 `{origin}` 占位
 */

/** 单条校验错误：field 对齐 SettingDefinition.name，便于行内渲染 */
export interface StrategyParamError {
  field: string;
  message: string;
}

type Params = Record<string, unknown>;

const SUCCESS_TYPES = new Set([
  "url",
  "selector",
  "cookie",
  "localStorage",
  "timeout",
]);

const AUTH_SOURCES = new Set(["", "cookie", "localStorage", "sessionStorage"]);

function text(params: Params, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

/** 登录页 URL：绝对地址 / 相对路径 / 含 `{origin}` 等占位符的写法 */
export function validateLoginPageUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  // 相对路径（含 query / hash / 占位符）直接放行：运行时以 tab origin 为基准
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
    if (/^javascript:/i.test(url)) return "登录页 URL 不能使用 javascript: 协议";
    return null;
  }
  if (!/^https?:\/\//i.test(url)) {
    return "登录页 URL 仅支持 http/https 或相对路径";
  }
  try {
    // 占位符 `{origin}` 等不是合法 URL 字符，替换后再解析
    new URL(url.replace(/\{[^}]*\}/g, "placeholder"));
    return null;
  } catch {
    return "登录页 URL 格式不正确";
  }
}

/**
 * 校验 generic 的扁平参数。非 generic 策略直接返回空数组。
 * 返回的错误按配置项顺序排列；同一字段最多一条。
 */
export function validateStrategyParams(
  loginMethod: string,
  params: Params = {},
): StrategyParamError[] {
  if (loginMethod !== "generic") return [];

  const errors: StrategyParamError[] = [];
  const successType = text(params, "successType");
  const successValue = text(params, "successValue");

  if (successType) {
    if (!SUCCESS_TYPES.has(successType)) {
      errors.push({
        field: "successType",
        message: "成功判定方式无效，请重新选择",
      });
    } else if (!successValue) {
      errors.push({
        field: "successValue",
        message: "请填写成功判定值（URL 通配符 / 选择器 / Cookie 名 / 存储键 / 毫秒数）",
      });
    } else if (successType === "timeout") {
      const ms = Number(successValue);
      if (!Number.isFinite(ms) || ms <= 0) {
        errors.push({
          field: "successValue",
          message: "固定等待必须是大于 0 的毫秒数",
        });
      }
    }
  } else if (successValue) {
    errors.push({
      field: "successType",
      message: "已填写成功判定值，请同时选择成功判定方式",
    });
  }

  const authSource = text(params, "authSource");
  if (!AUTH_SOURCES.has(authSource)) {
    errors.push({ field: "authSource", message: "认证数据提取方式无效" });
  } else if (authSource && !text(params, "authKey")) {
    errors.push({
      field: "authKey",
      message: "已声明认证数据来源，请填写认证键名（Cookie 名或存储键）",
    });
  }

  const timeout = params.successTimeout;
  if (timeout !== undefined && timeout !== null && timeout !== "") {
    const ms = Number(timeout);
    if (!Number.isFinite(ms) || ms <= 0) {
      errors.push({
        field: "successTimeout",
        message: "等待超时必须是大于 0 的毫秒数",
      });
    }
  }

  const urlError = validateLoginPageUrl(text(params, "loginPageUrl"));
  if (urlError) errors.push({ field: "loginPageUrl", message: urlError });

  return errors;
}
