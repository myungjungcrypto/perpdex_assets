# Crypto Balance Monitor - 전체 계획서

## 목표
7개 Perp DEX(Variational, Lighter, 01.xyz, Nado, Paradex, Pacifica, Extended)의 계좌 잔액을 **5분마다** 조회하여 Google Sheets에 기록하고, **리퀴데이션 위험** 시 Telegram 알람을 발송하는 상시 모니터링 시스템.

---

## 1. 아키텍처 개요

```
┌─────────────────────────────────────────────────────┐
│           AWS Lambda + EventBridge (5분 주기)          │
│                                                       │
│  ┌─────────┐   ┌──────────┐   ┌──────────────────┐  │
│  │ Fetcher  │──▶│ Analyzer │──▶│ Google Sheets API │  │
│  │ (7 DEX)  │   │ (margin  │   └──────────────────┘  │
│  └─────────┘   │  check)  │   ┌──────────────────┐  │
│                 └──────────┘──▶│ Telegram Bot API  │  │
│                    (위험 시)    └──────────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## 2. 배포 환경: AWS Lambda + EventBridge (추천)

### 왜 Lambda인가?

| 기준 | Vercel (Pro) | EC2 (t4g.nano) | **Lambda + EventBridge** |
|------|-------------|----------------|--------------------------|
| **월 비용** | $20 | ~$3-4 | **$0 (프리티어)** |
| **5분 크론** | Pro만 가능 | O | O |
| **서버 관리** | 없음 | 직접 관리 | **없음** |
| **안정성** | 높음 | 중간 (단일 서버) | **매우 높음** |
| **재시도** | 없음 | 직접 구현 | **자동 (설정 가능)** |

- **비용: 월 $0** — 8,640회/월 호출 (5분×24시간×30일), 각 ~200ms. Lambda 무료 티어(100만 회/월, 400K GB-초/월) 내에서 여유롭게 처리
- **콜드 스타트 무시 가능** — 5분 간격이면 Lambda 컨테이너가 warm 상태 유지 (~15분 비활성 후 해제)
- **자동 재시도** — EventBridge에서 실패 시 자동 재시도 정책 설정 가능

### 대안: AWS EC2 (이미 서버가 있는 경우)
이미 AWS 서버가 있다면, 해당 서버에서 **PM2 + cron** 또는 **systemd timer**로 Node.js 스크립트를 5분마다 실행하는 것도 좋은 선택. 추가 비용 $0.

```bash
# PM2로 실행
pm2 start monitor.js --cron "*/5 * * * *"
pm2 startup  # 서버 재시작 시 자동 시작

