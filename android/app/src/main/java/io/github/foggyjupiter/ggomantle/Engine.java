/*
    꼬맨틀 오프라인 — 유사도 계산 (앱 전용).
    web/engine.js와 같은 일을 하지만, 단어 약 150만 개 데이터를 메모리에 올리지 않고
    APK 안의 파일을 매핑(mmap)한 채로 쓴다. 안드로이드 API에 의존하지 않는다.
    Licensed under the GNU GPL v3.
*/
package io.github.foggyjupiter.ggomantle;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;

final class Engine {
    static final int NEAREST_COUNT = 1000;

    private final ByteBuffer words;    // 정렬된 단어 (UTF-8, '\n' 구분)
    private final ByteBuffer vectors;  // int8, count x dim
    private final ByteBuffer norms;    // float32
    private final int[] offsets;       // 단어 i는 words[offsets[i], offsets[i+1] - 1)
    private final int[] rankable;
    private final int[] secrets;
    private final int dim;
    private final int count;
    private final String version;

    private static final class Nearest {
        final int[] top;
        final double[] sims;
        final Map<Integer, Integer> ranks = new HashMap<>();

        Nearest(int[] top, double[] sims) {
            this.top = top;
            this.sims = sims;
            for (int r = 0; r < top.length; r++) ranks.put(top[r], r + 1);
        }
    }

    private final Map<Integer, Nearest> nearestCache = new LinkedHashMap<Integer, Nearest>() {
        @Override
        protected boolean removeEldestEntry(Map.Entry<Integer, Nearest> eldest) {
            return size() > 4;
        }
    };

    Engine(Properties meta, ByteBuffer words, ByteBuffer vectors, ByteBuffer norms,
           ByteBuffer rankable, ByteBuffer secrets) {
        this.version = meta.getProperty("version");
        this.dim = Integer.parseInt(meta.getProperty("dim"));
        this.count = Integer.parseInt(meta.getProperty("count"));
        this.words = words;
        this.vectors = vectors;
        this.norms = norms.order(ByteOrder.LITTLE_ENDIAN);
        this.rankable = readInts(rankable);
        this.secrets = readInts(secrets);
        if (vectors.capacity() != (long) count * dim || norms.capacity() != count * 4) {
            throw new IllegalStateException("corrupt-data");
        }

        offsets = new int[count + 1];
        int n = 0;
        offsets[n++] = 0;
        for (int i = 0, len = words.capacity(); i < len; i++) {
            if (words.get(i) == '\n') offsets[n++] = i + 1;
        }
        if (n != count) throw new IllegalStateException("corrupt-data");
        offsets[count] = words.capacity() + 1;
    }

    private static int[] readInts(ByteBuffer buf) {
        int[] out = new int[buf.capacity() / 4];
        buf.order(ByteOrder.LITTLE_ENDIAN).asIntBuffer().get(out);
        return out;
    }

    // ---- 단어 찾기 (UTF-8 바이트 순 이진 탐색) ----
    private int compare(byte[] key, int i) {
        int start = offsets[i], len = offsets[i + 1] - 1 - start;
        for (int k = 0, m = Math.min(key.length, len); k < m; k++) {
            int a = key[k] & 0xff, b = words.get(start + k) & 0xff;
            if (a != b) return a - b;
        }
        return key.length - len;
    }

