# Balance Monitor 멀티유저 공유 계획서

## 개요

현재 단일 `.env` 파일로 1명만 사용하는 구조를 **유저별 독립 PM2 프로세스**로 확장.
코드 변경 최소화하면서 각 유저가 독립적으로 모니터링 가능하게 함.

---

## 아키텍처

```
현재:  .env → 1개 PM2 프로세스 → 1개 Google Sheet + 1개 Telegram

변경:  users/alice/.env → PM2 "monitor-alice" → Alice의 Sheet + Alice의 Telegram
       users/bob/.env   → PM2 "monitor-bob"   → Bob의 Sheet   + Bob의 Telegram
       users/charlie/.env → PM2 "monitor-charlie" → Charlie의 Sheet + ...
```

- 각 유저별 독립 프로세스 (서로 간섭 없음)
- 한 유저가 에러 나도 다른 유저 영향 없음
- 유저 추가/제거가 간단함

---

## 코드 변경 사항 (최소)

### 1. `src/config.ts` — 커스텀 .env 경로 지원 (1줄 수정)

```typescript
// 변경 전
dotenv.config();

// 변경 후
dotenv.config({ path: process.env.ENV_FILE || '.env' });
```

### 2. `ecosystem.config.js` — 유저별 PM2 앱 동적 생성

```javascript
const fs = require("fs");
const path = require("path");

const usersDir = path.join(__dirname, "users");
const apps = [];

// users/ 디렉토리의 각 유저 폴더를 읽어서 PM2 앱 생성
if (fs.existsSync(usersDir)) {
  for (const name of fs.readdirSync(usersDir)) {
    const envFile = path.join(usersDir, name, ".env");
    if (fs.existsSync(envFile)) {
      apps.push({
        name: `monitor-${name}`,
        script: "dist/index.js",
        autorestart: true,
        restart_delay: 5000,
        watch: false,
        env: {
          NODE_ENV: "production",
          ENV_FILE: envFile,
        },
        error_file: `logs/${name}-error.log`,
        out_file: `logs/${name}-out.log`,
        log_date_format: "YYYY-MM-DD HH:mm:ss",
        max_memory_restart: "200M",
      });
    }
  }
}

// 기존 단일 .env 사용자도 유지 (fallback)
if (apps.length === 0) {
  apps.push({
    name: "balance-monitor",
    script: "dist/index.js",
    autorestart: true,
    restart_delay: 5000,
    watch: false,
    env: { NODE_ENV: "production" },
    error_file: "logs/error.log",
    out_file: "logs/out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    max_memory_restart: "200M",
  });
}

module.exports = { apps };
```

### 3. 디렉토리 구조

```
perpdex_assets/
├── users/                      ← 새로 생성
│   ├── myungj/                 ← 본인
│   │   └── .env
│   ├── alice/                  ← 친구 1
│   │   └── .env
│   └── bob/                    ← 친구 2
│       └── .env
├── .gitignore                  ← users/ 추가
└── ...
```

---

## 친구가 제공해야 할 정보

### 필수 항목

| 항목 | 설명 | 발급 방법 |
|------|------|----------|
| **Google Service Account JSON** | Google Sheets 접근용 서비스 계정 | Google Cloud Console → IAM → 서비스 계정 생성 → JSON 키 다운로드 |
| **Google Spreadsheet ID** | 본인 스프레드시트 ID | 시트 URL에서 `/d/{이 부분}/edit` |
| **Telegram Chat ID** | 알림 받을 텔레그램 채팅 ID | @userinfobot 에게 메시지 보내면 알려줌 |

### 거래소별 (사용하는 거래소만)

| 거래소 | 필요 정보 | 발급 방법 |
|--------|----------|----------|
| **Paradex** | Read-Only JWT Token | Paradex API `/auth` 엔드포인트 |
| **Lighter** | Read-Only Token (`ro:...`) | Lighter 대시보드 → API Keys → Read Only |
| **Extended** | API Key | Extended 거래소 → API Management |
| **Pacifica** | Solana 지갑 주소 | 지갑에서 복사 (키 불필요, 퍼블릭 주소만) |
| **Nado** | ETH 지갑 주소 | 지갑에서 복사 (키 불필요, 퍼블릭 주소만) |
| **01 Exchange** | N1 지갑 주소 | 지갑에서 복사 (키 불필요, 퍼블릭 주소만) |

