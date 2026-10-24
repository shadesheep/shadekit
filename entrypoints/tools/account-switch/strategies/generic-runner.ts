/**
 * 配方插值
 *
 * 本模块只保留登录声明的插值函数（`interpolateTemplate`），供配方(q)的
 * 单步试跑（`generic-dry-run`）与旧 recipe 环境复用。
 */

import type { AuthContext } from "../types";
import type { RecipeVariableName } from "./generic-recipe";

export type { RecipeStepTrace } from "../spec/types";

type Variables = Record<string, unknown>;

/** 插值：支持 `{name}` 与 `{step.<as>.<field>}`；未命中的占位符原样保留 */
export function interpolateTemplate(
  template: string,
  vars: Variables,
): string {
  return template.replace(/\{([\w.-]+)\}/g, (match, key: string) => {
    const parts = key.split(".");
    let value: unknown = vars;
    for (const part of parts) {
      if (value && typeof value === "object" && part in (value as object)) {
        value = (value as Variables)[part];
      } else {
        return match;
      }
    }
    return value === null || value === undefined ? "" : String(value);
  });
}

/**
 * 基础变量表（账号 / origin 等；密码只在本进程内存中使用，不落盘）。
 *
 * 供 recipe 插值与单步试跑使用；key 用 `RecipeVariableName` 收窄：
 * 新增基础变量必须先登记到 `generic-recipe` 的 `RECIPE_VARIABLE_NAMES`
 * （配置页变量胶囊同源，ADR-0013 D10）。
 */
export function buildRecipeVariables(
  ctx: AuthContext,
): Record<RecipeVariableName, string> & Variables {
  return {
    origin: ctx.origin,
    username: ctx.credentials.username,
    password: ctx.credentials.password,
    debugRedirect: ctx.domainConfig.debugRedirect ?? "",
    tabId: String(ctx.tabId),
  };
}