    private int find(String word) {
        byte[] key = word.getBytes(StandardCharsets.UTF_8);
        int lo = 0, hi = count - 1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            int c = compare(key, mid);
            if (c == 0) return mid;
            if (c < 0) hi = mid - 1;
            else lo = mid + 1;
        }
        return -1;
    }

    private String wordAt(int i) {
        byte[] b = new byte[offsets[i + 1] - 1 - offsets[i]];
        ByteBuffer dup = words.duplicate();
        dup.position(offsets[i]);
        dup.get(b);
        return new String(b, StandardCharsets.UTF_8);
    }

    // ---- 유사도 ----
    private byte[] vector(int i, byte[] out) {
        ByteBuffer dup = vectors.duplicate();
        dup.position(i * dim);
        dup.get(out);
        return out;
    }

    private double similarity(byte[] a, int ai, int b, byte[] tmp) {
        vector(b, tmp);
        int s = 0;
        for (int k = 0; k < dim; k++) s += a[k] * tmp[k];
        return s / ((double) norms.getFloat(ai * 4) * norms.getFloat(b * 4));
    }

    private int secretIndex(int puzzle) {
        return secrets[((puzzle % secrets.length) + secrets.length) % secrets.length];
    }

    // 원본 process_similar.py와 같이: 순위 대상 단어 중 정답과 가장 가까운 1000개 (정답 자신 제외)
    private Nearest nearest(int puzzle) {
        Nearest cached = nearestCache.get(puzzle);
        if (cached != null) return cached;
        int secret = secretIndex(puzzle);
        byte[] sv = vector(secret, new byte[dim]);
        byte[] tmp = new byte[dim];
        int n = rankable.length;
        double[] sims = new double[n];
        Integer[] order = new Integer[n];
        for (int r = 0; r < n; r++) {
            order[r] = r;
            sims[r] = rankable[r] == secret ? Double.NEGATIVE_INFINITY : similarity(sv, secret, rankable[r], tmp);
        }
        Arrays.sort(order, (x, y) -> Double.compare(sims[y], sims[x]));
        int k = Math.min(NEAREST_COUNT, n);
        int[] top = new int[k];
        double[] topSims = new double[k];
        for (int r = 0; r < k; r++) {
            top[r] = rankable[order[r]];
            topSims[r] = sims[order[r]];
        }
        Nearest result = new Nearest(top, topSims);
        nearestCache.put(puzzle, result);
        return result;
    }

    // ---- 화면(app.js)에 돌려주는 JSON ----
    private static String quote(String s) {
        return '"' + s.replace("\\", "\\\\").replace("\"", "\\\"") + '"';
    }

    synchronized String init() {
        return "{\"puzzleCount\":" + secrets.length + ",\"version\":" + quote(version) + ",\"count\":" + count + "}";
    }

    synchronized String story(int puzzle) {
        Nearest near = nearest(puzzle);
        return "{\"top\":" + near.sims[0] + ",\"top10\":" + near.sims[9]
                + ",\"rest\":" + near.sims[near.sims.length - 1] + "}";
    }

    synchronized String guess(int puzzle, String word) {
        int i = find(word);
        if (i < 0) return "{\"error\":\"unknown\",\"guess\":" + quote(word) + "}";
        int secret = secretIndex(puzzle);
        if (i == secret) return "{\"guess\":" + quote(word) + ",\"sim\":1,\"rank\":\"정답!\"}";
        Integer rank = nearest(puzzle).ranks.get(i);
        double sim = similarity(vector(secret, new byte[dim]), secret, i, new byte[dim]);
        return "{\"guess\":" + quote(word) + ",\"sim\":" + sim + ",\"rank\":"
                + (rank != null ? rank.toString() : "\"1000위 이상\"") + "}";
    }

    synchronized String nearestJson(int puzzle) {
        Nearest near = nearest(puzzle);
        StringBuilder sb = new StringBuilder("{\"secret\":").append(quote(wordAt(secretIndex(puzzle)))).append(",\"list\":[");
        for (int r = 0; r < near.top.length; r++) {
            if (r > 0) sb.append(',');
            sb.append("{\"word\":").append(quote(wordAt(near.top[r])))
                    .append(",\"rank\":").append(r + 1)
                    .append(",\"sim\":").append(near.sims[r]).append('}');
        }
        return sb.append("]}").toString();
    }

    synchronized String secret(int puzzle) {
        return quote(wordAt(secretIndex(puzzle)));
    }
}
