/**
 * 兼容的数据池入口。语言相关数据位于 locales，招投标与技术领域池位于 domains；
 * 底层随机函数均接受可选 rng，旧的直接调用仍使用非确定性随机数。
 */
import {
  generateAddress as generateLocalizedAddress,
  generateCompany as generateLocalizedCompany,
  generateName as generateLocalizedName,
  ZH_CN,
} from "./locales";
import { generateProjectName as generateLocalizedProjectName } from "./domains/tender";
import {
  defaultRandom,
  pick,
  randomDigits,
  randomInt,
  randomString,
} from "./random";
import type { RandomSource } from "./random";

export {
  pick,
  randomDigits,
  randomFloat,
  randomInt,
  randomString,
} from "./random";
export { generateUrl } from "./domains/tech";
export {
  DOMAIN_SUFFIXES,
  FILE_EXTENSIONS,
  MIME_TYPES,
  USER_AGENTS,
} from "./domains/tech";
export {
  CONTRACT_TYPES,
  EVAL_METHODS,
  FUND_SOURCES,
  QUALIFICATION_LEVELS,
  QUALIFICATION_TYPES,
  SECTION_NAMES,
  TENDER_METHODS,
  generateBidBond,
  generateWinAmount,
} from "./domains/tender";

export const SURNAMES = ZH_CN.surnames;
export const GIVEN_NAMES_SINGLE = ZH_CN.givenNamesSingle;
export const GIVEN_NAMES_DOUBLE = ZH_CN.givenNamesDouble;
export const EMAIL_DOMAINS = ZH_CN.emailDomains;
export const PHONE_PREFIXES = ZH_CN.phonePrefixes;
export const PROVINCE_CITIES = ZH_CN.provinceCities;
export const PROVINCES = Object.keys(PROVINCE_CITIES);
export const DEPARTMENTS = ZH_CN.departments;
export const POSITIONS = ZH_CN.positions;
export const CURRENCIES = ZH_CN.currencies;

export function generateName(rng: RandomSource = defaultRandom): string {
  return generateLocalizedName("zh-CN", rng);
}

export function generateAddress(rng: RandomSource = defaultRandom): string {
  return generateLocalizedAddress("zh-CN", rng);
}

export function generateCompany(rng: RandomSource = defaultRandom): string {
  return generateLocalizedCompany("zh-CN", rng);
}

export function generateProjectName(rng: RandomSource = defaultRandom): string {
  return generateLocalizedProjectName("zh-CN", rng);
}

const BANK_CARD_PREFIXES = [
  "6225",
  "6222",
  "6228",
  "6229",
  "6227",
  "6223",
  "6226",
  "6217",
  "6214",
  "6212",
  "6210",
  "6205",
  "6200",
  "6250",
  "6251",
  "6258",
  "6259",
  "6260",
  "6264",
  "6265",
  "6270",
  "6271",
  "6272",
  "6273",
] as const;

export const BANK_NAMES = [
  "中国工商银行",
  "中国建设银行",
  "中国农业银行",
  "中国银行",
  "交通银行",
  "招商银行",
  "浦发银行",
  "中信银行",
  "光大银行",
  "华夏银行",
  "民生银行",
  "兴业银行",
  "平安银行",
  "广发银行",
  "北京银行",
  "上海银行",
] as const;

export function generateBankCard(rng: RandomSource = defaultRandom): string {
  return pick(BANK_CARD_PREFIXES, rng) + randomDigits(12, rng);
}

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK_CODES = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];

export function idCardCheckCode(first17: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(first17[i]) * ID_WEIGHTS[i];
  return ID_CHECK_CODES[sum % 11];
}

const ID_AREA_CODES = [
  "110101",
  "110105",
  "310104",
  "310110",
  "440103",
  "440305",
  "320102",
  "320505",
  "330103",
  "330106",
  "510104",
  "510107",
  "420102",
  "420111",
  "370102",
  "370202",
  "610103",
  "610113",
  "210102",
  "210202",
  "220102",
  "230102",
  "130102",
  "140102",
  "150102",
  "150202",
  "340102",
  "350102",
  "360102",
  "410102",
  "430102",
  "450102",
  "460102",
  "500102",
  "520102",
  "530102",
  "540102",
  "620102",
  "630102",
  "640102",
  "650102",
  "320104",
  "320105",
  "320106",
  "320111",
  "320113",
  "320114",
  "320115",
] as const;

