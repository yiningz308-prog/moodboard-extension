#!/bin/zsh
set -e

ROOT="${0:A:h}"
WEB_ROOT="$ROOT/web/moodboard/dist"

if [[ ! -f "$WEB_ROOT/index.html" ]]; then
  echo "没有找到网页构建文件：$WEB_ROOT/index.html"
  echo "请先在 web/moodboard 目录执行 pnpm build。"
  read "?按回车退出…"
  exit 1
fi

open "http://localhost:5173"
echo "个人灵感库已启动：http://localhost:5173"
echo "请保持这个窗口开启；按 Control+C 停止。"
cd "$WEB_ROOT"
python3 -m http.server 5173 --bind 127.0.0.1