# 또는 crontab
*/5 * * * * /usr/bin/node /home/ec2-user/monitor/index.js >> /var/log/monitor.log 2>&1
```

---

## 3. 각 거래소별 API 정보 및 필요 인증

### 권한 원칙: **읽기 전용만 사용 (입출금/거래 권한 불필요)**

### 3.1 Paradex (StarkNet 앱체인)
- **API 문서:** https://docs.paradex.trade/api/general-information
- **체인:** StarkNet appchain → Ethereum 정산
- **인증:** **Read-Only JWT 토큰** 지원 (GET 요청만 가능, 거래/출금 불가)
- **필요 정보:**
  - Paradex 계정의 Read-Only JWT 토큰 (POST /auth로 생성)
- **잔액/마진 엔드포인트:**
  - `GET /v1/account` → account_value, free_collateral, initial_margin, maintenance_margin, **margin_cushion**
  - `GET /v1/account/margin?market=BTC-USD-PERP` → 마켓별 마진 상세
- **리퀴데이션 판단:** `margin_cushion` (계좌 가치 - 유지증거금) 값으로 판단. 0에 가까울수록 위험
- **Rate Limit:** 1,500 req/min (IP)
- **읽기 전용 안전성: ✅ 완벽** — JWT read-only 토큰은 GET만 허용

### 3.2 Lighter (Ethereum zk-rollup)
- **API 문서:** https://apidocs.lighter.xyz
- **체인:** Ethereum L1 (자체 zk-rollup)
- **인증:** **Read-Only Auth 토큰** 지원 (형식: `ro:{account}:{scope}:{expiry}:{hex}`, 만료 1일~10년)
- **필요 정보:**
  - Lighter 계정의 Read-Only 토큰 (createToken 엔드포인트로 생성)
- **잔액/포지션 데이터 (WebSocket):**
  - `account_all` 채널 → balance, locked_balance, positions, unrealized_pnl, **liquidation_price**
  - `user_stats` 채널 → collateral, portfolio_value, leverage, margin_usage
- **REST:** `account` 엔드포인트
- **리퀴데이션 판단:** 포지션 객체에 `liquidation_price` 필드 직접 제공
- **읽기 전용 안전성: ✅ 완벽** — `ro:` 토큰은 조회만 가능

### 3.3 Extended (StarkNet)
- **API 문서:** https://api.docs.extended.exchange
- **체인:** StarkNet → Ethereum 정산
- **인증:** **X-Api-Key 헤더만으로 Read-Only 접근** (GET 엔드포인트만). 거래/출금에는 추가로 Stark 서명 필요
- **필요 정보:**
  - Extended의 API Management 페이지에서 발급한 API Key
- **잔액/마진 데이터:** Private API 엔드포인트로 포지션/마진 조회
- **리퀴데이션 판단:** 마진 관련 데이터로 계산 (cross/isolated margin 모드 지원)
- **참고:** `User-Agent` 헤더 필수
- **읽기 전용 안전성: ✅ 완벽** — API Key만으로는 GET 요청만 가능, Stark 서명 없이 거래/출금 불가

### 3.4 Pacifica (Solana)
- **API 문서:** https://docs.pacifica.fi/api-documentation/api
- **체인:** Solana
- **인증:** API Agent Key (스코프 제한 가능) 또는 계정 주소만으로 일부 조회 가능
- **필요 정보:**
  - Solana 지갑 주소 (계정 조회용)
  - API Agent Key (인증 필요 시, https://app.pacifica.fi/apikey에서 생성)
- **잔액/마진 엔드포인트:**
  - `GET /api/v1/account?account=<address>` → balance, account_equity, total_margin_used, **cross_mmr** (교차 유지증거금 비율)
  - `GET /api/v1/positions?account=<address>` → 포지션 상세
  - `GET /api/v1/account/equity/history` → 자산 추이
- **리퀴데이션 판단:** `cross_mmr` (Cross Maintenance Margin Ratio) — 1에 가까울수록 위험
- **읽기 전용 안전성: ✅ 좋음** — 주소 기반 조회는 권한 불필요. Agent Key도 스코프 제한 가능

### 3.5 Nado (Ink/Kraken L2)
- **API 문서:** https://docs.nado.xyz/developer-resources/api
- **체인:** Ink (Kraken의 Ethereum L2, OP Stack)
- **인증:** **API Key 없음** — EIP-712 지갑 서명 방식
- **필요 정보:**
  - 지갑 주소 + 지갑 서명 (EIP-712)
  - ⚠️ 지갑 프라이빗 키가 필요하나, 서명 범위를 인증에만 한정 가능
- **엔드포인트:**
  - Gateway WebSocket: `wss://gateway.prod.nado.xyz/v1/ws`
  - Gateway REST: `https://gateway.prod.nado.xyz/v1`
  - 스트림: `position_change`, `liquidation`, `fill`, `funding_payment`
  - Archive/Indexer: `https://archive.prod.nado.xyz/v1`
- **리퀴데이션 판단:** `liquidation` 실시간 스트림, 포지션 변경 시 마진 데이터 포함
- **읽기 전용 안전성: ⚠️ 주의** — 지갑 서명이 인증에만 사용되지만, 프라이빗 키 노출 자체가 위험. **Linked Signer** 기능으로 별도 서명 키 지정 권장

### 3.6 01 Exchange (N1 Chain)
- **API 문서:** https://api.01.xyz / https://docs.01.xyz
- **체인:** N1 (자체 L1, Solana/Arbitrum에서 입금)
- **인증:** **API Key 없음** — Solana 지갑 서명 (자체 REST API 서버를 로컬에서 실행)
- **필요 정보:**
  - Solana keypair (지갑 서명용)
  - SDK: `@n1xyz/nord-ts` (TypeScript) 또는 `zo-sdk-py` (Python)
- **잔액/마진 엔드포인트:**
  - Account → collateral, freeCollateral, marginFraction, maintenanceMarginRequirement, **liquidating** (boolean)
  - Positions → entryPrice, unrealizedPnl, maintenanceMarginRequirement
  - Wallet → coin별 free, total, usdValue
- **리퀴데이션 판단:** `liquidating` boolean 필드, `marginFraction` vs `maintenanceMarginRequirement` 비교
- **읽기 전용 안전성: ⚠️ 주의** — 읽기 전용 키 개념 없음. 지갑 키가 필요하나 조회만 수행하도록 코드 제한 가능. 소액 전용 지갑 사용 권장
- **특이사항:** API 서버를 로컬에서 실행해야 함 (비커스터디 구조)

