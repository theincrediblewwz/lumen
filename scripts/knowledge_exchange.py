"""Offline copies only. Never writes an application repository or an existing folder."""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys

sys.dont_write_bytecode = True
import yaml
from jsonschema import Draft7Validator

ROOT = Path(__file__).absolute().parents[1]
CONTRACT = ROOT / 'contracts/historyandknowledge'
FORMAT = 'knowledge-document/v1'
EXCHANGE = 'lsq-historyandknowledge-exchange/v1'
PENDING_MANIFEST = '.exchange-manifest.pending'
MAX_DOCUMENT = 512 * 1024
MAX_PACKAGE = 32 * 1024 * 1024
KINDS = ('understanding', 'experience', 'material')
AUTHORS = ('user', 'source', 'ai_adopted')
PATHS = {'note': 'notes', 'article': 'articles', 'source': 'sources/documents'}
MARKER = re.compile(r'^HistoryandKnowledge · (note|article|source)/([A-Za-z0-9_.-]+) \[hk-v1:([0-9a-f]{24})\]$')


class ExchangeError(ValueError):
    pass


def check(condition, message):
    if not condition:
        raise ExchangeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + '\n').encode('utf-8')


def json_value(value, depth=0):
    check(depth <= 32, '元数据嵌套过深')
    if isinstance(value, dict):
        check(all(isinstance(k, str) for k in value), '元数据键必须是字符串')
        return {k: json_value(v, depth + 1) for k, v in value.items()}
    if isinstance(value, list):
        return [json_value(v, depth + 1) for v in value]
    check(value is None or isinstance(value, (str, bool, int, float)), '不支持非JSON元数据类型')
    check(not isinstance(value, float) or math.isfinite(value), '元数据不能含非有限数值')
    return value


def json_mapping(pairs):
    result = {}
    for key, value in pairs:
        check(key not in result, f'JSON重复键：{key}')
        result[key] = value
    return result


def parse_json(data):
    return json_value(json.loads(data, object_pairs_hook=json_mapping))


class DocumentLoader(yaml.SafeLoader):
    """Core scalar types; dates and yes/no remain strings, not YAML1.1 coercions."""
    yaml_implicit_resolvers = copy.deepcopy(yaml.SafeLoader.yaml_implicit_resolvers)


for first, rules in DocumentLoader.yaml_implicit_resolvers.items():
    DocumentLoader.yaml_implicit_resolvers[first] = [
        (tag, pattern) for tag, pattern in rules
        if tag not in ('tag:yaml.org,2002:bool', 'tag:yaml.org,2002:timestamp',
                       'tag:yaml.org,2002:int', 'tag:yaml.org,2002:float')]
DocumentLoader.add_implicit_resolver('tag:yaml.org,2002:bool', re.compile(r'^(?:true|True|TRUE|false|False|FALSE)$'), list('tTfF'))
DocumentLoader.add_implicit_resolver('tag:yaml.org,2002:int', re.compile(r'^[-+]?(?:0o[0-7]+|0x[0-9a-fA-F]+|[0-9]+)$'), list('-+0123456789'))
DocumentLoader.add_implicit_resolver('tag:yaml.org,2002:float', re.compile(r'^[-+]?(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?|\.inf|\.Inf|\.INF|\.nan|\.NaN|\.NAN)$'), list('-+0123456789.'))


def int_value(loader, node):
    value = loader.construct_scalar(node)
    sign = -1 if value.startswith('-') else 1
    value = value.lstrip('-+')
    return sign * int(value[2:] if value.startswith(('0o', '0x')) else value,
                      8 if value.startswith('0o') else 16 if value.startswith('0x') else 10)


def mapping_value(loader, node):
    pairs = []
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node)
        check(isinstance(key, str) and key != '<<', '文件头键必须是字符串，不能使用合并键')
        check(key not in [k for k, _ in pairs], f'文件头重复键：{key}')
        pairs.append((key, loader.construct_object(value_node)))
    return dict(pairs)


DocumentLoader.add_constructor('tag:yaml.org,2002:int', int_value)
DocumentLoader.add_constructor('tag:yaml.org,2002:map', mapping_value)


def schema_validator():
    source = parse_json((CONTRACT / 'SOURCE.json').read_text(encoding='utf-8-sig'))
    schema = (CONTRACT / 'knowledge-document-v1.schema.json').read_bytes()
    check(digest(schema) == source['sha256'], '公共Schema摘要不匹配，请复核合同来源')
    return Draft7Validator(parse_json(schema))


