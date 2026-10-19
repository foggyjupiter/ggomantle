# 꼬맨틀 오프라인

[꼬맨틀](https://github.com/NewsJelly/semantle-ko)(단어 유사도 추측 게임)을 **인터넷 없이** 휴대폰에서 할 수 있게 만든 PWA입니다.

- 원본은 단어를 입력할 때마다 서버가 유사도를 계산합니다. 이 버전은 줄인 단어 벡터(약 29MB)를 휴대폰에 저장해 두고, 유사도와 상위 1,000위를 **기기 안에서** 계산합니다.
- 처음 한 번만 인터넷으로 데이터를 받고, 그 뒤로는 비행기 모드에서도 됩니다.
- 매일 자정(한국 시간)에 원본 꼬맨틀과 **같은 번호, 같은 정답**의 문제가 열립니다.
- 지난 문제도 번호를 골라 풀 수 있습니다(통계에는 오늘 문제만 들어갑니다).

## 휴대폰에 설치하기

웹 서버(HTTPS)에 `web/` 폴더를 올린 뒤 휴대폰 브라우저로 접속합니다.

- **아이폰(Safari):** 공유 버튼 → "홈 화면에 추가"
- **안드로이드(Chrome):** 메뉴(⋮) → "앱 설치" 또는 "홈 화면에 추가"

설치한 뒤 한 번 열어서 "단어 데이터를 내려받는 중"이 끝나면 오프라인 준비가 된 것입니다.

### GitHub Pages로 배포

`main` 브랜치에 푸시하면 `.github/workflows/pages.yml`이 `web/` 폴더를 GitHub Pages로 배포합니다.
저장소 Settings → Pages → Source를 **GitHub Actions**로 설정해 두세요.

### 컴퓨터에서 테스트

```bash
cd web
python3 -m http.server 8000
# http://localhost:8000 접속 (서비스 워커는 localhost나 HTTPS에서만 동작)
```

## 원본과 다른 점

| | 원본 꼬맨틀 | 오프라인 버전 |
|---|---|---|
| 입력할 수 있는 단어 | fastText의 한글 단어 약 150만 개 | 약 9.7만 개 (사전 단어 전부 + 자주 쓰는 단어 5만 개) |
| 상위 1,000위 대상 | 비속어를 거른 사전 단어 | 같음 |
| 벡터 정밀도 | float | int8 (유사도 오차 평균 0.07, 최대 약 0.5) |

아주 드문 단어(오타, 활용형 등)는 "알 수 없는 단어"로 나올 수 있습니다. 순위 계산 대상 단어는 원본과 같고, 상위 1,000위 단어는 약 99%가 원본과 같습니다(1,000위 경계에 있는 단어 몇 개와 바로 옆 순위끼리 자리가 바뀔 수 있음).

## 데이터 다시 만들기

`web/data/`의 파일은 `tools/`의 스크립트로 만듭니다.

```bash
pip install -r tools/requirements.txt
mkdir -p data && cd data
wget https://dl.fbaipublicfiles.com/fasttext/vectors-crawl/cc.ko.300.vec.gz
wget https://github.com/spellcheck-ko/hunspell-dict-ko/releases/download/0.7.92/ko-aff-dic-0.7.92.zip
unzip ko-aff-dic-0.7.92.zip && cd ..

# 1) 사전 단어에서 비속어 거르기 (원본과 같은 smilegate-ai/kor_unsmile 모델, CPU로 수십 분)
python tools/filter_words.py --dic data/ko-aff-dic-0.7.92/ko.dic \
    --vec data/cc.ko.300.vec.gz --out data/ko_filtered.txt

# 2) 앱용 데이터 만들기 → web/data/
python tools/build_data.py --vec data/cc.ko.300.vec.gz \
    --dic data/ko-aff-dic-0.7.92/ko.dic --filtered data/ko_filtered.txt
```

데이터가 바뀌면 `meta.json`의 버전이 바뀌고, 앱은 다음에 온라인일 때 새 데이터를 받습니다.
화면 파일(`app.js` 등)을 고친 뒤에는 `web/sw.js`의 `SHELL_CACHE` 이름을 올려 주세요.

## 구조

```
web/
  index.html, style.css   화면
  app.js                  게임 진행, 기록 저장(localStorage)
  engine.js               Web Worker: 데이터 내려받기/저장, 유사도·순위 계산
  sw.js                   서비스 워커: 화면 파일 오프라인 저장
  data/                   words.txt, vectors.bin(int8), meta.json(정답 목록 포함)
tools/
  filter_words.py         비속어 필터
  build_data.py           벡터 줄이기 + 양자화
  secrets.txt             정답 단어 목록 (원본에서 가져옴)
```

## 라이선스와 출처

- 코드: GNU GPL v3. [꼬맨틀](https://github.com/NewsJelly/semantle-ko)(NewsJelly)을 바탕으로 했으며, 꼬맨틀은 [Semantlich](https://github.com/gaetjen/semantle-de)(Johannes Gätjen)와 [Semantle](https://gitlab.com/novalis_dt/semantle)(David Turner)를 포크한 것입니다. 정답 단어 목록과 아이콘도 꼬맨틀에서 가져왔습니다.
- 단어 벡터: [fastText cc.ko.300](https://fasttext.cc/docs/en/crawl-vectors.html) (Facebook, CC BY-SA 3.0)
- 사전: [hunspell-dict-ko](https://github.com/spellcheck-ko/hunspell-dict-ko) 0.7.92