### 3.7 Variational (Arbitrum)
- **API 문서:** https://docs.variational.io/technical-documentation/api
- **체인:** Arbitrum One
- **인증:** API 크레덴셜 + Python SDK
- **현재 상태:** ⚠️ **API가 아직 공개되지 않음** (개발 중). 대기 신청 가능
- **필요 정보:**
  - API 공개 후 크레덴셜 발급 필요
- **예정 엔드포인트:**
  - `GET /v1/portfolio/assets`, `/positions`, `/summary`
- **대안:** API 공개 전까지 Arbitrum 온체인에서 스마트 컨트랙트 직접 조회 시도 가능
- **읽기 전용 안전성:** API 미공개로 아직 판단 불가

---

## 4. 필요 환경 변수 / 시크릿 총정리

```env
# ─── Google Sheets ───
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}
GOOGLE_SPREADSHEET_ID=your_spreadsheet_id

# ─── Telegram ───
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=your_chat_id

# ─── Paradex (Read-Only JWT) ───
PARADEX_JWT_TOKEN=eyJhbGciOiJIUzI1NiIs...

# ─── Lighter (Read-Only Token) ───
LIGHTER_RO_TOKEN=ro:3:all:1893456000:abc123...

# ─── Extended (API Key, GET only) ───
EXTENDED_API_KEY=your_api_key

# ─── Pacifica (지갑 주소) ───
PACIFICA_WALLET_ADDRESS=your_solana_address
# PACIFICA_AGENT_KEY=... (필요 시)

# ─── Nado (EIP-712 서명용) ───
NADO_WALLET_ADDRESS=0x...
NADO_PRIVATE_KEY=0x...  # ⚠️ Linked Signer 키 사용 권장

# ─── 01 Exchange (Solana 키페어) ───
O1_SOLANA_KEYPAIR=[...byte array...]  # ⚠️ 소액 전용 지갑 권장

# ─── Variational (API 공개 후) ───
# VARIATIONAL_API_KEY=...
# VARIATIONAL_API_SECRET=...
```

---

## 5. 리퀴데이션 위험 감지 로직

각 거래소별 마진/리퀴데이션 지표:

| 거래소 | 핵심 지표 | 위험 임계값 (제안) |
|--------|----------|-------------------|
| Paradex | `margin_cushion` (계좌가치 - 유지증거금) | margin_cushion < 총자산의 20% |
| Lighter | `liquidation_price` (포지션별) | 현재가 대비 liquidation_price 거리 < 10% |
| Extended | margin ratio 계산 | maintenance margin 대비 여유 < 20% |
| Pacifica | `cross_mmr` (유지증거금 비율) | cross_mmr > 0.8 (1이면 청산) |
| Nado | position_change 스트림 마진 데이터 | 유지증거금 대비 여유 < 20% |
| 01 Exchange | `marginFraction` vs `maintenanceMarginRequirement` | marginFraction < maintenanceMR × 1.5 |
| Variational | (API 공개 후 확인) | TBD |

**알람 단계:**
1. **경고 (Warning):** 리퀴데이션까지 여유 20% 이하 → Telegram 메시지 (1회)
2. **위험 (Danger):** 리퀴데이션까지 여유 10% 이하 → Telegram 메시지 (5분마다 반복)
3. **긴급 (Critical):** 리퀴데이션까지 여유 5% 이하 → Telegram 메시지 (매번 + 강조 표시)

---

## 6. Google Sheets 기록 형식

기존 자산 정리 시트에 새 시트(탭)를 추가하여 기록:

| 시간 | 거래소 | 총 자산 (USD) | 잔액 | 사용 마진 | 마진 여유율 (%) | 포지션 수 | 미실현 PnL |
|------|--------|-------------|------|----------|---------------|----------|-----------|
| 2026-02-27 10:00 | Paradex | $5,230 | $3,200 | $2,030 | 38.8% | 3 | -$120 |
| 2026-02-27 10:00 | Lighter | $2,100 | $1,500 | $600 | 71.4% | 1 | +$45 |
| ... | ... | ... | ... | ... | ... | ... | ... |

**별도 Summary 탭:**
| 시간 | 총 자산 합계 (USD) | 거래소별 요약 | 위험 거래소 |
|------|-------------------|-------------|------------|
| 2026-02-27 10:00 | $15,430 | Paradex:$5.2K, Lighter:$2.1K, ... | 없음 |

---

## 7. 프로젝트 구조

