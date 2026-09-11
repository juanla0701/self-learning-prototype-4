/* =========================================================================
   PatternLearn — 경량 자가학습(패턴 신뢰도) 필터
   외부 AI API를 쓰지 않고, 순수 통계(승/패 카운트)만으로 "이 지표 조합에서
   실제로 신호가 잘 맞았는가"를 학습한다. Lock-in 거래 기록(TradeLog/
   lockRecords) 자체는 그대로 유지하면서, Unlock 결과를 이 학습 데이터에도
   추가로 연결한다(별도 저장소는 그대로 분리 유지, 값만 복사해서 반영).

   [종목별/카테고리별 독립 학습]
   패턴 키에 "카테고리:종목"을 포함시켜서(예: "coin:BTCUSDT:long:1101"),
   BTCUSDT의 학습 결과가 ETHUSDT나 주식 선물 종목에 섞이지 않는다.
   과거(이 구조 도입 이전)에 쌓인 데이터는 삭제하지 않고 schemaVersion
   마이그레이션으로 보존한다 — 아래 migrate() 참고.

   [학습 데이터 부족 방지]
   표본이 LEARN_MIN_SAMPLES 미만이면 기존처럼 신호 필터링을 하지 않고
   그대로 통과시킨다(getConfidence()가 null 반환). 표본이 쌓일수록
   신뢰도 계산에 베이지안 스무딩(LEARN_PRIOR_WEIGHT)을 적용해 초반에는
   0.5(중립)에 가깝게, 표본이 많아질수록 실제 승률에 점점 수렴시킨다 —
   즉 학습 데이터의 "영향력"이 점진적으로 커진다.

   흐름: 신호 발생(모든 감시 종목 대상) → 가격 기록(pending) → 일정 시간 후
   실제 가격으로 성공/실패 판정 → 종목별 패턴 승/패 누적(+상세 엔트리 기록) →
   신뢰도 계산 → "알림" 및 "신뢰도 배지" 표시에 반영한다.
   기존 LONG/SHORT 신호 판단(signals.js) 자체는 이 파일에서 전혀 건드리지 않는다 —
   신뢰도는 항상 "추가 정보"로만 계산되어 UI에 별도로 표시된다.

   ON/OFF(State.learnEnabled): OFF면 새 데이터 저장도, 기존 데이터의 신호 반영도 멈춘다.
   OFF여도 이미 저장된 데이터는 지우지 않는다 — 다시 ON하면 그대로 이어서 사용된다.

   [향후 확장을 위한 메모 — 이번에는 구현하지 않음]
   entries[]는 이미 종목/방향/조건/시각/가격/손익률/결과를 갖고 있어서,
   나중에 "시간대별 성과", "변동성 구간별 차이", "종목별 최적 조건 탐색" 등을
   추가할 때 새로운 필드만 얹으면 된다(예: volatilityBucket, hourOfDay 등).
   지금은 그런 필드를 추가하지 않는다(불필요한 복잡도 방지).

   ⚠️ 한계: 이 프로젝트는 GitHub Pages 정적 호스팅이라 서버가 없다.
   따라서 이 학습은 "브라우저 탭이 열려 있는 동안"만 진행되며, 앱을 완전히
   종료하거나 휴대폰을 꺼두면 그 시간 동안은 학습이 진행되지 않는다.
   24시간 서버 수집을 만들려면 별도의 상시 실행 서버/DB가 필요하며, 이는
   현재 코드(정적 파일)만으로는 구현할 수 없어 억지로 흉내내지 않았다.
   ========================================================================= */
