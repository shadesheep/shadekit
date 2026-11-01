import {
  defaultRandom,
  pick,
  randomDigits,
  randomInt,
  randomString,
} from "../random";
import type { RandomSource } from "../random";
import type { LocaleId } from "../types";
import { EN_US } from "./en-US";
import type { LocaleData } from "./locale-types";
import { ZH_CN } from "./zh-CN";

const LOCALES: Record<LocaleId, LocaleData> = {
  "zh-CN": ZH_CN,
  "en-US": EN_US,
};

export function getLocaleData(locale: LocaleId = "zh-CN"): LocaleData {
  return LOCALES[locale] ?? ZH_CN;
}

export function generateName(
  locale: LocaleId = "zh-CN",
  rng: RandomSource = defaultRandom,
): string {
  const data = getLocaleData(locale);
  const given =
    locale === "zh-CN" && rng() < 0.65
      ? pick(data.givenNamesDouble, rng)
      : pick(data.givenNamesSingle, rng);
  return locale === "zh-CN"
    ? `${pick(data.surnames, rng)}${given}`
    : `${given} ${pick(data.surnames, rng)}`;
}

export function generatePhone(
  locale: LocaleId = "zh-CN",
  rng: RandomSource = defaultRandom,
): string {
  const data = getLocaleData(locale);
  return locale === "zh-CN"
    ? `${pick(data.phonePrefixes, rng)}${randomDigits(8, rng)}`
    : `+1-${pick(data.phonePrefixes, rng)}-555-${randomDigits(4, rng)}`;
}

export function generateAddress(
  locale: LocaleId = "zh-CN",
  rng: RandomSource = defaultRandom,
): string {
  const data = getLocaleData(locale);
  const provinces = Object.keys(data.provinceCities);
  const province = pick(provinces, rng);
  const city = pick(data.provinceCities[province], rng);
  const no = randomInt(1, 1999, rng);
  if (locale === "en-US") {
    return `${no} ${pick(data.streets, rng)}, ${city}, ${province} ${randomDigits(5, rng)}`;
  }
  const district = pick(data.districts, rng);
  const street = pick(data.streets, rng);
  return city === province
    ? `${province}${district}${street}${no}号`
    : `${province}${city}${district}${street}${no}号`;
}

export function generateCompany(
  locale: LocaleId = "zh-CN",
  rng: RandomSource = defaultRandom,
): string {
  const data = getLocaleData(locale);
  if (locale === "en-US") {
    return `${pick(data.companyNames, rng)} ${pick(data.companyIndustries, rng)} ${pick(data.companySuffixes, rng)}`;
  }
  const provinces = Object.keys(data.provinceCities);
  const province = pick(provinces, rng);
  const city = pick(data.provinceCities[province], rng).replace(/市$/, "");
  return `${city}${pick(data.companyNames, rng)}${pick(data.companyIndustries, rng)}${pick(data.companySuffixes, rng)}`;
}

export function generateEmail(
  locale: LocaleId = "zh-CN",
  rng: RandomSource = defaultRandom,
): string {
  const localPart = randomString(
    randomInt(6, 12, rng),
    "abcdefghijklmnopqrstuvwxyz0123456789",
    rng,
  );
  return `${localPart}@${pick(getLocaleData(locale).emailDomains, rng)}`;
}

export { EN_US, ZH_CN };
export type { LocaleData } from "./locale-types";