export function generateIdCard(rng: RandomSource = defaultRandom): string {
  const area = pick(ID_AREA_CODES, rng);
  const year = randomInt(1965, 2003, rng);
  const month = String(randomInt(1, 12, rng)).padStart(2, "0");
  const day = String(randomInt(1, 28, rng)).padStart(2, "0");
  const seq = randomDigits(3, rng);
  const first17 = `${area}${year}${month}${day}${seq}`;
  return first17 + idCardCheckCode(first17);
}

export const USCC_CHARSET = "0123456789ABCDEFGHJKLMNPQRTUWXY";
const USCC_WEIGHTS = [
  1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28,
];

export function usccCheckCode(first17: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    sum += USCC_CHARSET.indexOf(first17[i]) * USCC_WEIGHTS[i];
  }
  return USCC_CHARSET[(31 - (sum % 31)) % 31];
}

export function generateUscc(rng: RandomSource = defaultRandom): string {
  const first17 = `91${pick(ID_AREA_CODES, rng)}${randomString(9, USCC_CHARSET, rng)}`;
  return first17 + usccCheckCode(first17);
}

const CN_DIGITS = "零壹贰叁肆伍陆柒捌玖";
const CN_SMALL_UNITS = ["", "拾", "佰", "仟"];
const CN_BIG_UNITS = ["", "万", "亿", "万亿"];

function fourToCn(value: number): string {
  let out = "";
  let pendingZero = false;
  for (let pos = 3; pos >= 0; pos -= 1) {
    const digit = Math.floor(value / 10 ** pos) % 10;
    if (digit === 0) {
      if (out) pendingZero = true;
    } else {
      if (pendingZero) {
        out += "零";
        pendingZero = false;
      }
      out += CN_DIGITS[digit] + CN_SMALL_UNITS[pos];
    }
  }
  return out;
}

export function toChineseCapital(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return "";
  if (amount === 0) return "零圆整";
  const totalCents = Math.round(amount * 100);
  let integerPart = Math.floor(totalCents / 100);
  const jiao = Math.floor((totalCents % 100) / 10);
  const fen = totalCents % 10;
  let intCn = "";
  if (integerPart > 0) {
    const groups: number[] = [];
    while (integerPart > 0) {
      groups.push(integerPart % 10000);
      integerPart = Math.floor(integerPart / 10000);
    }
    for (let g = groups.length - 1; g >= 0; g -= 1) {
      const value = groups[g];
      if (value === 0) continue;
      if (intCn && value < 1000) intCn += "零";
      intCn += fourToCn(value) + CN_BIG_UNITS[g];
    }
  }
  let frac = "";
  if (jiao === 0 && fen === 0) {
    frac = "整";
  } else {
    if (jiao > 0) frac += `${CN_DIGITS[jiao]}角`;
    else if (intCn && fen > 0) frac += "零";
    if (fen > 0) frac += `${CN_DIGITS[fen]}分`;
  }
  return (intCn ? `${intCn}圆` : "") + frac;
}

export const PLATE_PROVINCES = [
  "京",
  "沪",
  "津",
  "渝",
  "冀",
  "豫",
  "云",
  "辽",
  "黑",
  "湘",
  "皖",
  "鲁",
  "新",
  "苏",
  "浙",
  "赣",
  "鄂",
  "桂",
  "甘",
  "晋",
  "蒙",
  "陕",
  "吉",
  "闽",
  "贵",
  "粤",
  "川",
  "藏",
  "琼",
  "宁",
  "青",
] as const;

const PLATE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generatePlateNumber(rng: RandomSource = defaultRandom): string {
  return `${pick(PLATE_PROVINCES, rng)}${PLATE_LETTERS.charAt(Math.floor(rng() * PLATE_LETTERS.length))}${randomDigits(5, rng)}`;
}

export const COLOR_NAMES = [
  "红色",
  "蓝色",
  "绿色",
  "黄色",
  "紫色",
  "橙色",
  "粉色",
  "棕色",
  "黑色",
  "白色",
  "灰色",
  "青色",
  "金色",
  "银色",
  "米色",
  "驼色",
  "藏蓝色",
  "酒红色",
  "墨绿色",
  "浅蓝色",
  "深紫色",
  "卡其色",
] as const;

export const HEX_COLORS = [
  "#FF0000",
  "#0000FF",
  "#00FF00",
  "#FFFF00",
  "#800080",
  "#FFA500",
  "#FFC0CB",
  "#A52A2A",
  "#000000",
  "#FFFFFF",
  "#808080",
  "#00FFFF",
  "#FFD700",
  "#C0C0C0",
  "#F5F5DC",
  "#D2B48C",
  "#000080",
  "#800000",
] as const;

