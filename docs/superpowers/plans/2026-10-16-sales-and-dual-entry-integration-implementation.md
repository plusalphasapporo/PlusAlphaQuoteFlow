# QuoteFlow Cloud 顧客受注・2系統入口・共通情報 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 顧客情報確認 → 見積 → 打ち合わせ → 受注・失注 → 審査・支払 → 発注・入荷 → 工事・施工 → 機器・保守 → サポートの9工程を1案件画面で進め、顧客情報を見積に引き継いで二重入力を防ぐ。

**Architecture:** 開発中PR #43の`deals`と既存quotes/orders/purchase_orders/deliveries/assets/contractsを正本にする。サポートチケットは別の正本に残し、必要時のみ明示的参照キーで販売案件と接続する。サポート一次対応部分は別計画`2026-10-16-support-firstline-handoff-implementation.md`の出力を利用する。

**Tech Stack:** GitHub Pages静的HTML・Vanilla JS・Supabase PostgreSQL・Node 22 native tests・GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-10-16-dual-workflow-sales-and-support-design.md`（第3、5〜9章）、詳細は`docs/superpowers/specs/2026-10-16-unified-deal-flow-with-lost-quotes-design.md`。

## Global Constraints

- **顧客情報確認が必ず第1工程**。既存顧客検索・新規登録・本支店・電話・メール・担当者・設置先を確認し、`customer_id`を見積へ渡す。旧顧客番号、既存の本支店の親子関係と過去の見積は不変。

- 見積の**社内承認は不要**。担当社内職員が見積発行→受注／失注を操作する。商談記録を追加の承認ゲートにはしない。
- 見積番号・受注番号・旧顧客番号・本支店・過去の見積・チケット・添付・監査ログを変更・削除しない。
- `deals.sales_outcome`は`open/won/lost/cancelled_after_order`。既存`quotes.status='accepted'`を受注確定とみなさず`orders`実在で判断する。
- 支払方法はリース、振込、現金、分割、請求後払い等。リース以外に与信審査を強制しない。
- 仕入・入荷と工事日調整は並列。納品・検収、機器・保守は正本データを参照し二重作成しない。
- サポート会社に見積・仕入・リース与信を公開しない。担当顧客の機器・保守と必要な施工情報のみを開示。
- 販売とサポートの状態マスターは統合しない。問い合わせ実在時のみサポートチケットを作成。
- 本番DBと表示上「Staging」と名付けられた接続済みDBは同じ運用データの可能性があるため、**分離DBと証明できない限り書込み検証禁止**。

## Review Focus

1. 旧承認済み見積が受注済み扱いになる誤判定 → orders行で確認（Task 1）。
2. 見積から失注／旧受注画面から同時受注して両方成功 → 共有の案件ロックで排他（Task 1/2）。
3. 打ち合わせ日付を本支店や他の顧客へ誤接続 → deal_id+customer_id検査（Task 2）。
4. サポート会社への原価・与信漏洩／曖昧な機器・契約紐づけ → 権限RPCと明示キーのみ（Task 4）。
5. 施工不要・発注不要でも工程が永遠に保留 → 明示的「対象外」と次操作の導出（Task 3）。

---

### Task 0: 顧客情報確認（最初の工程）

**Files:** Create `assets/deal-customer-step.js`, `tests/deal-customer-step.test.mjs`, `tests/deal-customer-handoff.test.mjs`; Modify `assets/deal-workflow.js`, `index.html`。

**Interfaces:** `QuoteFlowDealCustomerStep.configure({rpc,getRole,getHost,openCustomerCreate,createQuote})`, `open({preselectedCustomerId=null})`, `confirm({customerId,contactId=null,installationAddress=null})` → `{customerId,contactId,installationAddress}`。既存の`internal_customers_list`, `internal_customer_detail`, `internal_customer_contacts`, `renderCustomerCreate()`, `renderCustomerQuoteCreate(preselectedCustomerId)`を再利用する。

- [ ] **Step 1: Failing tests.** 既存顧客検索、旧顧客番号、本支店（`branch_type`/`parent_customer_id`）、連絡先・担当者（`contacts.customer_id`）、設置場所確認を検証。顧客未選択、別顧客の担当者、停止顧客は見積へ進ませない。選択した`customerId`が見積まで同一で、旧番号・既存書類が不変であることを確認。
- [ ] **Step 2: RED.** `node --test tests/deal-customer-step.test.mjs tests/deal-customer-handoff.test.mjs`が未実装機能で失敗することを確認。
- [ ] **Step 3: Implement.** 「顧客情報確認 → この顧客で見積へ進む」を独立画面で実装し、既存顧客登録・重複候補確認と見積フォームを呼ぶ。顧客選択値を変更する場合は再確認を要求する。社内職員に`deals`ルート権限を付け、サポート会社には非公開。
- [ ] **Step 4: GREEN.** `node --test tests/deal-customer-step.test.mjs tests/deal-customer-handoff.test.mjs tests/deal-workflow-ui.test.mjs`および`node scripts/validate-static.mjs`が成功。
- [ ] **Step 5: Commit.** `git add assets/deal-customer-step.js assets/deal-workflow.js index.html tests/deal-customer-step.test.mjs tests/deal-customer-handoff.test.mjs && git commit -m "feat: confirm customer before sales quote"`
- [ ] **Step 6: Independent review.** この工程だけの独立PRで、別担当者が本支店・担当者の整合性、顧客二重作成、MFA、見積引継ぎを検査し、修正後CIを再実行。合格するまでTask 1に進まない。

### Task 1: PR #43の既存実装と実DBスキーマの整合性レビュー

**Files:** Modify `sql/deal_workflow_quote_order.sql`、`sql/deal_workflow_open_from_quote.sql`、`tests/deal-order-sync.test.mjs`。Create `tests/deal-postgres-integration.test.mjs`。

**Interfaces:** 既存`deal_issue_quote(p_deal_id,p_quote_id)`、`deal_create_order_from_quote(p_deal_id,p_quote_id)`、`internal_deal_open_from_quote(p_quote_id)`を後方互換で維持。旧注文挿入は`orders` INSERTトリガーで`deals.sales_outcome='won'`へ同期。

- [ ] **Step 1: RED test.** 隔離DBで全SQLを依存順に適用した際に、見積発行・受注・失注の成功/拒否を検証。既存の`accepted`、再送、同時失注・受注、異なる本支店、同一案件の異なる見積番号で二重受注をテスト。
- [ ] **Step 2: Confirm failure.** `node --test tests/deal-postgres-integration.test.mjs`（独立DB接続と期待した失敗事象を確認）。
- [ ] **Step 3: Minimal repairs.** PostgreSQLデータ型、制約、外部キー、関数名、既存監査ログと整合するよう修正。現行の見積・受注正本、番号採番、旧登録RPCの保護を維持。
- [ ] **Step 4: GREEN.** 同テスト＋`node --test tests/deal-workflow-*.test.mjs tests/deal-order-sync.test.mjs`。本番DBは実行対象にしない。
- [ ] **Step 5: Commit.** `git add sql/deal_workflow_quote_order.sql sql/deal_workflow_open_from_quote.sql tests/ && git commit -m "fix: validate order and loss against isolated PostgreSQL"`

### Task 2: 打ち合わせの複数回記録と見積からの導線

**Files:** Create `sql/deal_meetings.sql`、`tests/deal-meetings.test.mjs`。Modify `assets/deal-workflow.js`、`sql/deal_workflow_linked_records.sql`。

**Interfaces:** `public.internal_deal_save_meeting(p_deal_id uuid,p_payload jsonb)` → `{id,deal_id,occurred_at,channel,summary,next_step,next_meeting_at,actor_id}`。追記専用`deal_meetings`と`deal_events`に記録。`internal_deal_detail(p_deal_id)`の`meetings`配列で読み取る。channelは`visit/phone/online/email/other`。

- [ ] **Step 1: RED test.** 見積発行済みから何度でも打ち合わせ入力可能、顧客一致、日時と結果必須、メモの二重保存防止、注文・失注時に履歴保全。サポート職員・別顧客・匿名は書込み拒否。
- [ ] **Step 2: RED.** `node --test tests/deal-meetings.test.mjs`。
- [ ] **Step 3: Implement.** 最小テーブル、MFA・社内職員権限を検査するRPC、見積詳細の「打ち合わせ」カードと次操作ボタンを追加。営業メモは外部ユーザー非公開。会議登録を受注必須条件にしない。
- [ ] **Step 4: GREEN.** 同テストと既存`tests/deal-workflow-ui.test.mjs`成功。
- [ ] **Step 5: Commit.** `git add sql/deal_meetings.sql sql/deal_workflow_linked_records.sql assets/deal-workflow.js tests/deal-meetings.test.mjs && git commit -m "feat: append meeting records to sales deals"`

### Task 3: 受注後の並行工程・「対象外」処理

**Files:** Modify `assets/deal-progress.js`、`assets/deal-workflow.js`、`sql/deal_installation.sql`、`sql/deal_financing.sql`。Create `tests/deal-parallel-progress.test.mjs`。

**Interfaces:** `QuoteFlowDealProgress.derive(data)` → `{stage,nextAction,target,steps,blockers}`。工事・発注それぞれの`not_required`決定は記録者・理由・日時を`deal_events`に残し、UIは未登録との区別を表示する。

- [ ] **Step 1: RED test.** リース否決は審査保留、振込は審査対象外。発注未完了でも工事日を仮予約できる。発注なし/工事なし案件は明示的理由とともにスキップ。入荷未完・延期・未検収・再訪問は適切な次操作が現れ、機器／契約を重複作成しない。
- [ ] **Step 2: RED.** `node --test tests/deal-parallel-progress.test.mjs`。
- [ ] **Step 3: Implement.** 運用上の工程を必要条件・並行条件へ分解し、ブロッカーを一覧に出す。注文・仕入・納品の既存キーを参照し、欠落を新規作成済みと偽装しない。
- [ ] **Step 4: GREEN.** 同テスト＋`tests/deal-financing.test.mjs`＋`tests/deal-installation.test.mjs`成功。
- [ ] **Step 5: Commit.** `git add assets/deal-progress.js assets/deal-workflow.js sql/deal_installation.sql sql/deal_financing.sql tests/deal-parallel-progress.test.mjs && git commit -m "feat: support parallel procurement and optional installation"`

### Task 4: サポートとの安全な相互参照と引継ぎ用情報

**Files:** Create `sql/deal_support_links.sql`、`tests/deal-support-links.test.mjs`。Modify `assets/deal-workflow.js`、`sql/deal_workflow_linked_records.sql`。

**Interfaces:** `public.internal_link_deal_support(p_deal_id uuid,p_ticket_id uuid)` → `{deal_id,ticket_id}`。中間テーブル`deal_support_links(deal_id,ticket_id,linked_by,linked_at)`は(deal_id,ticket_id)一意。読み取り側は役割に応じ顧客名、機器型番、設置先、保守対象・期間のみを抽出し、仕入原価・与信・内部営業メモを返さない。

- [ ] **Step 1: RED test.** 同顧客/同一本支店の明示的リンクのみ許可。顧客IDだけで推測結合しない。サポート会社は他社顧客・販売情報を閲覧できない。再送してもリンク1本。施工未完了を完了扱いにしない。リンクにより空のチケットが自動作成されない。
- [ ] **Step 2: RED.** `node --test tests/deal-support-links.test.mjs`。
- [ ] **Step 3: Implement.** 既存`support_tickets.asset_id/contract_id`・資産のFKが確定する場合の閲覧を優先。中間リンクは明示的操作時だけ作成し、社内の許可済み職員のみ変更。サポート会社へは最小化した別ビュー／RPCを返す。
- [ ] **Step 4: GREEN.** 同テスト＋`tests/deal-workflow-linkage.test.mjs`、別サポート会社・顧客アカウントの隔離DBテスト成功。
- [ ] **Step 5: Commit.** `git add sql/deal_support_links.sql sql/deal_workflow_linked_records.sql assets/deal-workflow.js tests/deal-support-links.test.mjs && git commit -m "feat: link sales and support without revealing sales financials"`

### Task 5: トップ画面の2入口と権限別ナビゲーション

**Files:** Create `assets/workflow-landing.js`、`tests/workflow-landing.test.mjs`。Modify `index.html`、`assets/deal-workflow.css`。

**Interfaces:** `window.QuoteFlowWorkflowLanding.mount({role,host,openSupport,openSales,supportCounts,salesCounts})`。呼出側は現在の`renderHome()`。既存ページID `support`、`support_cases`、`handoffs`、`deals`を使用。

- [ ] **Step 1: RED test.** 社内職員は顧客サポート／顧客受注の2入口、担当サポート会社はサポート入口のみ、顧客は公開済みの問い合わせ入口のみ。重複`['deals','案件進行管理']`は1件へ整理。クリックで正しいページに遷移し、既存ダッシュボード集計値を壊さない。
- [ ] **Step 2: RED.** `node --test tests/workflow-landing.test.mjs`。
- [ ] **Step 3: Implement.** 既存`renderHome`の該当ロールにカードを追加、不要なアイコンや絵文字なし、スマホで縦配置と次操作優先。既存メニューは維持。営業ページ`deals`のスタッフ利用権限とロール別RPCを検証。
- [ ] **Step 4: GREEN.** 同テスト＋`tests/deal-workflow-ui.test.mjs`＋`tests/support-ticket-tabs.test.mjs`。
- [ ] **Step 5: Commit.** `git add assets/workflow-landing.js assets/deal-workflow.css index.html tests/workflow-landing.test.mjs && git commit -m "feat: separate support and sales entry points"`

### Task 6: 統合権限・CI・隔離DB検証と段階的公開判定

**Files:** Modify `.github/workflows/quote-flow-ci.yml`。Create `scripts/verify-dual-flow-release.mjs`、`tests/dual-flow-release.test.mjs`。

**Interfaces:** `verify-dual-flow-release.mjs`は環境識別・バックアップ・全FK/番号差分・通知・ロール別テスト・ブラウザ動作確認のチェックを実施／記録し、未検証なら公開判定を拒否する。サポート計画Task 6のゲートを流用する。

- [ ] **Step 1: RED test.** 隔離DB証明がない場合は実書込みテストを拒否。全Role別MFAと担当会社限定の閲覧、見積承認不要、CallConnect通知例外、見積・受注・支店・機器・契約・チケット番号保持、業務ログ非公開、二重受注・二重引継ぎ防止、スマホ／PCの確認が欠けたらリリース拒否。
- [ ] **Step 2: RED.** `node --test tests/dual-flow-release.test.mjs`。
- [ ] **Step 3: Implement.** CIで`node --test tests/*.test.mjs`、`node scripts/validate-static.mjs`、`node scripts/validate-browser.mjs`、`node scripts/build-staging-preview.mjs`。隔離環境での全DDL/RPC実実行、復旧リハーサル、データ件数とFK差分を保存。GitHub Pagesのアセット一致とログイン操作を確認して公開判断。
- [ ] **Step 4: GREEN.** 新規全テスト＋既存CI成功、隔離DBのロール別実テスト／リハーサル証跡確認。**本番確認なしにPRをマージ・公開しない**。
- [ ] **Step 5: Commit.** `git add .github/workflows/quote-flow-ci.yml scripts/verify-dual-flow-release.mjs tests/dual-flow-release.test.mjs && git commit -m "test: enforce dual-flow rollout gates"`

## Independent Review Gates

- **各工程を独立PR・独立レビュー**とし、RED → 実装 → GREEN・回帰CI → 別担当レビュー → 指摘修正 → 再テストを完了条件とする。レビュー担当者がいない場合は未完了として停止する。
- サポート工程のPR #44へ販売側の変更を混ぜない。隔離DBで検証するまで本番SQLを適用しない。

## Order and Dependencies

販売DBと案件画面の現行実装（PR #43）をベースにTask 0→1→2→3→4で検証。Task 5のトップ入口はサポート計画Task 3〜5のインターフェース確認後に統合。Task 6は2計画のゲートが揃ってから実行。単独で動くサポート業務はサポート計画のレビューを先に通せる。どちらも本番反映は隔離DBの検証とユーザーの確認後。

## Scope Exclusions

会計サービスとの決済実行、CallConnectの未実装API、顧客ポータルの承認操作、見積の社内承認、既存データ削除や全件再移行は対象外。
