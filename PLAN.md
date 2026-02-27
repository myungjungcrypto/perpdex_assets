# Crypto Balance Monitor - 최종 계획서

## 목표
7개 Perp DEX의 계좌 잔액을 **5분마다** 조회하여 Google Sheets에 기록하고, **리퀴데이션 위험** 시 Telegram 알람을 발송하는 상시 모니터링 시스템.

대상: Variational, Lighter, 01.xyz, Nado, Paradex, Pacifica, Extended

---

## 1. 아키텍처

```
┌──────────────────────────────────────────────────────────────┐
│  AWS EC2 (3.39.24.55) — PM2 + cron (*/5 * * * *)            │
│                                                               │
│  ┌───────────┐   ┌──────────────┐   ┌──────────────────────┐│
│  │  Fetcher   │──▶│ Risk Analyzer│──▶│  Google Sheets API   ││
│  │  (7 DEX    │   │ (마진 여유율  │   │  (기존 시트에 탭 추가) ││
│  │  병렬 호출) │   │  계산)       │   └──────────────────────┘│
│  └───────────┘   └──────────────┘                            │
│                         │ 위험 감지 시                         │
│                         ▼                                     │
│                  ┌──────────────────────┐                     │
│                  │  Telegram Bot API    │                     │
│                  │  (기존 봇 + chat ID)  │                     │
│                  └──────────────────────┘                     │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. 배포: 기존 EC2 서버 (추가 비용 $0)

이미 `ec2-user@3.39.24.55`에서 `perpdex_arbitrage_alarm`이 돌고 있으므로,
같은 서버에 이 모니터도 함께 배포.

```bash
# PM2로 5분마다 실행 (상시 구동)
pm2 start dist/index.js --name "balance-monitor" --cron-restart "*/5 * * * *" --no-autorestart
pm2 startup    # 서버 재부팅 시 자동 복구
pm2 save

# 로그 확인
pm2 logs balance-monitor
```

**왜 EC2인가:**
- 이미 서버가 있어 추가 비용 $0
- Lambda 대비 setup 복잡도 낮음 (기존 환경 재활용)
- `perpdex_arbitrage_alarm`과 함께 관리 가능
- PM2가 프로세스 크래시 시 자동 재시작

---

## 3. 거래소별 필요 API 정보

### 권한 원칙: 읽기 전용만 사용 (입출금/거래 권한 절대 불필요)

### 3.1 Paradex (StarkNet 앱체인)

| 항목 | 내용 |
|------|------|
| **API 문서** | https://docs.paradex.trade/api/general-information |
| **체인** | StarkNet appchain → Ethereum 정산 |
| **인증** | Read-Only JWT 토큰 (GET 요청만 허용) |
| **발급 방법** | POST /auth로 생성 |
| **안전성** | ✅ **완벽** — JWT read-only는 거래/출금 불가 |

**데이터 엔드포인트:**
- `GET /v1/account` → account_value, free_collateral, initial_margin, maintenance_margin, **margin_cushion**
- `GET /v1/account/margin?market=BTC-USD-PERP` → 마켓별 마진 상세

**리퀴데이션 판단:** `margin_cushion` (계좌가치 - 유지증거금). 0에 가까울수록 위험.

---

### 3.2 Lighter (Ethereum zk-rollup)

| 항목 | 내용 |
|------|------|
| **API 문서** | https://apidocs.lighter.xyz |
| **체인** | Ethereum L1 (자체 zk-rollup) |
| **인증** | Read-Only 토큰 (`ro:{account}:{scope}:{expiry}:{hex}`, 만료 1일~10년) |
| **발급 방법** | createToken 엔드포인트 |
| **안전성** | ✅ **완벽** — `ro:` 토큰은 조회만 가능 |

**데이터:**
- WebSocket `account_all` 채널 → balance, positions, unrealized_pnl, **liquidation_price**
- REST `account` 엔드포인트

**리퀴데이션 판단:** 포지션에 `liquidation_price` 직접 제공 → 현재가와 비교.

---

### 3.3 Extended (StarkNet)

| 항목 | 내용 |
|------|------|
| **API 문서** | https://api.docs.extended.exchange |
| **체인** | StarkNet → Ethereum 정산 |
| **인증** | X-Api-Key 헤더 (GET만 가능). 거래/출금은 Stark 서명 추가 필요 |
| **발급 방법** | Extended API Management 페이지에서 발급 |
| **안전성** | ✅ **완벽** — API Key만으로는 조회만 가능 |

**데이터:** Private API 엔드포인트로 포지션/마진 조회. `User-Agent` 헤더 필수.

**리퀴데이션 판단:** 마진 데이터로 계산 (cross/isolated margin 모드 지원)

---

### 3.4 Pacifica (Solana)

| 항목 | 내용 |
|------|------|
| **API 문서** | https://docs.pacifica.fi/api-documentation/api |
| **체인** | Solana |
| **인증** | 지갑 주소만으로 조회 가능 (키 불필요) |
| **안전성** | ✅ **완벽** — 주소만 필요, 키 노출 없음 |

**데이터 엔드포인트:**
- `GET /api/v1/account?account=<address>` → balance, account_equity, total_margin_used, **cross_mmr**
- `GET /api/v1/positions?account=<address>` → 포지션 상세

**리퀴데이션 판단:** `cross_mmr` (유지증거금 비율) — 1에 가까울수록 위험.

---

### 3.5 Nado (Ink/Kraken L2)

| 항목 | 내용 |
|------|------|
| **API 문서** | https://docs.nado.xyz/developer-resources/api |
| **체인** | Ink (Kraken의 Ethereum L2, OP Stack) |
| **인증** | EIP-712 지갑 서명 (API Key 개념 없음) |
| **안전성** | ⚠️ **주의** — 프라이빗 키 필요. **Linked Signer** 기능 사용 권장 |

**필요 정보:**
- 지갑 주소 + **Linked Signer 키** (메인 키 대신 별도 서명 전용 키)

**데이터:**
- REST: `https://gateway.prod.nado.xyz/v1`
- WebSocket: `wss://gateway.prod.nado.xyz/v1/ws` (position_change, liquidation 스트림)

