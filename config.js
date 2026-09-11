/* =========================================================================
   CONFIG
   앱의 모든 조정 가능한 값은 여기 한 곳에 모아둔다.
   나중에 점수 배점, 기준선, 종목 개수 등을 바꿀 때 이 파일만 수정하면 된다.
   ========================================================================= */
(function (root) {
  const CONFIG = {
    MAX_SYMBOLS: 50,
    DEFAULT_SYMBOLS: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    DEFAULT_CATEGORY: "coin", // 카테고리 미지정 종목(기존 데이터 포함)의 기본 분류 — 마이그레이션 기본값
    CATEGORIES: ["coin", "stock"], // 코인 선물 / 주식 선물
    // 감시 목록에서 자동으로 제거할 심볼 (실재하지 않는 심볼 등).
    // 학습 데이터(PatternLearn)는 별도 저장소이므로 전혀 삭제되지 않는다.
    PURGE_SYMBOLS: ["ANTROPICUSDT"],

    // 심볼 수가 늘어나도(최대 50개) 한 번에 전부 동시 요청하지 않고 소규모로 나눠 처리해서
    // 순간 요청 폭주를 줄인다. 총 요청 수·감시 주기는 그대로 유지된다(폴링 횟수를 늘리지 않음).
    SYMBOL_UPDATE_CONCURRENCY: 6,

    /* ---------------------------------------------------------------------
       멀티 타임프레임 전략
       15m = 큰 추세, 5m = 방향 확인, 1m = 실제 진입 타이밍
       세 시간봉이 "전부 다 일치"해야만 신호를 내는 방식(AND) 대신,
       조건별로 점수를 더하는 방식을 사용한다 (아래 SCORE 참고).
       --------------------------------------------------------------------- */
    TF_TREND: "15m",   // 큰 추세 확인
    TF_DIRECTION: "5m", // 방향 확인
    TF_ENTRY: "1m",     // 실제 진입 타이밍 (Heikin Ashi 전환 / MACD 크로스 기준)

    KLINE_LIMIT: 150,          // 지표 계산용 캔들 개수 (타임프레임별로 동일하게 적용)
    // 심볼당 3개 타임프레임(1m/5m/15m)을 매번 조회하므로, 기존(단일 타임프레임)보다
    // 요청 수가 3배가 된다. 그만큼 주기를 살짝 늘려 API 사용량을 아낀다.
    POLL_INTERVAL_MS: 20000,   // 갱신 주기 (20초)

    MACD_FAST: 12,
    MACD_SLOW: 26,
    MACD_SIGNAL: 9,

    RSI_PERIOD: 14,

    /* ---------------------------------------------------------------------
       조건별 점수제 (총 100점 기준)
       - trend15: 15분봉 Heikin Ashi 추세가 방향과 일치
       - trend5 : 5분봉 Heikin Ashi 추세가 방향과 일치
       - ha1Flip: 1분봉 Heikin Ashi가 이번 캔들에서 해당 방향으로 "전환"됨
       - macdCross: 1분봉 MACD가 해당 방향으로 골든/데드 크로스
       --------------------------------------------------------------------- */
    SCORE_WEIGHTS: {
      trend15: 30,
      trend5: 25,
      ha1Flip: 25,
      macdCross: 20,
    },

    // 총점 기준 신호 등급
    SCORE_BAND_STRONG: 80,  // 80 이상 = 강한 신호
    SCORE_BAND_WATCH: 65,   // 65~79   = 신호 관심
    SCORE_BAND_NEUTRAL: 50, // 50~64   = 관망 (50 미만 = 신호 없음)

    // 알림/토스트를 새로 띄우는 최소 등급 ("관심" 이상일 때만 기록/알림)
    NOTIFY_MIN_BAND: "watch",

    BINANCE_FAPI_KLINES: "https://fapi.binance.com/fapi/v1/klines",

    SIGNAL_LOG_MAX: 300, // 향후 분석/학습용 기록 최대 보관 개수 (localStorage 용량 보호)
    TRADE_LOG_MAX: 500,  // 내 매매 기록 최대 보관 개수
    DEFAULT_TRADE_NOTIONAL: 100, // 거래 기록 시 기본 포지션 크기(USDT) — 손익금액 계산용

    // ---- 자가학습(패턴 신뢰도) 필터 ----
    // 감시 중인 모든 종목의 자동 신호를 대상으로 함 (Lock-in 기록과는 별개, PatternLearn 참고)
    LEARN_HORIZON_MS: 15 * 60 * 1000, // 신호 발생 후 이 시간이 지나면 성공/실패 판정
    LEARN_MIN_SAMPLES: 10,            // 이 개수 미만이면 필터링하지 않고 그대로 통과 (소수 실패로 차단 금지)
    LEARN_CONFIDENCE_THRESHOLD: 0.35, // 신뢰도가 이 값 미만이면 알림만 차단(로그는 계속 남김)
    LEARN_PRIOR_WEIGHT: 10,           // 신뢰도 계산 시 0.5(중립) 쪽으로 당기는 가중치 — 표본이 적을수록 영향력을 줄이고, 쌓일수록 실제 승률에 수렴시킨다
    LEARN_TIER_SUFFICIENT: 30,        // 이 개수 이상이면 "충분한 데이터"로 표시
    PATTERN_LOG_MAX: 500,             // 패턴별 대기(pending) 목록 최대 보관 개수

    MIN_RECORD_DURATION_MS: 10 * 1000, // 기록 시작 후 이 시간 미만에 UNLOCK하면 기록을 저장하지 않음

    STORAGE_KEYS: {
      SYMBOLS: "sig_symbols_v1",
      LANG: "sig_lang_v1",
      NOTIFY: "sig_notify_v1",
      SIGNAL_LOG: "sig_signal_log_v1",
      LOCK: "sig_lock_v1",
      RECORDING: "sig_recording_v1",
      LOCK_RECORDS: "sig_lock_records_v1",
      TRADES: "sig_trades_v1",
      PATTERN_LEARN: "sig_pattern_learn_v1",
      LEARN_ENABLED: "sig_learn_enabled_v1",
      BG_MONITOR: "sig_bg_monitor_v1",
      SYMBOL_CATEGORY: "sig_symbol_category_v1",
    },
  };

  root.CONFIG = CONFIG;
})(typeof window !== "undefined" ? window : globalThis);
