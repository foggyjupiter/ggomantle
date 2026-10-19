"""fastText 한국어 벡터에서 오프라인 앱용 데이터(web/data)를 만든다.

어휘 = 사전 단어 중 벡터가 있는 단어 전부 + 빈도 상위 N개의 한글 단어 + 정답 단어.
벡터는 단어마다 최댓값이 127이 되도록 int8로 양자화한다(코사인 유사도는 크기와 무관).

출력:
    web/data/words.txt   한 줄에 한 단어. 앞쪽 rankable개가 순위(상위 1000위) 대상 단어.
    web/data/vectors.bin int8, count x dim, words.txt와 같은 순서
    web/data/meta.json   dim, count, rankable, secrets(단어 인덱스), 버전

사용법:
    python tools/build_data.py --vec data/cc.ko.300.vec.gz \
        --dic data/ko-aff-dic-0.7.92/ko.dic --filtered data/ko_filtered.txt
"""
import argparse
import gzip
import hashlib
import json
import os
import re
import unicodedata

import numpy as np
from tqdm import tqdm

HERE = os.path.dirname(os.path.abspath(__file__))
HANGUL = re.compile(r'^[㄰-㆏가-힣]+$')


def is_hangul(text) -> bool:
    return bool(HANGUL.match(text))


def load_dic(path):
    """hunspell .dic 또는 한 줄에 한 단어인 파일에서 한글 단어 집합을 읽는다."""
    rtn = set()
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            word = unicodedata.normalize('NFC', line.strip().split('/')[0])
            if is_hangul(word):
                rtn.add(word)
    return rtn


def load_vectors(vec_path, keep):
    """keep(word, hangul_index) 가 참인 단어의 벡터를 파일 순서(빈도순)대로 읽는다."""
    words, vecs = [], []
    seen = set()
    with gzip.open(vec_path, 'rt', encoding='utf-8', errors='ignore') as f:
        total, dim = map(int, f.readline().split())
        for line in tqdm(f, total=total, desc='vectors', mininterval=1):
            parts = line.rstrip().split(' ')
            word = unicodedata.normalize('NFC', parts[0])
            if not is_hangul(word) or word in seen:
                continue
            index = len(seen)
            seen.add(word)
            if keep(word, index):
                words.append(word)
                vecs.append(np.asarray(parts[1:], dtype=np.float32))
    return words, np.stack(vecs), dim


def quantize(mat):
    scale = 127.0 / np.abs(mat).max(axis=1, keepdims=True)
    return np.clip(np.rint(mat * scale), -127, 127).astype(np.int8)


def top_k(mat, norms, idx, k):
    sims = mat @ mat[idx] / (norms * norms[idx])
    top = np.argpartition(sims, -k)[-k:]
    return top[np.argsort(sims[top])[::-1]], sims


def check_quantization(mat, qmat, rankable, secrets, samples=30):
    """양자화 전후 상위 1000위가 얼마나 같은지 몇 개의 정답 단어로 확인한다."""
    rng = np.random.default_rng(0)
    fm, qm = mat[:rankable], qmat[:rankable].astype(np.float32)
    fn, qn = np.linalg.norm(fm, axis=1), np.linalg.norm(qm, axis=1)
    overlaps, errors = [], []
    for s in rng.choice(secrets, size=samples, replace=False):
        f_top, f_sims = top_k(fm, fn, s, 1001)
        q_top, q_sims = top_k(qm, qn, s, 1001)
        overlaps.append(len(set(f_top) & set(q_top)) / 1001)
        errors.append(np.abs(f_sims - q_sims).max())
    print(f'quantization: top-1000 overlap mean {np.mean(overlaps):.4f} min {np.min(overlaps):.4f}, '
          f'max similarity error {np.max(errors) * 100:.3f} (x100 scale)')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--vec', required=True, help='cc.ko.300.vec.gz')
    parser.add_argument('--dic', required=True, help='hunspell ko.dic')
    parser.add_argument('--filtered', required=True, help='filter_words.py 결과 (순위 대상 단어)')
    parser.add_argument('--secrets', default=os.path.join(HERE, 'secrets.txt'))
    parser.add_argument('--common', type=int, default=50000, help='포함할 빈도 상위 한글 단어 수')
    parser.add_argument('--out', default=os.path.join(HERE, '..', 'web', 'data'))
    args = parser.parse_args()

    dic = load_dic(args.dic)
    rankable_set = load_dic(args.filtered)
    with open(args.secrets, 'r', encoding='utf-8') as f:
        secrets = [unicodedata.normalize('NFC', l.strip()) for l in f if l.strip()]
    secret_set = set(secrets)

    words, mat, dim = load_vectors(
        args.vec, lambda w, i: i < args.common or w in dic or w in secret_set)

    # 순위 대상 단어를 앞으로 (각 그룹 안에서는 빈도순 유지)
    order = sorted(range(len(words)), key=lambda i: words[i] not in rankable_set)
    words = [words[i] for i in order]
    mat = mat[order]
    rankable = sum(w in rankable_set for w in words)
    index = {w: i for i, w in enumerate(words)}
    missing = [s for s in secrets if s not in index]
    if missing:
        raise SystemExit(f'secrets without vectors: {missing[:10]}')
    not_rankable = [s for s in secrets if index[s] >= rankable]
    if not_rankable:
        print(f'warning: {len(not_rankable)} secrets are not rankable, e.g. {not_rankable[:5]}')

    qmat = quantize(mat)
    check_quantization(mat, qmat, rankable, [index[s] for s in secrets if index[s] < rankable])

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'words.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(words))
    qmat.tofile(os.path.join(args.out, 'vectors.bin'))
    meta = {
        'version': hashlib.sha1(qmat.tobytes() + '\n'.join(words).encode()).hexdigest()[:12],
        'dim': dim,
        'count': len(words),
        'rankable': rankable,
        'firstDay': '2022-04-01',
        'secrets': [index[s] for s in secrets],
    }
    with open(os.path.join(args.out, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, separators=(',', ':'))
    print(f'words {len(words)}, rankable {rankable}, vectors {qmat.nbytes / 1e6:.1f}MB, version {meta["version"]}')


if __name__ == '__main__':
    main()