**리퀴데이션 판단:** 포지션 변경 시 마진 데이터, liquidation 스트림 구독.

---

### 3.6 01 Exchange (N1 Chain)

| 항목 | 내용 |
|------|------|
| **API 문서** | https://api.01.xyz / https://docs.01.xyz |
| **체인** | N1 (자체 L1, Solana/Arbitrum에서 입금) |
| **인증** | Solana keypair 서명 (읽기 전용 키 개념 없음) |
| **SDK** | `@n1xyz/nord-ts` (TS) 또는 `zo-sdk-py` (Python) |
| **안전성** | ⚠️ **주의** — 조회 전용 소액 지갑 사용 권장 |

**데이터:**
- Account → collateral, freeCollateral, marginFraction, maintenanceMarginRequirement, **liquidating** (boolean)
- Positions → entryPrice, unrealizedPnl, maintenanceMarginRequirement

**리퀴데이션 판단:** `liquidating` boolean + `marginFraction` vs `maintenanceMarginRequirement`

**특이:** REST API 서버를 로컬에서 실행해야 함 (비커스터디 구조)

---

### 3.7 Variational (Arbitrum)

| 항목 | 내용 |
|------|------|
| **API 문서** | https://docs.variational.io/technical-documentation/api |
| **체인** | Arbitrum One |
| **현재 상태** | ⚠️ **API 미공개** (개발 중) |
| **대안** | API 공개 전까지 Arbitrum 온체인 스마트 컨트랙트 직접 조회 시도 가능 |

---

## 4. 거래소별 안전성 요약

| 거래소 | 필요한 인증 정보 | 읽기전용 | 거래/출금 위험 |
|--------|----------------|----------|--------------|
| **Paradex** | Read-Only JWT | ✅ 완벽 | 불가능 |
| **Lighter** | Read-Only `ro:` 토큰 | ✅ 완벽 | 불가능 |
| **Extended** | API Key (GET only) | ✅ 완벽 | 불가능 (Stark 서명 없이) |
| **Pacifica** | 지갑 주소만 | ✅ 완벽 | 불가능 (키 불필요) |
| **Nado** | Linked Signer 키 | ⚠️ 주의 | Linked Signer로 범위 제한 |
| **01 Exchange** | Solana keypair | ⚠️ 주의 | 코드에서 조회만 수행 제한 |
| **Variational** | 미정 (API 미공개) | ❓ | 미정 |

---

## 5. 필요 환경 변수

