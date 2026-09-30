#!/usr/bin/env python3
"""Manage a detached, loopback-only preview without installing a login service."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent


def health(port):
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f'http://127.0.0.1:{port}/api/health', timeout=1) as response:
            data = json.load(response)
        if data.get('service') == 'tingshui' and data.get('status') == 'ok':
            return data
    except (OSError, ValueError, AttributeError):
        pass
    return None


def occupied(port):
    with socket.socket() as sock:
        return sock.connect_ex(('127.0.0.1', port)) == 0


def private_file(path):
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        os.close(fd)
        raise ValueError(f'文件不是当前用户拥有的普通文件：{path}')
    os.fchmod(fd, 0o600)
    return fd


def token_from(path):
    with os.fdopen(private_file(path), 'r+') as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        token = file.read().strip()
        if not token:
            token = secrets.token_urlsafe(32)
            file.write(token)
            file.flush()
        if len(token) < 24:
            raise ValueError('管理令牌文件至少需要 24 字符；请修复后重试。')
        return token


def managed(state, current):
    return bool(current and state.get('instance') and
                state.get('instance') == current.get('instance') and
                state.get('pid') == current.get('pid'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'status', 'stop', 'restart'], nargs='?', default='start')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--db', type=Path, default=ROOT / 'catalog.sqlite3')
    parser.add_argument('--runtime-dir', type=Path, default=ROOT / '.runtime')
    parser.add_argument('--token-file', type=Path, default=Path('/tmp/tingshui-admin-token'))
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('端口必须介于 1 到 65535')
    args.runtime_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    state_file = args.runtime_dir / f'{args.port}.json'
    log_file = args.runtime_dir / f'{args.port}.log'
    with os.fdopen(private_file(args.runtime_dir / f'{args.port}.lock'), 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            state = json.loads(state_file.read_text())
        except (OSError, ValueError):
            state = {}
        current = health(args.port)
        if args.action == 'status':
            if current:
                print(f'听谁服务正常：http://127.0.0.1:{args.port}/ （' + ('由此启动器管理' if managed(state, current) else '已有服务') + '）')
                return 0
            print('端口被其他服务占用，或听谁未能通过健康检查。' if occupied(args.port) else '听谁服务尚未启动；运行 start 即可恢复。')
            return 1
        if args.action in ('stop', 'restart'):
            if occupied(args.port) and not managed(state, current):
                raise ValueError('未停止：该端口不是启动器可确认身份的服务。请在原启动终端关闭后重试。')
            if managed(state, current):
                os.kill(state['pid'], signal.SIGTERM)
                deadline = time.monotonic() + 5
                while occupied(args.port) and time.monotonic() < deadline:
                    time.sleep(.1)
                if occupied(args.port):
                    raise ValueError('服务未能在 5 秒内退出；请查看日志，不会强制杀死未知进程。')
            state_file.unlink(missing_ok=True)
            print('听谁服务已停止，目录数据保留。')
            if args.action == 'stop':
                return 0
            current = None
        if current:
            if managed(state, current) and state.get('db') != str(args.db.resolve()):
                raise ValueError('此端口已运行另一数据库；请选择其他端口。')
            print(f'听谁已在运行：http://127.0.0.1:{args.port}/ （无需重复启动）')
            return 0
        if occupied(args.port):
            raise ValueError('端口已被占用，且未通过听谁健康检查；请关闭原服务或使用 --port。')
        env = os.environ.copy()
        env['CATALOG_ADMIN_TOKEN'] = token_from(args.token_file)
        env['TINGSHUI_INSTANCE'] = secrets.token_hex(16)
        with os.fdopen(private_file(log_file), 'a') as log:
            log.write('\n--- 启动听谁本地服务 ---\n')
            log.flush()
            process = subprocess.Popen([sys.executable, str(ROOT / 'server.py'), '--port', str(args.port), '--db', str(args.db.resolve())],
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                       start_new_session=True, cwd=str(ROOT.parent), env=env)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and process.poll() is None:
            current = health(args.port)
            if current and current.get('instance') == env['TINGSHUI_INSTANCE']:
                with os.fdopen(private_file(state_file), 'w') as file:
                    json.dump({'pid': process.pid, 'instance': env['TINGSHUI_INSTANCE'], 'db': str(args.db.resolve())}, file)
                print(f'听谁已启动：http://127.0.0.1:{args.port}/\n关闭此终端仍可继续测试。日志：{log_file}\n管理令牌保存在本机私密文件中，未写入日志。')
                return 0
            time.sleep(.15)
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
        raise ValueError(f'启动失败，或健康检查超时。请检查日志：{log_file}')


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f'听谁：{exc}', file=sys.stderr)
        sys.exit(1)
