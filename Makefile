# ShadeKit 三商店发布
#
# 凭证（.env）：
#   Edge   PRODUCT_ID / CLIENT_ID / CLIENT_SECRET
#   Chrome CHROME_EXTENSION_ID / CHROME_PUBLISHER_ID
#          / CHROME_SERVICE_ACCOUNT_JSON（或 CLIENT_EMAIL + PRIVATE_KEY）
#   Firefox FIREFOX_EXTENSION_ID / FIREFOX_JWT_ISSUER / FIREFOX_JWT_SECRET
#          / FIREFOX_CHANNEL（listed 或 unlisted）
#
#   （Chrome 发布需本地代理 127.0.0.1:7890，release.mjs 自动检测注入）
#
# 用法：
#   make build                  构建 Chrome + Edge + Firefox zip 包（.output/）
#   make publish                构建并同时提交 Chrome + Edge + Firefox 商店审核
#
# 可选参数：
#   make publish DRY=1          干跑：只验证凭证，不上传不提交
#   make publish SKIP_BUILD=1   跳过构建，直接提交 .output 已有 zip
#   make publish ONLY=chrome    只发 Chrome（同理 ONLY=edge / firefox）
#
# 版本号流程：先 npm version patch（自动 commit + tag），再 make publish

SHELL := /bin/bash

.DEFAULT_GOAL := help

.PHONY: help build publish

help:
	@echo "用法:"
	@echo "  make build    构建 Chrome + Edge + Firefox zip 包"
	@echo "  make publish  构建并同时提交 Chrome + Edge + Firefox 商店审核"

## 构建三商店 zip 包
build:
	@npm run zip
	@npm run zip:edge
	@npm run zip:firefox
	@echo "✅ 构建完成: .output/shadekit-$$(node -p "require('./package.json').version")-{chrome,edge,firefox}.zip"

## 三商店一键发布（构建 → 提交审核）
publish:
	@node scripts/release.mjs \
		$(if $(DRY),--dry-run) \
		$(if $(SKIP_BUILD),--skip-build) \
		$(if $(filter chrome,$(ONLY)),--chrome-only) \
		$(if $(filter edge,$(ONLY)),--edge-only) \
		$(if $(filter firefox,$(ONLY)),--firefox-only)