```env
# ─── Google Sheets ───
GOOGLE_SERVICE_ACCOUNT_JSON=<서비스계정 JSON 전체>
GOOGLE_SPREADSHEET_ID=<기존 자산 정리 시트 ID>

# ─── Telegram (기존 봇 재사용) ───
TELEGRAM_BOT_TOKEN=<기존 봇 토큰>
TELEGRAM_CHAT_ID=<기존 채팅 ID>

# ─── Paradex ───
PARADEX_JWT_TOKEN=<Read-Only JWT>

# ─── Lighter ───
LIGHTER_RO_TOKEN=<ro:...형식 Read-Only 토큰>

# ─── Extended ───
EXTENDED_API_KEY=<API Key>

# ─── Pacifica ───
PACIFICA_WALLET_ADDRESS=<Solana 지갑 주소>

# ─── Nado ───
NADO_WALLET_ADDRESS=<0x...>
NADO_LINKED_SIGNER_KEY=<Linked Signer 프라이빗 키>

# ─── 01 Exchange ───
O1_SOLANA_KEYPAIR=<모니터링 전용 소액 지갑 keypair>

# ─── Variational (API 공개 후) ───
# VARIATIONAL_API_KEY=
# VARIATIONAL_API_SECRET=
```

`.env` 파일 권한: `chmod 600 .env` — Git에 절대 커밋 금지.

---

## 6. 리퀴데이션 위험 감지 로직

### 거래소별 핵심 지표

| 거래소 | 핵심 지표 | 위험 기준 |
|--------|----------|----------|
| Paradex | `margin_cushion` | < 총자산 20% |
| Lighter | `liquidation_price` | 현재가 대비 거리 < 10% |
| Extended | margin ratio | 유지증거금 대비 여유 < 20% |
| Pacifica | `cross_mmr` | > 0.8 (1이면 청산) |
| Nado | 마진 데이터 | 유지증거금 대비 여유 < 20% |
| 01 Exchange | `marginFraction` | < maintenanceMR × 1.5 |

### 알람 3단계

```
🟡 경고 (Warning)  : 여유 ≤ 20%  → Telegram 1회 알림
🟠 위험 (Danger)   : 여유 ≤ 10%  → 5분마다 반복 알림
🔴 긴급 (Critical) : 여유 ≤ 5%   → 매번 강조 알림 🚨
```

**중복 방지:** 같은 거래소 + 같은 위험 레벨이면 30분간 재발송 안 함. 레벨 상승 시 즉시 발송.

---

## 7. Google Sheets 기록 형식

기존 자산 정리 시트에 **2개 탭 추가:**

### 탭 1: "Balance Log" (5분마다 행 추가)

| Timestamp | Exchange | Total (USD) | Balance | Margin Used | Margin Free (%) | Positions | Unrealized PnL |
|-----------|----------|-------------|---------|-------------|-----------------|-----------|----------------|
| 2026-02-27 10:00 | Paradex | 5,230 | 3,200 | 2,030 | 38.8% | 3 | -120 |
| 2026-02-27 10:00 | Lighter | 2,100 | 1,500 | 600 | 71.4% | 1 | +45 |

### 탭 2: "Summary" (5분마다 1행 업데이트/추가)

| Timestamp | Total All (USD) | Paradex | Lighter | Extended | Pacifica | Nado | 01 | Variational | Alert |
|-----------|----------------|---------|---------|----------|----------|------|----|-------------|-------|
| 2026-02-27 10:00 | 15,430 | 5,230 | 2,100 | 3,200 | 1,800 | 1,600 | 1,500 | - | 없음 |

---

## 8. 프로젝트 구조

```
perpdex_assets/
├── src/
│   ├── index.ts                 # 엔트리포인트 (PM2에서 실행)
│   ├── config.ts                # 환경 변수 & 설정값
│   ├── exchanges/
│   │   ├── types.ts             # 공통 인터페이스 (ExchangeBalance, Position)
│   │   ├── paradex.ts
│   │   ├── lighter.ts
│   │   ├── extended.ts
│   │   ├── pacifica.ts
│   │   ├── nado.ts
│   │   ├── o1exchange.ts
│   │   └── variational.ts      # placeholder
│   ├── services/
│   │   ├── google-sheets.ts     # Sheets 기록
│   │   ├── telegram.ts          # 알람 발송
│   │   └── risk-analyzer.ts     # 리퀴데이션 위험 분석
│   └── utils/
│       └── logger.ts
├── package.json
├── tsconfig.json
├── .env.example
└── ecosystem.config.js          # PM2 설정 파일
```

