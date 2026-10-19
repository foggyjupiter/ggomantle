"""안드로이드 앱용 전체 데이터(한글 단어 약 150만 개, 원본 꼬맨틀과 같은 어휘)를 만든다.

앱은 이 파일들을 메모리에 올리지 않고 APK 안에서 바로 매핑(mmap)해서 쓴다.
단어는 UTF-8 바이트 순으로 정렬되어 있어 이진 탐색으로 찾는다.

출력 (기본: android/app/bigdata/words/):
    words.bin     정렬된 단어, '\\n'으로 구분 (UTF-8)
    vectors.bin   int8, count x dim, words.bin과 같은 순서
    norms.bin     float32 little-endian, 각 벡터의 길이
    rankable.bin  int32 little-endian, 순위(상위 1000위) 대상 단어의 인덱스
    secrets.bin   int32 little-endian, 정답 단어의 인덱스 (secrets.txt 순서)
    meta.txt      key=value (version, dim, count)

사용법:
    python tools/build_app_data.py --vec data/cc.ko.300.vec.gz --filtered data/ko_filtered.txt
"""
import argparse
import gzip
import hashlib
import os
import unicodedata

import numpy as np
from tqdm import tqdm

from build_data import is_hangul, load_dic

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--vec', required=True, help='cc.ko.300.vec.gz')
    parser.add_argument('--filtered', required=True, help='filter_words.py 결과 (순위 대상 단어)')
    parser.add_argument('--secrets', default=os.path.join(HERE, 'secrets.txt'))
    parser.add_argument('--out', default=os.path.join(HERE, '..', 'android', 'app', 'bigdata', 'words'))
    args = parser.parse_args()

    rankable_set = load_dic(args.filtered)
    with open(args.secrets, 'r', encoding='utf-8') as f:
        secrets = [unicodedata.normalize('NFC', l.strip()) for l in f if l.strip()]

    # 원본 process_vecs.py와 같이: 한글로만 된 단어, 처음 나온 것만. 읽으면서 바로 int8로 줄인다.
    words, seen = [], set()
    with gzip.open(args.vec, 'rt', encoding='utf-8', errors='ignore') as f:
        total, dim = map(int, f.readline().split())
        mat = np.empty((total, dim), dtype=np.int8)
        for line in tqdm(f, total=total, desc='vectors', mininterval=1):
            parts = line.rstrip().split(' ')
            word = unicodedata.normalize('NFC', parts[0])
            if not is_hangul(word) or word in seen:
                continue
            seen.add(word)
            vec = np.asarray(parts[1:], dtype=np.float32)
            mat[len(words)] = np.clip(np.rint(vec * (127.0 / np.abs(vec).max())), -127, 127)
            words.append(word)
    mat = mat[:len(words)]

    order = sorted(range(len(words)), key=lambda i: words[i].encode('utf-8'))
    words = [words[i] for i in order]
    mat = mat[order]
    index = {w: i for i, w in enumerate(words)}
    missing = [s for s in secrets if s not in index]
    if missing:
        raise SystemExit(f'secrets without vectors: {missing[:10]}')
    rankable = np.array([i for i, w in enumerate(words) if w in rankable_set], dtype='<i4')
    norms = np.linalg.norm(mat.astype(np.float32), axis=1).astype('<f4')

    os.makedirs(args.out, exist_ok=True)
    words_bytes = '\n'.join(words).encode('utf-8')
    with open(os.path.join(args.out, 'words.bin'), 'wb') as f:
        f.write(words_bytes)
    mat.tofile(os.path.join(args.out, 'vectors.bin'))
    norms.tofile(os.path.join(args.out, 'norms.bin'))
    rankable.tofile(os.path.join(args.out, 'rankable.bin'))
    np.array([index[s] for s in secrets], dtype='<i4').tofile(os.path.join(args.out, 'secrets.bin'))
    version = hashlib.sha1(words_bytes + mat.tobytes()).hexdigest()[:12]
    with open(os.path.join(args.out, 'meta.txt'), 'w') as f:
        f.write(f'version={version}\ndim={dim}\ncount={len(words)}\n')
    print(f'words {len(words)}, rankable {len(rankable)}, vectors {mat.nbytes / 1e6:.0f}MB, version {version}')


if __name__ == '__main__':
    main()
