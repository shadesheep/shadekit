import { defaultRandom, pick, randomInt, randomString } from "../random";
import type { RandomSource } from "../random";

export const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
] as const;

export const MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "text/html",
  "text/css",
  "text/plain",
  "text/csv",
  "application/json",
  "application/xml",
  "application/pdf",
  "application/zip",
  "video/mp4",
  "audio/mpeg",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

export const FILE_EXTENSIONS = [
  "jpg",
  "png",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "csv",
  "json",
  "zip",
  "mp4",
  "gif",
  "bmp",
  "tiff",
  "rar",
  "7z",
  "mp3",
  "wav",
  "avi",
  "mov",
  "html",
  "css",
  "js",
  "ts",
  "vue",
] as const;

export const DOMAIN_SUFFIXES = [
  "com",
  "cn",
  "net",
  "org",
  "com.cn",
  "net.cn",
  "gov.cn",
] as const;

const URL_PATHS = [
  "/",
  "/home",
  "/about",
  "/products",
  "/services",
  "/api/list",
  "/api/detail",
  "/news",
  "/contact",
  "/login",
  "/register",
  "/user/profile",
  "/dashboard",
  "/api/v1/users",
  "/api/v1/products",
  "/api/v1/orders",
  "/blog",
  "/faq",
  "/terms",
  "/privacy",
  "/search",
  "/cart",
  "/checkout",
  "/help",
  "/support",
] as const;

export function generateUrl(rng: RandomSource = defaultRandom): string {
  const proto = rng() < 0.8 ? "https" : "http";
  const host = randomString(
    randomInt(4, 10, rng),
    "abcdefghijklmnopqrstuvwxyz",
    rng,
  );
  return `${proto}://www.${host}.${pick(DOMAIN_SUFFIXES, rng)}${pick(URL_PATHS, rng)}`;
}