---

## 9. 실행 흐름 (5분마다)

```
1. PM2 cron 트리거 → index.ts 실행
2. 7개 거래소 API 병렬 호출 (Promise.allSettled)
   └─ 개별 거래소 실패해도 나머지 정상 처리
   └─ 실패한 거래소는 시트에 "ERROR" 기록
3. 응답 파싱 → 공통 ExchangeBalance 포맷으로 변환
4. Google Sheets 기록 (Balance Log + Summary 탭)
5. 리퀴데이션 위험 분석
   └─ 각 거래소 마진 여유율 계산 + 임계값 비교
6. 위험 감지 시 → Telegram 알람 발송
7. 완료 (예상 소요: 2~5초)
```

---

## 10. 구현 순서

### Phase 1: 기본 인프라
- 프로젝트 초기화 (TypeScript + 패키지)
- 공통 인터페이스 정의
- Google Sheets 연동
- Telegram 알람 발송

### Phase 2: 읽기 전용 거래소 연동 (안전한 것부터)
- Pacifica (주소만 필요 — 가장 간단)
- Paradex (Read-Only JWT)
- Extended (API Key)
- Lighter (Read-Only 토큰)

### Phase 3: 서명 필요 거래소 연동
- Nado (Linked Signer + EIP-712)
- 01 Exchange (Solana keypair)
- Variational (API 공개 대기 / 온체인 조회)

### Phase 4: 리스크 엔진 & 배포
- 리퀴데이션 위험 분석 로직
- 알람 중복 방지 로직 (레벨별 쿨다운)
- PM2 배포 + ecosystem.config.js 설정
- EC2에서 통합 테스트

---

## 11. 기술 스택

| 구분 | 기술 |
|------|------|
| **Runtime** | Node.js 20 + TypeScript |
| **HTTP** | axios |
| **Google Sheets** | googleapis (서비스 계정) |
| **Telegram** | HTTP POST 직접 호출 |
| **EVM 서명** | ethers.js (Nado EIP-712) |
| **Solana** | @solana/web3.js (01, Pacifica) |
| **StarkNet** | starknet.js (Paradex, Extended — 필요 시) |
| **프로세스 관리** | PM2 |
| **빌드** | esbuild or tsc |

---

## 12. 보안

1. **읽기 전용 원칙**
   - Paradex, Lighter, Extended, Pacifica: 읽기 전용 키/주소만 사용 ✅
   - Nado: Linked Signer 키 사용 (메인 지갑 키 절대 사용 금지) ⚠️
   - 01: 모니터링 전용 소액 지갑 ⚠️

2. **시크릿 관리**
   - `.env` 파일 `chmod 600` + `.gitignore`에 등록
   - EC2 내부에서만 접근 가능

3. **코드 안전장치**
   - 거래/출금 관련 함수를 코드에서 아예 import하지 않음
   - 모든 API 호출은 GET 요청만 수행

---

## 13. 비용

| 항목 | 월 비용 |
|------|--------|
| EC2 (기존 서버) | $0 (이미 운영 중) |
| Google Sheets API | $0 (무료 할당량) |
| Telegram Bot API | $0 (무료) |
| 거래소 API 호출 | $0 (무료) |
| **합계** | **$0/월** |

---

## 14. 사전 준비 체크리스트 (사용자 액션)

구현 시작 전 준비해야 할 것들:

- [ ] **Google Sheets:** 서비스 계정 JSON 키 (Google Cloud Console에서 발급)
- [ ] **Google Sheets:** 기존 자산 시트 ID (URL에서 확인)
- [ ] **Telegram:** 기존 봇 토큰 + Chat ID 확인
- [ ] **Paradex:** Read-Only JWT 토큰 발급
- [ ] **Lighter:** Read-Only `ro:` 토큰 생성
- [ ] **Extended:** API Key 발급 (API Management 페이지)
- [ ] **Pacifica:** 사용 중인 Solana 지갑 주소 확인
- [ ] **Nado:** Linked Signer 키 설정 (또는 모니터링 전용 지갑)
- [ ] **01 Exchange:** 모니터링 전용 소액 Solana 지갑 keypair
- [ ] **Variational:** API 공개 대기 (또는 온체인 컨트랙트 주소 확인)
