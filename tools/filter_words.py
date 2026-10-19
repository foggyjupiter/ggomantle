"""사전 단어에서 비속어/혐오 표현을 걸러낸다.

원본 꼬맨틀(NewsJelly/semantle-ko)의 filter_words.py와 같은 모델
(smilegate-ai/kor_unsmile)과 기준(clean 점수 > 0.5)을 쓴다.
걸러낸 단어 목록은 유사도 '순위'를 매길 때만 쓰인다.

사용법:
    python tools/filter_words.py --dic data/ko-aff-dic-0.7.92/ko.dic \
        --vec data/cc.ko.300.vec.gz --out data/ko_filtered.txt
"""
import argparse
import gzip
import unicodedata

from tqdm import tqdm
from transformers import AutoTokenizer, BertForSequenceClassification, TextClassificationPipeline

from build_data import is_hangul, load_dic

MODEL_NAME = 'smilegate-ai/kor_unsmile'
MIN_SCORE = 0.5


def vector_words(vec_path):
    """벡터 파일에 들어 있는 한글 단어 집합 (사전 단어 중 벡터가 없는 건 어차피 못 쓴다)."""
    words = set()
    with gzip.open(vec_path, 'rt', encoding='utf-8', errors='ignore') as f:
        f.readline()
        for line in tqdm(f, desc='scan vectors', mininterval=1):
            word = unicodedata.normalize('NFC', line[:line.index(' ')])
            if is_hangul(word):
                words.add(word)
    return words


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dic', required=True)
    parser.add_argument('--vec', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--batch-size', type=int, default=64)
    args = parser.parse_args()

    available = vector_words(args.vec)
    words = sorted(w for w in load_dic(args.dic) if w in available)
    print('# dictionary words with vectors:', len(words))

    model = BertForSequenceClassification.from_pretrained(MODEL_NAME)
    pipe = TextClassificationPipeline(
        model=model,
        tokenizer=AutoTokenizer.from_pretrained(MODEL_NAME),
        device=-1,
        top_k=None,
        function_to_apply='sigmoid',
    )
    label_order = [model.config.id2label[i] for i in range(len(model.config.id2label))]

    clean = []
    outputs = pipe(words, batch_size=args.batch_size)
    for word, labels in tqdm(zip(words, outputs), total=len(words), desc='filter'):
        # 원본과 같이: 모델 라벨 순서대로 보아 점수가 기준을 넘는 첫 라벨이 clean이어야 통과
        labels = sorted(labels, key=lambda l: label_order.index(l['label']))
        top = next((l for l in labels if l['score'] > MIN_SCORE), None)
        if top is not None and top['label'] == 'clean':
            clean.append(word)
        else:
            print(f'filtered: {word} - {top}')

    with open(args.out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(clean))
    print('# clean words:', len(clean))


if __name__ == '__main__':
    main()
