#!/usr/bin/env bash
# 决定这次发布用哪个版本号 —— 当这个号已经发过时该怎么办。
#
#   scripts/resolve-version.sh <版本号> <pre|overwrite|fail>
#
# 打印四行 KEY=VALUE (直接 >> "$GITHUB_OUTPUT" 即可):
#   version=0.10.1-pre.1
#   vtag=v0.10.1-pre.1
#   prerelease=true
#   overwrite=false
#
# ── 为什么不是"已存在就报错, 你去升版本号" ───────────────────────────────
# 重跑一次发布是常事: CI 修了、部署产物改了、上一次发到一半挂了。如果每次都被
# 迫升一位正式版号, 版本号就变成了"我点了几次 Run workflow"的计数器, 而不是
# "东西变了多少"。所以默认走 pre: 不动任何已经发出去的东西, 另发一个
# <版本>-pre.N (N 自增)。
#
# ── 三种策略 ────────────────────────────────────────────────────────────
#   pre        (默认) 已存在 → 发 <版本>-pre.N。已发布的 tag / 镜像一个不动。
#   overwrite  已存在 → 就用这个号, 调用方负责把 tag 移过来、把镜像顶掉。
#              **已经按这个 tag 部署的机器, 下次 pull 会拿到不同的内容。**
#   fail       已存在 → 直接失败。
#
# ── 一个必须守住的性质 ──────────────────────────────────────────────────
# -pre.N 一律算预发布, 所以调用方的 "latest 指向最大正式版" 逻辑不会把 latest
# 挪到它身上。否则重跑一次发布就会把线上 latest 从稳定版换成一个临时产物。
set -euo pipefail

VERSION="${1:?用法: resolve-version.sh <版本号> <pre|overwrite|fail>}"
MODE="${2:-pre}"
VERSION="${VERSION#v}"
VTAG="v${VERSION}"
OVERWRITE=false

tag_exists() { git rev-parse -q --verify "refs/tags/$1" >/dev/null 2>&1; }

if tag_exists "${VTAG}"; then
  case "${MODE}" in
    fail)
      echo "::error::tag ${VTAG} 已经存在。换个版本号, 或把冲突策略改成 pre / overwrite。" >&2
      exit 1
      ;;
    overwrite)
      OVERWRITE=true
      echo "::warning::${VTAG} 已存在, 按 overwrite 覆盖 —— tag 会移到当前 commit, Release 资产与同名镜像都会被顶掉。已经按这个 tag 部署的机器, 下次 pull 会拿到不同的内容。" >&2
      ;;
    pre)
      # 已有的 <vtag>-pre.N 里最大的 N, 往后排一个。
      # 注意用 sort -n 而不是 sort: pre.10 要排在 pre.9 后面。
      # `|| true` 不能省: 一个 -pre.N 都还没有时 grep 无匹配返回 1, 配上
      # `set -o pipefail` 会让整个命令替换失败, 再被 `set -e` 直接杀掉脚本 ——
      # 而"第一次遇到冲突"恰恰是最常走的那条路。
      N="$(
        {
          git tag -l "${VTAG}-pre.*" \
            | sed "s|^${VTAG}-pre\.||" \
            | grep -E '^[0-9]+$' \
            | sort -n | tail -1
        } || true
      )"
      VERSION="${VERSION}-pre.$(( ${N:-0} + 1 ))"
      VTAG="v${VERSION}"
      echo "::notice::原版本号已发布过, 这次发 ${VTAG}" >&2
      ;;
    *)
      echo "::error::未知的冲突策略 '${MODE}' (只支持 pre / overwrite / fail)" >&2
      exit 2
      ;;
  esac
fi

# 带任何预发布后缀的都算预发布 —— 决定 GitHub Release 的 prerelease 标记,
# 也决定它不该抢走 latest。
case "${VERSION}" in
  *-rc*|*-beta*|*-alpha*|*-pre*|*-dev*) PRERELEASE=true ;;
  *)                                    PRERELEASE=false ;;
esac

echo "version=${VERSION}"
echo "vtag=${VTAG}"
echo "prerelease=${PRERELEASE}"
echo "overwrite=${OVERWRITE}"
