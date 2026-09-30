#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo '未找到 Python 3，请安装后重试。'
  read -r -p '按回车关闭。'
  exit 1
fi
if python3 prototype/dev.py start; then
  open 'http://127.0.0.1:8765/#discover'
else
  read -r -p '启动失败；请查看以上说明。按回车关闭。'
  exit 1
fi
