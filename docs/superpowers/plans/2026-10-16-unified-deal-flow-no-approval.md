# QuoteFlow Cloud 一案件一画面・失注・承認不要 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 見積担当者が社内承認を待たず、見積発行から受注または失注、支払・リース、発注・入荷、工事・施工、機器・保守、サポートまでを一案件画面で管理する。

**Architecture:** Supabase PostgreSQLを正本とし、既存の見積・受注・購買・納品・機器・保守・サポートテーブルを新しいdealsへ関連づける。既存RPCを壊さない拡張用RPCと、小さなJSモジュールでの案件UIを追加する。失注と受注は同一行ロックで競合排他する。

**Tech Stack:** GitHub Pages static HTML/vanilla JavaScript, Supabase PostgreSQL/PostgREST RPC, Node 22 native tests, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-16-unified-deal-flow-with-lost-quotes-design.md`

## Global Constraints

- 見積時の社内承認は**不要**。社内職員が「下書き→見積発行→受注／失注」へ直接進める。
- 顧客側のアプリ承認も必須としない。合意確認日時と商談履歴を監査する。
- 失注理由・失注日を必須、競合と再提案日を任意とする。「その他」は詳細必須。
- 既存顧客・支店紐づけ・旧番号・見積・受注・履歴を変更・削除しない。デモデータも無断削除しない。
- MFA、権限、監査、担当顧客限定通知を維持。サポート会社・顧客には見積原価や与信詳細を開示しない。
- 発注や施工が対象外の案件は「対象外」と明示する。保守・サポートは施工完了の代替としない。
- 本番公開はDBバックアップ・リハーサル・CIとログイン後の操作確認が揃ってから。

## Review Focus

1. **既存acceptedの意味の混在:** 旧社内承認を受注とみなさず、ordersの実在で判定する。Task 2/4で検証。
2. **失注と受注の同時要求:** 両方確定しない。Task 3/4で二つの同時トランザクションを検証。
3. **支店・顧客の混線:** customer_id一致だけで独立した機器や契約を勝手に紐づけない。Task 2/7で検証。
4. **通信再送で発注や工事を二重作成:** 冪等性キー、既存受注との照合を行う。Task 4/6で検証。
5. **権限の取り違え:** 社内職員に承認は不要だが、顧客・サポート会社の原価閲覧・失注操作は拒否する。Task 3/8で検証。

---

## Release 1: 案件基盤・失注・承認不要の見積→受注

### Task 1: 案件データと既存テーブルの関連

**Files:**
- Create: `sql/deal_workflow_base.sql`
- Test: `tests/deal-workflow-schema.test.mjs`

**Interfaces:** `public.deals(id uuid,customer_id uuid,title text,owner_user_id uuid,sales_outcome text,current_stage text,next_action text,due_at timestamptz,created_at timestamptz,updated_at timestamptz)`; `quotes.deal_id`, `orders.deal_id`, `purchase_orders.deal_id`, `deliveries.deal_id`, `assets.deal_id`, `contracts.deal_id`, `support_tickets.deal_id`はnullable FK。新規テーブル`deal_loss_events`/`deal_events`。

- [ ] **Step 1:** `tests/deal-workflow-schema.test.mjs`に、既存カラム変更・削除なし、識別子・参照FK、sales_outcomeチェック、既存の本支店保持を検証する失敗テストを追加する。
- [ ] **Step 2:** `node --test tests/deal-workflow-schema.test.mjs`を実行し、対象DDLが存在しない理由で失敗することを確認する。
- [ ] **Step 3:** `sql/deal_workflow_base.sql`へ作成専用DDLとRLSを追加する。既存の受注・見積に触れる変更はnullable列追加だけとする。
- [ ] **Step 4:** 同テスト成功を確認してコミットする。

### Task 2: 安全な案件取得・既存データの紐づけ

**Files:**
- Create: `sql/deal_workflow_queries.sql`
- Test: `tests/deal-workflow-read.test.mjs`

**Interfaces:** `public.internal_deals_list()`、`public.internal_deal_detail(p_deal_id uuid)`。返却JSONは顧客・本支店・見積・受注・担当者・次工程・期限・営業結果を持つ。

- [ ] **Step 1:** 顧客別一覧、旧acceptedと受注済の区別、他顧客の関係誤認防止、権限拒否を確認する失敗テストを作る。
- [ ] **Step 2:** `node --test tests/deal-workflow-read.test.mjs`の失敗を確認する。
- [ ] **Step 3:** security definerの集約RPCと対象顧客へのアクセス検証を実装する。バックフィル用SQLは`quotes.id→orders.quote_id→purchase_orders.order_id/deliveries.order_id→assets.source_delivery_id`の確定した関係だけを使い、Dry Runの件数と候補を出す。
- [ ] **Step 4:** テスト成功・コミット。

### Task 3: 失注登録・履歴・案件再開

**Files:**
- Create: `sql/deal_workflow_loss.sql`
- Test: `tests/deal-workflow-loss.test.mjs`

**Interfaces:** `public.internal_deal_mark_lost(p_deal_id uuid,p_quote_id uuid,p_lost_date date,p_reason_category text,p_detail text,p_competitor text,p_reproposal_on date)`、`public.internal_deal_reopen(p_deal_id uuid,p_reason text)`。

- [ ] **Step 1:** 理由なし、受注済、他社、二重操作、失注からの再開、監査のテストを失敗させる。
- [ ] **Step 2:** `node --test tests/deal-workflow-loss.test.mjs`失敗確認。
- [ ] **Step 3:** 行ロック・ロールチェック・必須入力・不可逆な履歴記録を実装する。quote.statusは失注用の既存rejectedに書き換えない。
- [ ] **Step 4:** テスト成功・コミット。

### Task 4: 社内承認なしで見積発行・直接受注

**Files:**
- Create: `sql/deal_workflow_quote_order.sql`
- Test: `tests/deal-workflow-order.test.mjs`

**Interfaces:** `public.deal_issue_quote(p_deal_id uuid,p_quote_id uuid)`、`public.deal_create_order_from_quote(p_deal_id uuid,p_quote_id uuid)`。

- [ ] **Step 1:** draft→finalized、社内職員の直接受注、重複クリック、lost案件からの受注拒否、旧acceptedへの後方互換、同時受注・失注ロックの失敗テスト。
- [ ] **Step 2:** `node --test tests/deal-workflow-order.test.mjs`が期待理由で失敗することを確認。
- [ ] **Step 3:** 旧見積ステータスの必要な互換更新と受注番号生成を原子的に実施。旧`approve_quote`を呼ばず、管理者承認イベントを生成しない。旧`convert_quote_to_order`もlost時はブロックする。
- [ ] **Step 4:** テスト成功・コミット。

### Task 5: 1案件1画面のナビゲーション

**Files:**
- Create: `assets/deal-workflow.js`
- Create: `assets/deal-workflow.css`
- Modify: `index.html`
- Test: `tests/deal-workflow-ui.test.mjs`

**Interfaces:** `window.QuoteFlowDeals.openList()`、`window.QuoteFlowDeals.openDetail(dealId)`、`window.QuoteFlowDeals.openLossDialog(dealId,quoteId)`、`window.QuoteFlowDeals.openIssueDialog(dealId,quoteId)`。従来の`go('sales')`から案件へ往復可能にする。

- [ ] **Step 1:** 見積・受注・失注の主要操作、工程帯、失注理由、表示権限、次工程へのリンクの失敗テスト。
- [ ] **Step 2:** `node --test tests/deal-workflow-ui.test.mjs`の失敗を確認。
- [ ] **Step 3:** 案件一覧・詳細・フォームを独立モジュールで実装し、既存メニューを残す。承認待ち・管理者承認ボタンは新導線に表示しない。
- [ ] **Step 4:** テスト成功・コミット。

## Release 2: 支払方法、リース、調達、工事

### Task 6: 支払・リースと発注・入荷の進捗リンク

**Files:** Create `sql/deal_financing.sql`; modify `assets/deal-workflow.js`; test `tests/deal-financing.test.mjs`.

**Interfaces:** `deal_financing` (deal_id,method,lease_company,credit_status,lease_months,monthly_amount,payment_state,updated_at)。`internal_deal_set_financing(p_deal_id,p_payload jsonb)`。受注から既存のpurchase_orders/purchase_order_itemsへ正規の呼び出しで遷移。

- [ ] 失敗テスト: 非リースは与信不要、リースは審査結果を保持、他顧客拒否、再送に対し発注は一度だけ。
- [ ] `node --test tests/deal-financing.test.mjs`失敗確認。
- [ ] DB/RPC・案件内タブ・ナビゲーションを実装。単一支払方法、併用はメモ明記とする。
- [ ] テスト成功・コミット。

### Task 7: 工事日、施工・検収、機器・契約

**Files:** Create `sql/deal_installation.sql`; modify `assets/deal-workflow.js`; test `tests/deal-installation.test.mjs`.

**Interfaces:** `deal_installation_jobs` (id,deal_id,delivery_id,scheduled_start_at,scheduled_end_at,state,work_note,completed_at,acceptance_state,assigned_user_id,created_at,updated_at)。`internal_deal_save_installation(p_deal_id,p_job jsonb)`。

- [ ] 失敗テスト: 工事仮予約・確定・延期履歴、二回施工、未検収、顧客・本支店の一致、納品由来機器重複なし。
- [ ] `node --test tests/deal-installation.test.mjs`失敗確認。
- [ ] DB/RPC・工事日・施工画面を実装し、既存deliveries・assets・contractsを関連づける。施工日と納品予定日を勝手に同一更新しない。
- [ ] テスト成功・コミット。

## Release 3: 保守・サポート、通知、集計、移行検証

### Task 8: サポート連携・権限と営業集計

**Files:** Create `sql/deal_workflow_support.sql`; modify `assets/deal-workflow.js`; test `tests/deal-workflow-access.test.mjs`。

**Interfaces:** `internal_deal_support_summary(p_deal_id uuid)` と担当顧客だけを読むロール別閲覧RPC、見積失注率集計。

- [ ] 失敗テスト: サポート職員は担当顧客の機器・工事・保守だけ閲覧可能、原価・与信は不可。顧客に内部失注メモを返さない。支店・番号の整合性、通知の担当絞込を確認。
- [ ] `node --test tests/deal-workflow-access.test.mjs`失敗確認。
- [ ] 既存CallConnect・サポート案件へのリンクと役割別画面を実装。
- [ ] テスト成功・コミット。

### Task 9: 総合リグレッション、リハーサル、段階的公開

**Files:** Modify `.github/workflows/quote-flow-ci.yml`; Create `scripts/verify-deal-rollout.mjs`; Test: すべての上記テスト＋既存CI。

- [ ] PR上で新テストをCIに組込み、`node --test tests/*.test.mjs`、`node scripts/validate-static.mjs`、`node scripts/validate-browser.mjs`、`node scripts/build-staging-preview.mjs`を実行して成功確認。
- [ ] 非本番DBへDDLと互換RPCを先に適用し、旧顧客・支店・見積・受注が全件保持されること、想定しない自動リンクがないことを確認。復旧手順を検証。
- [ ] テスト用社内担当者・顧客アカウント・サポート担当者で発行→受注または失注→再提案→支払・工事・施工→保守閲覧まで手動検証。
- [ ] DBのバックアップと正確な移行件数を記録し、既存の関係を保持したまま本番マイグレーション。旧データへのロールバック案を用意。
- [ ] GitHub Pagesの`https://plusalphasapporo.github.io/PlusAlphaQuoteFlow/`から取得したHTMLとJSの一致、CI success、APIエラー有無を確認し、本番公開状態を報告。

## Implementation Notes

既存`index.html`は大規模だが全面書換えは行わない。新しい案件管理は`assets/deal-workflow.js`とCSSへ責任分割する。SQLは手続き単位でファイル分離し、認証・権限・行ロックを個々のRPCに含める。発注、受注、機器の正本を新テーブルにコピーしない。

まず**Release 1（案件管理・見積発行・受注・失注）**を実装し、安全性とユーザビリティの確認後にRelease 2/3へ進む。顧客データの消去は計画に含めない。
