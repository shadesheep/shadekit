import { getLocaleData } from "../locales";
import { defaultRandom, pick } from "../random";
import type { RandomSource } from "../random";
import type { LocaleId } from "../types";

export const PROJECT_SUBJECTS = [
  "城市快速路改造工程",
  "污水处理厂二期扩建工程",
  "智慧园区管理系统建设",
  "办公楼装修改造工程",
  "教学设备采购项目",
  "医疗设备采购项目",
  "市政道路提升改造工程",
  "景观绿化提升工程",
  "消防系统工程",
  "电梯采购及安装项目",
  "安防监控系统建设",
  "数据中心建设工程",
  "新能源汽车充电桩建设项目",
  "高标准农田建设项目",
  "河道综合治理工程",
  "保障性住房建设工程",
  "教学楼改扩建工程",
  "门诊楼建设工程",
  "图书馆图书采购项目",
  "交通信号灯改造工程",
  "老旧小区改造工程",
  "地下综合管廊建设工程",
  "光伏发电站建设项目",
  "供水管网改造工程",
  "智慧城市信息化建设项目",
  "电子政务系统升级工程",
  "公共卫生服务中心建设",
  "体育场馆建设工程",
  "文化艺术中心装修工程",
  "养老院设备采购项目",
  "污水处理厂提标改造工程",
  "垃圾分类处理系统建设",
  "停车场智能管理系统",
  "城市照明节能改造工程",
  "燃气管网改造工程",
  "热力管网改造工程",
  "水利枢纽工程",
  "水库除险加固工程",
  "灌区续建配套工程",
  "高速公路建设项目",
  "铁路枢纽改造工程",
  "机场扩建工程",
  "港口码头建设项目",
  "物流园区建设工程",
  "产业园区基础设施配套",
] as const;

const PROJECT_SUBJECTS_EN = [
  "Smart Campus Management System",
  "Data Center Construction",
  "Network Upgrade",
  "Office Renovation",
  "Medical Equipment Procurement",
  "Cybersecurity Assessment",
  "Cloud Migration",
  "Public Safety Platform",
  "Energy Efficiency Modernization",
] as const;

/** 从地址中提取项目名称使用的地区前缀，无法识别时返回空串。 */
export function regionFromAddress(
  address: string,
  locale: LocaleId = "zh-CN",
): string {
  const data = getLocaleData(locale);
  if (locale === "en-US") {
    const parts = address.split(",").map((part) => part.trim());
    const city = parts[1] ?? "";
    const state = parts[2]?.split(/\s+/)[0] ?? "";
    if (!city) return "";
    return state ? `${city}, ${state}` : city;
  }
  for (const province of Object.keys(data.provinceCities)) {
    if (!address.startsWith(province)) continue;
    const city = data.provinceCities[province].find(
      (name) => name !== province && address.startsWith(province + name),
    );
    return city ?? province;
  }
  return "";
}

export function generateProjectName(
  locale: LocaleId = "zh-CN",
  rng: RandomSource = defaultRandom,
  region?: string,
): string {
  const source = region?.trim();
  if (locale === "en-US") {
    const subject = pick(PROJECT_SUBJECTS_EN, rng);
    const city = source
      ? regionFromAddress(source, locale).split(",")[0]?.trim()
      : "";
    return city ? `${city} ${subject}` : subject;
  }
  const data = getLocaleData(locale);
  const prefix =
    (source && regionFromAddress(source, locale)) ||
    pick(data.provinceCities[pick(Object.keys(data.provinceCities), rng)], rng);
  return `${prefix}${pick(PROJECT_SUBJECTS, rng)}`;
}
export const SECTION_NAMES = [
  "施工一标段",
  "施工二标段",
  "监理标段",
  "设备采购标段",
  "安装工程标段",
  "设计标段",
  "勘察标段",
  "系统集成标段",
  "第一标段",
  "第二标段",
  "第三标段",
  "第四标段",
  "A标段",
  "B标段",
  "C标段",
  "D标段",
  "土建标段",
  "安装标段",
  "装修标段",
  "弱电标段",
] as const;

export const TENDER_METHODS = [
  "公开招标",
  "公开招标",
  "公开招标",
  "邀请招标",
  "竞争性谈判",
  "竞争性磋商",
  "单一来源采购",
  "询价",
] as const;

export const QUALIFICATION_LEVELS = [
  "特级",
  "一级",
  "二级",
  "三级",
  "甲级",
  "乙级",
  "丙级",
  "A级",
  "B级",
  "C级",
] as const;

export const QUALIFICATION_TYPES = [
  "建筑工程施工总承包",
  "市政公用工程施工总承包",
  "机电工程施工总承包",
  "公路工程施工总承包",
  "水利水电工程施工总承包",
  "建筑装修装饰工程专业承包",
  "建筑机电安装工程专业承包",
  "消防设施工程专业承包",
  "防水防腐保温工程专业承包",
  "工程监理综合资质",
  "工程监理房屋建筑工程",
  "工程监理市政公用工程",
  "工程设计综合资质",
  "建筑行业设计",
  "市政行业设计",
] as const;

export const CONTRACT_TYPES = [
  "固定总价合同",
  "固定单价合同",
  "可调价格合同",
  "成本加酬金合同",
  "工程总承包合同",
  "施工承包合同",
  "专业分包合同",
  "劳务分包合同",
  "设计合同",
  "监理合同",
  "勘察合同",
  "咨询合同",
] as const;

export const FUND_SOURCES = [
  "财政拨款",
  "自筹资金",
  "银行贷款",
  "企业自筹",
  "中央预算内投资",
  "地方财政",
  "社会资本",
  "外商投资",
  "国有资金",
  "集体资金",
  "私人资金",
  "混合所有制",
] as const;

export function generateBidBond(rng: RandomSource = defaultRandom): number {
  return pick([5, 10, 20, 50, 80], rng) * 10000;
}

export function generateWinAmount(rng: RandomSource = defaultRandom): number {
  const value = 100 + rng() * (50000 - 100);
  return Number(value.toFixed(2));
}
