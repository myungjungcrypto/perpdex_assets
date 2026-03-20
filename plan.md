# Hyperliquid 잔액 조회 수정 계획

## 문제점 분석

현재 코드 (`src/exchanges/hyperliquid.ts`)에서 두 가지 문제가 있음:

### 1. `balance` (totalRawUsd) 값이 비정상적으로 높음 (75,949 vs 실제 ~11,938)
- 원인: default perps + HIP-3 dex(예: xyz) 모두에서 `marginSummary.totalRawUsd`를 합산
- HIP-3 dex는 동일한 담보(collateral) 풀을 공유하므로, 각 dex에서 반환하는 `totalRawUsd`를 합산하면 중복 계산됨
- **수정**: `totalRawUsd`(balance)는 default dex에서만 가져오고, HIP-3 dex에서는 합산하지 않음

### 2. `totalUsd` (accountValue)가 실제 Total Equity와 불일치 (8,276 vs 11,938)
- 원인: `clearinghouseState` API는 perps 계정만 반환. Spot 잔액이 포함되지 않음
- Hyperliquid UI의 "Total Equity" = Perps Equity + Spot Balance + Vault Equity
- **수정**: `spotClearinghouseState` API를 추가 호출하여 spot 잔액을 포함

## 수정 계획

### Step 1: Spot 잔액 조회 추가
- `spotClearinghouseState` API 호출 추가 (`POST /info` with `type: "spotClearinghouseState"`)
- 응답에서 spot 자산의 USD 가치를 계산하여 total equity에 합산
- 새로운 인터페이스 `SpotClearinghouseState` 정의

### Step 2: HIP-3 dex의 balance 중복 계산 방지
- `totalRawUsd`(balance)는 default dex의 값만 사용
- `accountValue`와 `totalMarginUsed`는 HIP-3 dex에서도 별도 포지션이 있으므로 합산 유지
- HIP-3 dex의 포지션 파싱은 기존대로 유지

### Step 3: totalUsd 계산 수정
- `totalUsd` = perps `accountValue` (all dexes 합산) + spot 자산 총 가치
- `balance` = default dex의 `totalRawUsd`만 (중복 방지)
- `marginFreePercent`는 기존 계산 유지 (perps 기준)

## 수정 파일
- `src/exchanges/hyperliquid.ts` — 메인 수정 대상

## Hyperliquid API 참고
- **clearinghouseState**: `{ type: "clearinghouseState", user: "0x..." }` → perps 정보
- **spotClearinghouseState**: `{ type: "spotClearinghouseState", user: "0x..." }` → spot 잔액
  - 응답: `{ balances: [{ coin: "USDC", hold: "...", total: "..." }, ...] }`