> **보안 참고:** 모든 키는 **읽기 전용(Read-Only)** 권한만 필요. 출금/거래 권한 절대 불필요.

---

## 친구 온보딩 절차

### Step 1: 친구가 준비할 것

```
1. Google Cloud Console에서 프로젝트 생성
2. Google Sheets API 활성화
3. 서비스 계정 생성 → JSON 키 다운로드
4. Google Spreadsheet 새로 만들기
5. 스프레드시트에 서비스 계정 이메일 (xxxx@xxx.iam.gserviceaccount.com) 편집자 권한 공유
6. Telegram에서 @BotFather로 봇 만들거나, 공용 봇 사용
7. @userinfobot으로 Chat ID 확인
8. 사용하는 거래소의 Read-Only API 키/지갑 주소 준비
```

### Step 2: 서버에서 설정 (내가 해줌)

```bash
# 1. 유저 디렉토리 생성
mkdir -p users/{친구이름}

# 2. .env 파일 생성 (친구가 보내준 정보로)
cp .env.example users/{친구이름}/.env
nano users/{친구이름}/.env    # 친구 정보 입력

# 3. 빌드 & 재시작
npm run build
pm2 restart ecosystem.config.js

# 4. 로그 확인
pm2 logs monitor-{친구이름}
```

### Step 3: 확인

```bash
# 전체 유저 상태 확인
pm2 status

# 개별 유저 로그
pm2 logs monitor-alice
pm2 logs monitor-bob
```

---

## Telegram 봇 전략

### 옵션 A: 공용 봇 1개 (추천 — 가장 간단)

- 봇 하나 만들어서 모든 유저가 공유
- 각 유저가 봇에 `/start` 보내고, Chat ID만 각자 .env에 설정
- 봇 토큰은 동일, Chat ID만 다름
- `TELEGRAM_BOT_TOKEN`은 공통, `TELEGRAM_CHAT_ID`만 유저별

### 옵션 B: 각자 봇 생성

- 각 친구가 @BotFather로 자기 봇 생성
- 완전한 독립성, 하지만 관리 번거로움

---

## 리소스 예상

| 항목 | 현재 (1유저) | 5유저 | 10유저 |
|------|-------------|-------|--------|
| 메모리 | ~80MB | ~400MB | ~800MB |
| CPU | 거의 없음 | 거의 없음 | 미미 |
| API 호출 | 5회/분 | 25회/분 | 50회/분 |
| Google Sheets | 2회/분 | 10회/분 | 20회/분 |

- EC2 t3.small (2GB RAM)이면 5유저 충분
- 10유저 이상이면 t3.medium (4GB) 권장
- Google Sheets API 무료 한도: 분당 60회 → 10유저까지 여유

---

## 구현 난이도 & 소요 시간

| 작업 | 난이도 | 예상 |
|------|--------|------|
| config.ts 수정 | ★☆☆☆☆ | 1줄 |
| ecosystem.config.js 수정 | ★★☆☆☆ | 15줄 |
| users/ 디렉토리 구조 | ★☆☆☆☆ | mkdir |
| .gitignore 업데이트 | ★☆☆☆☆ | 1줄 |
| 온보딩 가이드 작성 | ★★☆☆☆ | 이 문서 |
| **전체** | **매우 쉬움** | — |

---

## 보안 고려사항

1. `users/` 디렉토리는 `.gitignore`에 추가 (절대 git에 올리지 않음)
2. `chmod 700 users/` — 디렉토리 접근 제한
3. `chmod 600 users/*/.env` — 파일 접근 제한
4. 모든 API 키는 **Read-Only 권한만** 사용
5. 서비스 계정은 해당 유저의 스프레드시트에만 접근 가능

---

## 향후 확장 (필요 시)

- **웹 대시보드**: 유저가 직접 .env 설정할 수 있는 간단한 웹 UI
- **유저 추가 CLI 스크립트**: `./add-user.sh alice` 같은 자동화
- **공유 텔레그램 그룹**: 모든 유저 알림을 한 그룹에 모아보기
- **Docker Compose**: 유저별 컨테이너 분리

> 현재는 위 기본 구현만으로 충분. 유저 5명 이하에서는 오버엔지니어링 불필요.
