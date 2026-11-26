"""Dependency-free lifecycle manager for the Anti Addiction Antigravity plugin."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import zipfile

SOURCE = Path(__file__).resolve().parent
PLUGIN_ID = 'anti-addiction'
RUNTIME_FILES = ('plugin.json', 'assets', 'sidecars')
DIST_FILES = ('plugin.json', 'assets', 'sidecars', 'tests', 'manage.py', 'package.json',
              'install.ps1', 'uninstall.ps1', 'install.sh', 'uninstall.sh', 'README.md')
IGNORED = {'__pycache__', 'node_modules', '.git', 'dist', 'data', 'sdk'}


def home_dir():
    override = os.environ.get('AG_ANTI_ADDICTION_HOME')
    return Path(override).expanduser().resolve() if override else Path.home()


def plugin_dir():
    return home_dir() / '.gemini' / 'config' / 'plugins' / PLUGIN_ID


def data_dir():
    return home_dir() / '.gemini' / 'antigravity' / 'sidecar_data' / PLUGIN_ID / 'guardian' / 'data'


def json_read(file, default=None):
    if not file.exists():
        return {} if default is None else default
    return json.loads(file.read_text(encoding='utf-8-sig'))


def verify_plugin_target(target):
    plugins_root = (home_dir() / '.gemini' / 'config' / 'plugins').resolve()
    if target.is_symlink() or (target.exists() and target.resolve().parent != plugins_root):
        raise RuntimeError('Plugin destination must be a regular directory inside ~/.gemini/config/plugins/.')
    if target.exists():
        manifest = json_read(target / 'plugin.json')
        if manifest.get('name') != PLUGIN_ID:
            raise RuntimeError(f'Destination is not an {PLUGIN_ID} installation; refusing to overwrite.')


def install():
    target = plugin_dir()
    verify_plugin_target(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir(parents=True, exist_ok=True)

    ignore = shutil.ignore_patterns('__pycache__', '*.pyc', '*.log', 'node_modules', 'data', 'sdk')
    to_copy = [name for name in RUNTIME_FILES if (SOURCE / name).resolve() != (target / name).resolve()]
    if to_copy:
        staging = target.parent / f'.{PLUGIN_ID}.staging-{os.getpid()}'
        if staging.exists():
            shutil.rmtree(staging)
        try:
            staging.mkdir(parents=True, exist_ok=True)
            for name in to_copy:
                src, dst = SOURCE / name, staging / name
                if src.is_dir():
                    shutil.copytree(src, dst, ignore=ignore)
                else:
                    shutil.copy2(src, dst)
            for root_dir, _, files in os.walk(staging):
                rel_dir = Path(root_dir).relative_to(staging)
                dest_dir = target / rel_dir
                dest_dir.mkdir(parents=True, exist_ok=True)
                for filename in files:
                    os.replace(Path(root_dir) / filename, dest_dir / filename)
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    print(f'Installed Anti Addiction plugin to: {target}')
    print('Antigravity discovers user plugins automatically (restart or refresh plugins if sidecar is not yet running).')


def uninstall():
    target = plugin_dir()
    verify_plugin_target(target)
    if target.exists():
        shutil.rmtree(target)
        print(f'Removed Anti Addiction plugin from: {target}')
    else:
        print('Anti Addiction plugin is not installed.')


def status():
    target = plugin_dir()
    installed = (target / 'plugin.json').is_file()
    settings = json_read(data_dir() / 'settings.json', None)
    config = json_read(home_dir() / '.gemini' / 'config' / 'config.json', {})
    disabled = config.get('plugins', {}).get(PLUGIN_ID, {}).get('enabled') is False
    print(json.dumps({
        'installed': installed,
        'disabled': disabled,
        'pluginDirectory': str(target),
        'dataDirectory': str(data_dir()),
        'settings': settings,
    }, ensure_ascii=False, indent=2))


def package(output=None):
    version = json_read(SOURCE / 'plugin.json')['version']
    output = Path(output) if output else SOURCE / 'dist' / f'antigravity-anti-addiction-{version}.zip'
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for name in DIST_FILES:
            path = SOURCE / name
            if not path.exists():
                raise RuntimeError(f'Required release file missing: {name}')
            files = sorted(path.rglob('*')) if path.is_dir() else [path]
            for file in files:
                if not file.is_file() or any(p in IGNORED for p in file.relative_to(SOURCE).parts):
                    continue
                if file.suffix in {'.log', '.pyc'}:
                    continue
                bundle.write(file, Path('antigravity-anti-addiction') / file.relative_to(SOURCE))
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.zip.sha256').write_text(f'{digest}  {output.name}\n', encoding='utf-8')
    print(f'Package: {output}')
    print(f'SHA256: {digest}')


def main():
    parser = argparse.ArgumentParser(description='Anti Addiction Antigravity plugin manager')
    sub = parser.add_subparsers(dest='action', required=True)
    for action in ('install', 'uninstall', 'status'):
        sub.add_parser(action)
    pkg = sub.add_parser('package')
    pkg.add_argument('--output')
    args = parser.parse_args()
    try:
        if args.action == 'install':
            install()
        elif args.action == 'uninstall':
            uninstall()
        elif args.action == 'status':
            status()
        elif args.action == 'package':
            package(args.output)
    except (OSError, ValueError, RuntimeError) as error:
        print(f'Anti Addiction: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
