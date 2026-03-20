# Hyperliquid 잔액 조회 수정 계획

## 용어 정리 (다른 거래소 기준 확인 완료)

- `totalUsd`: 총 자산 (equity = 담보금 + 미실현 손익)
- `balance`: **여유 담보금** (마진에 사용되지 않은 잔액, free collateral)
  - Paradex → `freeCollateral`
  - Extended → `availableForTrade`
  - Lighter → `collateral` (총 담보금)
  - Pacifica → `account.balance` (입금 담보금)
  - Nado → USDC spot balance (담보금)
- `marginUsed`: 포지션에 묶인 마진
- `marginFreePercent`: 여유 마진 비율

## 문제점 분석

현재 코드 (`src/exchanges/hyperliquid.ts`):

### 1. `balance` 값이 비정상적으로 높음 (75,949 vs 실제)
- 원인: default perps + HIP-3 dex 모두에서 `marginSummary.totalRawUsd`를 합산
- HIP-3 dex는 동일한 담보 풀을 공유 → 합산하면 중복 계산
- `totalRawUsd`는 전체 USDC 담보금이므로 다른 거래소의 `balance`(여유 잔액)와 의미도 다름
- **수정**: balance = totalUsd - marginUsed (여유 잔액) 로 계산

### 2. `totalUsd` (accountValue)가 실제 Total Equity와 불일치 (8,276 vs 11,938)
- 원인: `clearinghouseState`는 perps만 반환. Spot 잔액 미포함
- Hyperliquid UI "Total Equity" = Perps Equity + Spot Balance
- **수정**: `spotClearinghouseState` API 추가 호출하여 spot 잔액 포함

## 수정 계획

### Step 1: Spot 잔액 조회 추가
- `fetchSpotState()` 메서드 추가: `POST /info` with `{ type: "spotClearinghouseState", user: "0x..." }`
- 응답: `{ balances: [{ coin: "USDC", hold: "...", total: "..." }, ...] }`
- spot 자산의 USD 가치를 계산 (USDC는 1:1, 다른 토큰은 추후 가격 조회 필요하면 추가)
- 새 인터페이스 `SpotClearinghouseState` 정의

### Step 2: HIP-3 dex 중복 계산 방지 + balance 의미 통일
- `totalRawUsd`는 더 이상 합산하지 않음 (default dex 값만 참고용)
- `accountValue`와 `totalMarginUsed`는 HIP-3 dex 합산 유지 (각 dex에 별도 포지션)

### Step 3: 반환값 계산 수정
- `totalUsd` = perps `accountValue` (all dexes 합산) + spot 자산 총 가치
- `balance` = totalUsd - marginUsed (다른 거래소와 동일하게 **여유 잔액**)
- `marginUsed` = totalMarginUsed (기존대로)
- `marginFreePercent` = (balance / totalUsd) * 100

## 수정 파일
- `src/exchanges/hyperliquid.ts` — 유일한 수정 대상