(function (root) {
  const CONFIG = root.CONFIG;
  const KEY = CONFIG.STORAGE_KEYS.PATTERN_LEARN;
  const SCHEMA_VERSION = 2;

  // root.State는 이 파일보다 나중에 로드되므로, 여기서 미리 const로 캡처하지 않고
  // 호출 시점마다 root.State를 직접 참조한다 (스크립트 로드 순서와 무관하게 항상 최신 값 사용).
  function isEnabled() {
    return !root.State || root.State.learnEnabled !== false; // State가 아직 없으면(예: 유닛테스트) 기본 ON
  }

  function categoryOf(symbol) {
    if (root.State && typeof root.State.getCategory === "function") return root.State.getCategory(symbol);
    return CONFIG.DEFAULT_CATEGORY;
  }

  // 구버전(schemaVersion 2 이전, category/symbol이 키에 없던 시절) 데이터를 새 구조로 옮긴다.
  // 원본은 절대 지우지 않는다 — data.stats(구버전 전역 통계)는 그대로 남겨두고,
  // entries[]에 이미 기록되어 있던 종목/방향/조건 정보로 statsBySymbol을 다시 집계한다.
  function migrate(data) {
    if (data.schemaVersion >= SCHEMA_VERSION) return data;
    data.statsBySymbol = data.statsBySymbol || {};
    (data.entries || []).forEach((e) => {
      if (!e || !e.symbol || !e.direction || !e.conditions) return; // 정보 부족한 옛 항목은 재집계 대상에서 제외(원본은 그대로 보존됨)
      const cat = e.category || CONFIG.DEFAULT_CATEGORY; // 카테고리 개념이 없던 시절 데이터는 기본 카테고리로 마이그레이션
      const key = buildPatternKey(cat, e.symbol, e.direction, e.conditions);
      const s = data.statsBySymbol[key] || { wins: 0, losses: 0 };
      if (e.result === "WIN") s.wins++;
      else if (e.result === "LOSS") s.losses++;
      data.statsBySymbol[key] = s;
    });
    data.schemaVersion = SCHEMA_VERSION;
    return data; // data.stats(구버전 전역 통계)는 손대지 않고 그대로 보존
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      let data = raw ? JSON.parse(raw) : {};
      // 기존 localStorage 데이터(entries/statsBySymbol 없이 pending/stats만 있던 예전 형식)와 호환:
      // 없는 필드만 기본값으로 채워 넣고, 있던 데이터는 그대로 둔다.
      if (!Array.isArray(data.pending)) data.pending = [];
      if (!data.stats || typeof data.stats !== "object") data.stats = {};
      if (!Array.isArray(data.entries)) data.entries = [];
      if (!data.statsBySymbol || typeof data.statsBySymbol !== "object") data.statsBySymbol = {};
      if (!data.schemaVersion) data.schemaVersion = 1;
      const wasMigrated = data.schemaVersion < SCHEMA_VERSION;
      data = migrate(data);
      if (wasMigrated) save(data); // 마이그레이션 결과를 디스크에도 반영해서 다음부터는 다시 계산하지 않는다
      return data;
    } catch (e) {
      return { pending: [], stats: {}, entries: [], statsBySymbol: {}, schemaVersion: SCHEMA_VERSION };
    }
  }
  function save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      /* 저장 실패는 조용히 무시 (부가 기능) */
    }
  }

  // 조건 조합 + 방향 + 종목 + 카테고리를 하나의 패턴 키로 압축 (예: "coin:BTCUSDT:long:1101")
  // 종목이 다르면 키가 절대 겹치지 않으므로 종목별로 자연스럽게 독립적으로 학습된다.
  function buildPatternKey(category, symbol, direction, conditions) {
    const bits =
      (conditions.trend15 ? "1" : "0") +
      (conditions.trend5 ? "1" : "0") +
      (conditions.ha1Flip ? "1" : "0") +
      (conditions.macdCross ? "1" : "0");
    return `${category}:${symbol}:${direction}:${bits}`;
  }

  function addStat(data, patternKey, win) {
    const s = data.statsBySymbol[patternKey] || { wins: 0, losses: 0 };
    if (win) s.wins++;
    else s.losses++;
    data.statsBySymbol[patternKey] = s;
  }

  function pushEntry(data, entry) {
    data.entries.push(entry);
    while (data.entries.length > CONFIG.PATTERN_LOG_MAX) data.entries.shift();
  }

  // 새 신호가 발생했을 때 판정 대기열에 넣는다 (모든 감시 종목 공통, Lock-in과 무관)
  // 자가학습이 OFF면 새 데이터를 쌓지 않는다.
  function recordPending(result, direction) {
    if (!isEnabled()) return;
    const data = load();
    const dirData = direction === "long" ? result.long : result.short;
    const category = categoryOf(result.symbol);
    data.pending.push({
      symbol: result.symbol,
      category,
      direction,
      patternKey: buildPatternKey(category, result.symbol, direction, dirData.conditions),
      conditions: dirData.conditions, // 1분/5분/15분 조건 원본 보존 (패턴키로부터 재해석할 필요 없이 그대로 저장)
      entryPrice: result.price,
      entryTime: result.updatedAt,
    });
    while (data.pending.length > CONFIG.PATTERN_LOG_MAX) data.pending.shift();
    save(data);
  }

  // 매 폴링 주기마다 호출: 판정 시간이 지난 대기 항목을 승/패로 확정한다.
  // stateData: State.data (symbol -> Signals.evaluate 결과, 이미 fetch된 값 재사용 — 추가 API 호출 없음)
  // 자가학습이 OFF면 대기 중인 항목을 그대로 두고(삭제하지 않음) 판정도 하지 않는다 — 다시 ON하면 이어서 판정된다.
  function evaluatePending(stateData) {
    if (!isEnabled()) return;
    const data = load();
    const now = Date.now();
    const remaining = [];

    data.pending.forEach((p) => {
      if (now - p.entryTime < CONFIG.LEARN_HORIZON_MS) {
        remaining.push(p);
        return;
      }
      const cur = stateData[p.symbol];
      if (!cur || !Number.isFinite(cur.price)) {
        remaining.push(p); // 아직 가격을 못 받았으면 다음 주기에 다시 판정
        return;
      }
      const moveUp = cur.price > p.entryPrice;
      const win = p.direction === "long" ? moveUp : !moveUp;
      addStat(data, p.patternKey, win);
      const pnlPercent =
        p.direction === "long"
          ? ((cur.price - p.entryPrice) / p.entryPrice) * 100
          : ((p.entryPrice - cur.price) / p.entryPrice) * 100;
      pushEntry(data, {
        source: "signal", // 감시 종목 자동 신호 결과 (Lock-in과 구분)
        symbol: p.symbol,
        category: p.category,
        direction: p.direction,
        patternKey: p.patternKey,
        conditions: p.conditions || null,
        entryTime: p.entryTime,
        resultTime: now,
        entryPrice: p.entryPrice,
        resultPrice: cur.price,
        pnlPercent,
        result: win ? "WIN" : "LOSS",
      });
    });

    data.pending = remaining;
    save(data);
  }

  // Lock-in → Unlock으로 확정된 거래 결과를 자가학습 데이터에 연결한다.
  // 기존 거래 기록(State.lockRecords)은 건드리지 않고, 여기에만 복사해서 반영한다.
  // conditions가 없으면(스냅샷을 못 남긴 경우) 학습에 반영하지 않는다. 자가학습이 OFF면 저장하지 않는다.
  function recordLockResult({ symbol, direction, conditions, pnlPercent }) {
    if (!isEnabled()) return;
    if (!conditions || !direction || !Number.isFinite(pnlPercent)) return;
    const data = load();
    const category = categoryOf(symbol);
    const patternKey = buildPatternKey(category, symbol, direction, conditions);
    const win = pnlPercent > 0;
    addStat(data, patternKey, win);
    pushEntry(data, {
      source: "lockin", // Lock-in 거래 결과 (감시 종목 자동 신호와 구분)
      symbol,
      category,
      direction,
      patternKey,
      conditions,
      resultTime: Date.now(),
      pnlPercent,
      result: win ? "WIN" : "LOSS",
    });
    save(data);
  }

  // 표본이 부족하면(요구사항 5) null(=필터링하지 않음, 기존 전략 그대로 사용).
  // 표본이 쌓이면 베이지안 스무딩으로 계산한 신뢰도(0~1)를 반환한다.
  // (wins+PRIOR*0.5)/(total+PRIOR) 형태 — 표본이 적을수록 0.5(중립)에 가깝고,
  // 표본이 많아질수록 실제 승률(wins/total)에 점점 수렴한다 = "영향력의 점진적 증가".
  function getConfidence(patternKey) {
    if (!isEnabled()) return null;
    const s = load().statsBySymbol[patternKey];
    if (!s) return null;
    const total = s.wins + s.losses;
    if (total < CONFIG.LEARN_MIN_SAMPLES) return null;
    const PRIOR = CONFIG.LEARN_PRIOR_WEIGHT;
    return (s.wins + PRIOR * 0.5) / (total + PRIOR);
  }

  // 이 신호의 알림을 내보내도 되는지 (신호 자체/기록은 항상 유지되고, 이 값은 "알림 여부"만 결정)
  // 자가학습이 OFF면 항상 통과시킨다(기존 학습 데이터를 신호 판단에 반영하지 않음).
  function shouldAlert(result, direction) {
    if (!isEnabled()) return true;
    const dirData = direction === "long" ? result.long : result.short;
    const category = categoryOf(result.symbol);
    const key = buildPatternKey(category, result.symbol, direction, dirData.conditions);
    const confidence = getConfidence(key);
    if (confidence == null) return true; // 데이터 부족 → 기존처럼 그대로 통과
    return confidence >= CONFIG.LEARN_CONFIDENCE_THRESHOLD;
  }

  // UI 표시용: 이 패턴의 원시 통계(승/패/표본수/신뢰도)를 그대로 반환 (라벨링은 UI 쪽에서 결정)
  // isEnabled() 여부와 무관하게 "데이터가 있는지"는 그대로 보여줄 수 있게 한다 (OFF여도 저장된 값 열람은 가능).
  function getPatternInfo(patternKey) {
    const s = load().statsBySymbol[patternKey];
    const wins = s ? s.wins : 0;
    const losses = s ? s.losses : 0;
    const total = wins + losses;
    const confidence = total >= CONFIG.LEARN_MIN_SAMPLES ? wins / total : null;
    return { wins, losses, total, confidence };
  }

  // 특정 종목(카테고리 무관, symbol만으로) 하나의 학습 현황을 LONG/SHORT·모든 패턴 합산해서 보여준다.
  // 종목 목록의 "학습 데이터 N개 · 승률 X% · 상태" 표시에 사용 (요구사항 6).
  function getSymbolStats(symbol) {
    const data = load();
    const prefixes = CONFIG.CATEGORIES.map((c) => `${c}:${symbol}:`);
    let wins = 0,
      losses = 0;
    Object.keys(data.statsBySymbol).forEach((k) => {
      if (prefixes.some((p) => k.startsWith(p))) {
        wins += data.statsBySymbol[k].wins || 0;
        losses += data.statsBySymbol[k].losses || 0;
      }
    });
    const total = wins + losses;
    let tier = "insufficient";
    if (total >= CONFIG.LEARN_TIER_SUFFICIENT) tier = "sufficient";
    else if (total >= CONFIG.LEARN_MIN_SAMPLES) tier = "learning";
    // insufficient: LEARN_MIN_SAMPLES 미만(학습 부족, 기존 전략 그대로 사용)
    // learning: 쌓이는 중(아직 필터에는 못 미치지만 곧 반영 시작)
    // sufficient: LEARN_TIER_SUFFICIENT 이상(충분히 반영 중)
    return { total, wins, losses, winRate: total > 0 ? (wins / total) * 100 : null, tier };
  }

  function getStats() {
    return load().statsBySymbol;
  }

  // 전체(모든 종목/카테고리 합산) 요약 통계 (자가학습 상태 UI 전체 카드에 표시)
  function getTotals() {
    const data = load();
    let wins = 0,
      losses = 0;
    Object.keys(data.statsBySymbol).forEach((k) => {
      wins += data.statsBySymbol[k].wins || 0;
      losses += data.statsBySymbol[k].losses || 0;
    });
    const total = wins + losses;
    return {
      entries: data.entries.length,
      pending: data.pending.length,
      wins,
      losses,
      total,
      winRate: total > 0 ? (wins / total) * 100 : null,
    };
  }

  // 자가학습 데이터만 초기화한다 (거래 기록/Lock-in 기록/설정/감시 종목은 전혀 건드리지 않음 — 별도 localStorage 키라 자동으로 보존됨)
  function reset() {
    save({ pending: [], stats: {}, entries: [], statsBySymbol: {}, schemaVersion: SCHEMA_VERSION });
  }

  root.PatternLearn = {
    buildPatternKey,
    recordPending,
    evaluatePending,
    recordLockResult,
    getConfidence,
    shouldAlert,
    getStats,
    getPatternInfo,
    getSymbolStats,
    getTotals,
    isEnabled,
    reset,
  };
})(typeof window !== "undefined" ? window : globalThis);