def regular_path(path):
    path = Path(path).absolute()
    # Inspect before resolving: resolve() would hide a symlink or junction.
    for current in [*reversed(path.parents), path]:
        info = current.lstat()
        check(not stat.S_ISLNK(info.st_mode) and not (getattr(info, 'st_file_attributes', 0) & 0x400),
              '源或目标路径包含符号链接/重解析点')
    return path


def relative_path(value):
    check(isinstance(value, str) and value and '\\' not in value and not re.match(r'^[A-Za-z]:', value), '无效相对路径')
    parts = value.split('/')
    check(not value.startswith('/') and all(p and p not in ('.', '..') and not p.endswith((' ', '.')) for p in parts), '路径越界或为空')
    check(all(not any(c in p for c in '\x00:*?"<>|') and not re.fullmatch(r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', p, re.I) for p in parts), '路径不能跨平台安全表示')
    return PurePosixPath(value)


def read_file(root, relative, limit):
    root = regular_path(root)
    path = regular_path(root / relative_path(relative))
    check(path.is_file() and path.stat().st_size <= limit, f'文件缺失或过大：{relative}')
    with path.open('rb') as stream:
        data = stream.read(limit + 1)
    check(len(data) <= limit, f'文件超过限制：{relative}')
    return data


def parse_document(data):
    check(len(data) <= MAX_DOCUMENT, '知识文档超过512KiB')
    text = data.decode('utf-8-sig', errors='strict')
    lines = text.splitlines(keepends=True)
    check(lines and lines[0].rstrip('\r\n') == '---', '知识文档缺少YAML文件头')
    end = next((i for i in range(1, len(lines)) if lines[i].rstrip('\r\n') == '---'), None)
    check(end is not None, 'YAML文件头没有结束标记')
    header = ''.join(lines[1:end])
    tokens = list(yaml.scan(header))
    check(len(tokens) <= 20000 and not any(isinstance(t, (yaml.tokens.AliasToken, yaml.tokens.AnchorToken, yaml.tokens.TagToken)) for t in tokens), '不支持YAML别名、锚点或自定义标签')
    depth = 0
    for token in tokens:
        if isinstance(token, (yaml.tokens.BlockMappingStartToken, yaml.tokens.BlockSequenceStartToken, yaml.tokens.FlowMappingStartToken, yaml.tokens.FlowSequenceStartToken)):
            depth += 1
            check(depth <= 32, 'YAML文件头嵌套过深')
        if isinstance(token, (yaml.tokens.BlockEndToken, yaml.tokens.FlowMappingEndToken, yaml.tokens.FlowSequenceEndToken)):
            depth -= 1
    metadata = json_value(yaml.load(header, Loader=DocumentLoader))
    check(isinstance(metadata, dict) and metadata.get('format') == FORMAT, '不支持的知识文档版本')
    errors = list(schema_validator().iter_errors(metadata))
    check(not errors, '知识文件头不符合HistoryandKnowledge v1 Schema')
    return metadata, ''.join(lines[end + 1:])


def document_bytes(metadata, body):
    result = ('---\n' + yaml.safe_dump(metadata, allow_unicode=True, sort_keys=False) + '---\n' + body).encode('utf-8')
    parse_document(result)
    return result


def put(files, path, data):
    relative_path(path)
    check(path.casefold() not in ('exchange-manifest.json', PENDING_MANIFEST) and not path.casefold().startswith(('.repository/', 'indexes/')), '不能输出writer状态、索引或成功标记作为附件')
    equivalent = next((key for key in files if key.casefold() == path.casefold()), None)
    check(equivalent is None or (equivalent == path and files[path] == data), '输出路径冲突或重复附件内容不一致')
    files[path] = data
    check(sum(map(len, files.values())) <= MAX_PACKAGE, '交换包超过32MiB')


def attachments(root, metadata, files):
    for attachment in metadata.get('attachments', []):
        path = attachment['path']
        check(path.casefold() not in ('knowledge-library.json', 'exchange-records.json', 'exchange-report.json'), '附件不能占用交换包清单路径')
        data = read_file(root, path, MAX_PACKAGE)
        check(len(data) == attachment['size_bytes'] and digest(data) == attachment['sha256'], '原件大小或SHA256不匹配')
        put(files, path, data)


def timestamp(value):
    check(isinstance(value, str) and len(value) <= 80, '知识时间格式无效')
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        check(parsed.tzinfo is not None, '时间缺少时区')
    except ValueError as error:
        raise ExchangeError('知识时间格式无效') from error
    return value


def import_time(value, now):
    # App-copy timestamps are not a claim about an opaque/legacy source date.
    try:
        return timestamp(value)
    except ExchangeError:
        return now


def identity(value):
    check(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value), '本应用知识ID无效')
    return value


def text_field(value, maximum, required=False):
    check(isinstance(value, str) and len(value.encode('utf-16-le')) // 2 <= maximum and (not required or value.strip()), '知识正文、标题或出处为空/超过本应用限制')
    return value


def validate_library(value):
    check(isinstance(value, dict) and value.get('format') == 'learnstuff-knowledge-library' and value.get('version') == 1, '请选择本应用v1知识导出文件')
    library = value.get('library')
    check(isinstance(library, dict) and library.get('version') == 1, '知识库版本不受支持')
    for table in ('entries', 'revisions', 'bindings', 'settings'):
        rows = library.get(table)
        check(isinstance(rows, list) and len(rows) <= 100000, '知识列表缺失或过大')
        check(all(isinstance(r, dict) for r in rows), '知识行格式无效')
        check(len({identity(r.get('id')) for r in rows}) == len(rows), '知识ID重复')
    entries = {row['id']: row for row in library['entries']}
    revisions = {row['id']: row for row in library['revisions']}
    for table in ('entries', 'revisions'):
        for row in library[table]:
            check(row.get('kind') in KINDS and row.get('authorship') in AUTHORS, '知识类型或作者无效')
            for field, limit, required in (('title', 200, True), ('body', 100000, True), ('source', 6000, False)):
                text_field(row.get(field), limit, required)
            timestamp(row.get('created_at'))
            basis = parse_json(text_field(row.get('basis_json'), 20000))
            owner = row['id'] if table == 'entries' else identity(row.get('entry_id'))
            check(owner in entries and isinstance(basis, list) and len(basis) <= 100 and all(isinstance(k, str) and k in entries and k != owner for k in basis), '知识依据不存在或引用自身')
    fields = ('kind', 'title', 'body', 'source', 'authorship', 'basis_json')
    for row in library['entries']:
        timestamp(row.get('updated_at'))
        revision = revisions.get(row.get('revision_id'))
        check(row.get('archived') in (0, 1) and not isinstance(row.get('archived'), bool), '归档状态无效')
        check(revision and revision['entry_id'] == row['id'] and all(revision[k] == row[k] for k in fields), '当前知识修订缺失或不一致')
    return library


def marker(kind, id):
    key = digest(f'{kind}/{id}'.encode('utf-8'))[:24]
    return f'HistoryandKnowledge · {kind}/{id} [hk-v1:{key}]'


def publish(output, files, sources):
    output = Path(output).absolute()
    check(not os.path.lexists(output), '目标目录已经存在；请使用新的目录，不会覆盖原资料')
    regular_path(output.parent)
    for source in sources:
        source = Path(source).absolute()
        check(not output.is_relative_to(source) and not source.is_relative_to(output), '输出目录不能位于源目录内或包含源目录')
    for path in files:
        relative_path(path)
    manifest = {'format': EXCHANGE, 'files': {p: {'sha256': digest(b), 'size_bytes': len(b)} for p, b in files.items()}}
    manifest_bytes = json_bytes(manifest)
    check(sum(map(len, files.values())) + len(manifest_bytes) <= MAX_PACKAGE, '交换包超过32MiB')
    output.mkdir()  # Exclusive directory; never deletes or replaces existing files.
    for relative, data in files.items():
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    # Only a complete package gets its manifest. Interrupted new output is retained.
    with (output / PENDING_MANIFEST).open('xb') as stream:
        stream.write(manifest_bytes)
        stream.flush()
        os.fsync(stream.fileno())
    check(not os.path.lexists(output / 'exchange-manifest.json'), '成功标记路径被占用')
    os.rename(output / PENDING_MANIFEST, output / 'exchange-manifest.json')
    return manifest


def load_base(root):
    raw = read_file(root, 'exchange-manifest.json', MAX_PACKAGE)
    manifest = parse_json(raw)
    check(isinstance(manifest, dict) and manifest.get('format') == EXCHANGE and isinstance(manifest.get('files'), dict), '交换包版本无效')
    files = {}
    for path, expected in manifest['files'].items():
        check(isinstance(expected, dict), '交换文件清单无效')
        data = read_file(root, path, MAX_PACKAGE)
        check(digest(data) == expected['sha256'] and len(data) == expected['size_bytes'], '交换包文件发生变化，请重新生成副本')
        put(files, path, data)
    metadata = parse_json(files['exchange-records.json'])
    check(isinstance(metadata, dict) and metadata.get('format') == EXCHANGE and isinstance(metadata.get('records'), list)
          and len(metadata['records']) <= 2000 and all(isinstance(r, dict) for r in metadata['records']), '交换记录清单无效')
    for record in metadata['records']:
        header, _ = parse_document(files[record['path']])
        check(header == record['metadata'] and record['marker'] == marker(header['record_type'], header['id']), '交换记录与原文文件头不一致')
        check(record['path'] == f"{PATHS[header['record_type']]}/{header['id']}.md", '交换记录路径不一致')
        attachments(root, header, {})
    return metadata['records'], files


def to_lsq(source, output):
    source = regular_path(source)
    files, records, entries, revisions = {}, [], [], []
    for record_type, folder in PATHS.items():
        directory = source / folder
        if not directory.exists():
            continue
        regular_path(directory)
        for path in sorted(directory.iterdir()):
            if path.suffix != '.md':
                continue
            relative = path.relative_to(source).as_posix()
            data = read_file(source, relative, MAX_DOCUMENT)
            metadata, body = parse_document(data)
            check(metadata['record_type'] == record_type and path.name == metadata['id'] + '.md', '文档类型、ID与路径不一致')
            key = marker(record_type, metadata['id'])
            check(all(r['marker'] != key for r in records), '公共知识ID重复')
            records.append({'marker': key, 'path': relative, 'metadata': metadata})
            check(len(records) <= 2000, '本次最多交换2000篇文档')
            put(files, relative, data)
            attachments(source, metadata, files)
            extension = metadata.get('extensions', {}).get('learnstuffquickly', {})
            check(isinstance(extension, dict), '本应用扩展命名空间无效')
            check(extension.get('exchange_version', 1) == 1, '本应用交换扩展版本不受支持')
            kind = extension.get('kind', 'understanding' if record_type == 'note' else 'material')
            check(kind in KINDS, '本应用知识类型无效')
            author = extension.get('authorship', 'user' if record_type == 'note' else 'source')
            check(author in AUTHORS, '本应用知识作者无效')
            now = dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
            original_source = text_field(extension.get('source', ''), 5500)
            entry_id = 'knowledge_hk_' + digest(key.encode())[:24]
            revision_id = 'revision_hk_' + digest(data)[:24]
            row = {'id': entry_id, 'kind': kind, 'title': metadata['title'], 'body': body,
                   'source': key + ('\n' + original_source if original_source else ''), 'authorship': author,
                   'basis_json': '[]', 'revision_id': revision_id, 'archived': 0,
                   'created_at': import_time(metadata.get('created_at'), now), 'updated_at': import_time(metadata.get('updated_at'), now)}
            entries.append(row)
            revision = {k: v for k, v in row.items() if k not in ('revision_id', 'archived', 'updated_at')}
            revisions.append({**revision, 'id': revision_id, 'entry_id': entry_id})
    check(records, '未找到正式v1知识文档；旧草案或无文件头文档不能自动当作v1')
    source_ids = {r['metadata']['id']: e['id'] for r, e in zip(records, entries) if r['metadata']['record_type'] == 'source'}
    for record, entry, revision in zip(records, entries, revisions):
        entry['basis_json'] = json.dumps(list(dict.fromkeys(source_ids[s] for s in record['metadata'].get('source_ids', []) if s in source_ids and source_ids[s] != entry['id'])))
        revision['basis_json'] = entry['basis_json']
    library = {'format': 'learnstuff-knowledge-library', 'version': 1, 'library': {'version': 1, 'entries': entries, 'revisions': revisions, 'bindings': [], 'settings': []}}
    validate_library(library)
    put(files, 'knowledge-library.json', json_bytes(library))
    put(files, 'exchange-records.json', json_bytes({'format': EXCHANGE, 'records': records}))
    warnings = ['原件、未知文件头、关系和原有历史保存在整个交换包；JSON单文件不含这些内容。',
                '应用内原件与相对链接阅读、HistoryandKnowledge writer接纳未接入。']
    put(files, 'exchange-report.json', json_bytes({'direction': 'to-lsq', 'records': len(records), 'permissionsTransferred': False, 'warnings': warnings}))
    return publish(output, files, [source])


def from_lsq(source, output, base=None):
    source = regular_path(source)
    library = validate_library(parse_json(read_file(source.parent, source.name, MAX_PACKAGE)))
    check(len(library['entries']) <= 2000, '本次最多交换2000条知识')
    base_records, base_files = load_base(base) if base else ([], {})
    by_marker = {r['marker']: r for r in base_records}
    check(len(by_marker) == len(base_records), '交换包来源标记重复')
    files, records, seen = {}, [], set()
    for entry in library['entries']:
        first, _, rest = entry['source'].partition('\n')
        imported = MARKER.fullmatch(first)
        check(not first.startswith('HistoryandKnowledge · ') or imported, '交换来源标记被改动，不能猜测原记录')
        old = by_marker.get(first)
        if imported:
            check(old is not None, '来自HistoryandKnowledge的知识需要携带原交换包 --base')
        if old:
            check(first not in seen, '同一来源有多个副本，请先确定要反馈的版本')
            seen.add(first)
            metadata = copy.deepcopy(old['metadata'])
            path = old['path']
            attachments(base, metadata, files)
            original_source = rest
        else:
            record_type = 'source' if entry['kind'] == 'material' else 'note'
            id = 'lsq_' + entry['id']
            metadata = {'format': FORMAT, 'record_type': record_type, 'id': id, 'title': entry['title'],
                        'created_at': entry['created_at'], 'updated_at': entry['updated_at']}
            if record_type == 'note':
                metadata['scope_type'] = 'global'
            path = f'{PATHS[record_type]}/{id}.md'
            original_source = entry['source']
        check(entry['archived'] == 0, '归档尚未定义跨应用删除语义，请先恢复或单独保留，不能静默删除')
        metadata['title'] = entry['title']
        namespace = metadata.setdefault('extensions', {}).setdefault('learnstuffquickly', {})
        check(isinstance(namespace, dict) and namespace.get('exchange_version', 1) == 1, '本应用扩展命名空间版本无效')
        history = namespace.get('revisions', [])
        check(isinstance(history, list), '交换历史格式无效')
        combined = {digest(json_bytes(r)): r for r in history + [r for r in library['revisions'] if r['entry_id'] == entry['id']]}
        namespace.update({'exchange_version': 1, 'kind': entry['kind'], 'authorship': entry['authorship'],
                          'source': original_source, 'basis_ids': parse_json(entry['basis_json']),
                          'revisions': list(combined.values()), 'current_revision': entry['revision_id']})
        key = marker(metadata['record_type'], metadata['id'])
        records.append({'marker': key, 'path': path, 'metadata': metadata})
        put(files, path, document_bytes(metadata, entry['body']))
    check(seen == set(by_marker), '原交换包条目有遗漏/来源标记已去掉；拒绝有损反馈')
    put(files, 'knowledge-library.json', json_bytes({'format': 'learnstuff-knowledge-library', 'version': 1, 'library': library}))
    put(files, 'exchange-records.json', json_bytes({'format': EXCHANGE, 'records': records}))
    warnings = ['这是离线副本，不是可直接覆盖的Vault；HistoryandKnowledge仍需由自己的writer接纳。',
                '原头的时间/关系保留，应用修改及不可变历史在extensions.learnstuffquickly；AI权限不转移。',
                '原件、历史和未知字段须连同整个交换包保留，当前未接入应用内附件/历史解析器。']
    put(files, 'exchange-report.json', json_bytes({'direction': 'from-lsq', 'records': len(records), 'permissionsTransferred': False, 'warnings': warnings}))
    return publish(output, files, [source, *([Path(base)] if base else [])])


def main():
    parser = argparse.ArgumentParser(description='HistoryandKnowledge v1 离线副本交换（不写原库）')
    parser.add_argument('direction', choices=['to-lsq', 'from-lsq'])
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--base', help='反馈导入条目时，原完整交换包目录（不能丢弃）')
    args = parser.parse_args()
    try:
        if args.direction == 'to-lsq':
            check(args.base is None, 'to-lsq不接受base')
            manifest = to_lsq(args.source, args.output)
        else:
            manifest = from_lsq(args.source, args.output, args.base)
        print(json.dumps({'status': 'complete-copy', 'output': str(Path(args.output).absolute()), 'files': len(manifest['files'])}, ensure_ascii=False))
    except (ExchangeError, OSError, ValueError, KeyError, TypeError, yaml.YAMLError, RecursionError) as error:
        print('交换未完成：' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