export const CN_SENTENCES = [
  "今天天气真不错，适合出去走走。",
  "这个项目进展顺利，预计月底可以完成。",
  "我们需要在下周之前提交报告。",
  "这个方案得到了领导的一致认可。",
  "技术团队正在加紧开发新功能。",
  "客户要求我们提供更多的设计方案。",
  "这次会议讨论了几个关键问题。",
  "市场部已经完成了季度推广计划。",
  "新产品的测试结果超出预期。",
  "人力资源部门正在组织培训活动。",
  "这个系统的性能优化效果显著。",
  "财务部门已完成年度预算编制。",
  "研发团队成功解决了一个技术难题。",
  "客服部门收到了大量用户反馈。",
  "公司决定扩大生产规模。",
  "这个季度的销售额同比增长了百分之二十。",
  "新政策对行业影响深远。",
  "这个项目具有重要的战略意义。",
  "团队协作效率显著提升。",
] as const;

export function generateCnParagraph(
  sentenceCount = 5,
  rng: RandomSource = defaultRandom,
): string {
  const sentences: string[] = [];
  for (let i = 0; i < sentenceCount; i += 1)
    sentences.push(pick(CN_SENTENCES, rng));
  return sentences.join("");
}

const PRODUCT_ADJECTIVES = [
  "智能",
  "高性能",
  "便携式",
  "多功能",
  "节能",
  "环保",
  "创新",
  "专业",
  "经典",
  "豪华",
  "时尚",
  "简约",
  "旗舰",
  "至尊",
  "灵动",
  "卓越",
  "精致",
  "优雅",
] as const;
const PRODUCT_NOUNS = [
  "手机",
  "电脑",
  "平板",
  "耳机",
  "音箱",
  "相机",
  "手表",
  "键盘",
  "鼠标",
  "显示器",
  "路由器",
  "充电器",
  "空调",
  "冰箱",
  "洗衣机",
  "电视",
  "微波炉",
  "净水器",
  "无人机",
  "机器人",
  "VR眼镜",
  "智能门锁",
  "扫地机器人",
] as const;
const PRODUCT_SERIES = [
  "Pro",
  "Max",
  "Plus",
  "Ultra",
  "Lite",
  "Air",
  "SE",
  "X",
  "S",
  "Mini",
  "Note",
  "Prime",
  "Series 1",
  "Series 2",
  "2024款",
  "2025款",
] as const;

export function generateProduct(rng: RandomSource = defaultRandom): string {
  return `${pick(PRODUCT_ADJECTIVES, rng)}${pick(PRODUCT_NOUNS, rng)} ${pick(PRODUCT_SERIES, rng)}`;
}

export function generateIpv4(rng: RandomSource = defaultRandom): string {
  return `${randomInt(1, 254, rng)}.${randomInt(0, 255, rng)}.${randomInt(0, 255, rng)}.${randomInt(1, 254, rng)}`;
}

export function generateIpv6(rng: RandomSource = defaultRandom): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i += 1)
    groups.push(randomString(4, "0123456789abcdef", rng));
  return groups.join(":");
}

export const WEEKDAYS = [
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
  "星期日",
] as const;
export const MONTHS = [
  "一月",
  "二月",
  "三月",
  "四月",
  "五月",
  "六月",
  "七月",
  "八月",
  "九月",
  "十月",
  "十一月",
  "十二月",
] as const;
export const ETHNIC_GROUPS = [
  "汉族",
  "汉族",
  "汉族",
  "汉族",
  "汉族",
  "壮族",
  "回族",
  "满族",
  "维吾尔族",
  "苗族",
  "彝族",
  "土家族",
  "藏族",
  "蒙古族",
  "侗族",
  "布依族",
  "瑶族",
  "白族",
  "朝鲜族",
  "哈尼族",
] as const;
export const EDUCATION_LEVELS = [
  "小学",
  "初中",
  "高中",
  "中专",
  "大专",
  "本科",
  "本科",
  "本科",
  "硕士研究生",
  "博士研究生",
  "博士后",
] as const;
export const MARITAL_STATUSES = ["未婚", "已婚", "离异", "丧偶"] as const;
export const BLOOD_TYPES = [
  "A型",
  "B型",
  "AB型",
  "O型",
  "Rh阴性A型",
  "Rh阴性B型",
] as const;