```
perpdex_assets/
├── src/
│   ├── index.ts                 # Lambda 핸들러 (엔트리포인트)
│   ├── config.ts                # 환경 변수 & 설정
│   ├── exchanges/
│   │   ├── types.ts             # 공통 인터페이스 (ExchangeBalance, Position 등)
│   │   ├── paradex.ts           # Paradex API 연동
│   │   ├── lighter.ts           # Lighter API 연동
│   │   ├── extended.ts          # Extended API 연동
│   │   ├── pacifica.ts          # Pacifica API 연동
│   │   ├── nado.ts              # Nado API 연동
│   │   ├── o1exchange.ts        # 01 Exchange API 연동
│   │   └── variational.ts       # Variational API 연동 (placeholder)
│   ├── services/
│   │   ├── google-sheets.ts     # Google Sheets 기록
│   │   ├── telegram.ts          # Telegram 알람 발송
│   │   └── risk-analyzer.ts     # 리퀴데이션 위험 분석
│   └── utils/
│       └── logger.ts            # 로깅 유틸
├── package.json
├── tsconfig.json
├── .env.example                 # 환경 변수 템플릿
└── README.md
```

---

## 8. 실행 흐름 (5분마다)

```
1. EventBridge 트리거 → Lambda 실행
2. 7개 거래소 API 병렬 호출 (Promise.allSettled)
   - 개별 거래소 실패 시 다른 거래소는 정상 처리
   - 실패한 거래소는 에러 로그 + 시트에 "ERROR" 기록
3. 각 거래소 응답 파싱 → 공통 포맷으로 변환
4. Google Sheets에 행 추가 (일괄 append)
5. 리퀴데이션 위험 분석
   - 각 거래소 마진 여유율 계산
   - 임계값 비교
6. 위험 감지 시 → Telegram 알람 발송
   - 알람 중복 방지: 같은 위험 레벨이면 30분간 재발송 안 함
   - 위험 레벨 상승 시 즉시 발송
7. 실행 완료 (예상 소요: 2-5초)
```

---

## 9. 구현 순서

### Phase 1: 기본 인프라 (1일)
1. 프로젝트 초기화 (TypeScript, 패키지 설정)
2. Google Sheets 연동 (서비스 계정 설정 + append 테스트)
3. Telegram 알람 발송 테스트

### Phase 2: 거래소 연동 — Read-Only 우선 (2-3일)
4. 공통 인터페이스 정의 (`ExchangeBalance`, `Position`, `RiskLevel`)
5. Paradex 연동 (Read-Only JWT — 가장 깔끔)
6. Extended 연동 (API Key — 간단)
7. Lighter 연동 (Read-Only 토큰)
8. Pacifica 연동 (주소 기반 조회)

### Phase 3: 지갑 서명 필요 거래소 (2-3일)
9. Nado 연동 (EIP-712 서명)
10. 01 Exchange 연동 (Solana 키페어)
11. Variational 대기 또는 온체인 조회

### Phase 4: 리스크 엔진 & 배포 (1-2일)
12. 리퀴데이션 위험 분석 로직
13. 알람 중복 방지 로직
14. Lambda 배포 + EventBridge 스케줄 설정
15. 통합 테스트

---

## 10. 보안 고려사항

1. **읽기 전용 원칙 철저 준수**
   - Paradex, Lighter, Extended: 읽기 전용 키/토큰만 사용 ✅
   - Pacifica: 주소 기반 조회 우선, Agent Key는 read scope만 ✅
   - Nado, 01: 프라이빗 키 필요 ⚠️ → Linked Signer/소액 지갑 사용

2. **시크릿 관리**
   - Lambda: AWS Secrets Manager 또는 SSM Parameter Store에 저장
   - EC2: `.env` 파일 (chmod 600) + 절대 Git 커밋 금지

3. **지갑 키가 필요한 거래소 (Nado, 01)**
   - **절대 메인 지갑 키를 사용하지 않기**
   - 모니터링 전용 서브키/Linked Signer 설정
   - 코드에서 거래/출금 함수를 아예 호출하지 않도록 설계

---

## 11. 기술 스택

- **Runtime:** Node.js 20 (TypeScript)
- **HTTP Client:** axios 또는 node-fetch
- **Google Sheets:** googleapis (공식 SDK)
- **Telegram:** 직접 HTTP POST (의존성 최소화)
- **Web3:**
  - ethers.js (Nado EIP-712 서명)
  - @solana/web3.js (01 Exchange, Pacifica)
  - starknet.js (Paradex, Extended - 필요 시)
- **배포:** AWS Lambda + EventBridge (또는 기존 EC2 + PM2)
- **번들링:** esbuild (Lambda 패키징)

---

## 12. 비용 요약

| 항목 | 월 비용 |
|------|--------|
| AWS Lambda + EventBridge | $0 (프리티어) |
| Google Sheets API | $0 (무료 할당량 내) |
| Telegram Bot API | $0 (무료) |
| 거래소 API 호출 | $0 (무료) |
| **합계** | **$0/월** |

EC2를 사용하는 경우에도 이미 서버가 있으므로 추가 비용 $0.
