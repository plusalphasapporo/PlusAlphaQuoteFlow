# QuoteFlow Cloud — サポート一次対応・自社引継ぎ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 担当サポート会社の一次対応から、必要時の自社引継ぎ、対応報告・完了までを同一サポートチケットで進める。

**Architecture:** 既存`support_tickets`／`support_assignments`／`support_handoffs`と既存の4つの書込みRPCを正本とする。進捗判定モジュール、担当顧客に限定した読み取りRPC、現行チケット画面への薄いアダプターを追加。販売DBへの依存なしで単独提供・テスト可能。

**Tech Stack:** `index.html`・Vanilla JS・Supabase PostgreSQL/RPC/RLS・Node 22 native test・GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-10-16-dual-workflow-sales-and-support-design.md`（第3・4・6〜9章）

## Global Constraints

- サポート一次対応は有効な`support_assignments`で割当済みの顧客に限る。別のサポート会社へ他社情報を漏らさない。
- DBの受付種別は`incident`（障害）・`setting_request`（設定）・`inquiry`（問い合わせ）。
- 引継ぎの既存状態`pending → accepted → completed`、`support_tickets.id`／`ticket_number`と既存の添付・履歴を保持。
- 自社引継ぎの正式書き込みは`handoff_ticket_to_internal`・`accept_ticket_handoff`・`finish_internal_handoff_work`、直接解決の報告は`complete_support_ticket_with_report`。リモートは任意。
- CallConnect新規受付は自社への一斉通知対象外。ただし明示的な自社引継ぎは通知。顧客へ内部報告を自動送信しない。
- MFA、RLS、監査ログ、担当顧客限定通知、ユーザー別既読を維持。本番Supabaseをテスト用DBとして利用しない。

## Review Focus

1. 担当外のサポート会社はURL直指定やAPI直接呼び出しでも閲覧／引継ぎを拒否される（Task 2, 5）。
2. TeamViewerなしで解決可能だが、空の作業報告では完了不可（Task 1, 4）。
3. 二重クリック・通信断で同じ引継ぎ／報告を重複作成しない（Task 4）。
4. `pending`／`accepted`の引継ぎ中はチケット完了不可。未受領の自社対応完了不可（Task 4, 6）。
5. CallConnect新規と明示的引継ぎを区別して通知し、担当外へ漏らさない（Task 5）。

---

### Task 1: 進捗と次操作を純粋関数へ分離

**Files:** Create `assets/support-flow-state.js`; Test `tests/support-flow-state.test.mjs`。

**Interfaces:** `window.QuoteFlowSupportFlowState.derive({ticket,handoff,assignment,role})` → `{stage,nextAction,action,canClose}`。`ticket.status`、`support_stage`、`support_next_action`と`handoff.state`を読む。DBは更新しない。

- [ ] **Step 1: failing test.** `assert.equal(derive({ticket:{support_stage:'teamviewer_waiting'},handoff:null}).stage,'リモート対応')`、`assert.equal(derive({ticket:{status:'open'},handoff:{state:'pending'}}).canClose,false)`、`assert.match(derive({ticket:{status:'open'},handoff:{state:'accepted'}}).nextAction,/自社対応/)`。受付3種別、closed、未割当、リモートなしでの完了可否も検証。
- [ ] **Step 2: RED.** `node --test tests/support-flow-state.test.mjs` → 未実装によるFAIL。
- [ ] **Step 3: Implement.** `assets/support-flow-state.js`の`derive`で、受付→対応→必要時リモート→報告、またはpending→accepted→completedを判定。過去の状態文字列を変更しない。
- [ ] **Step 4: GREEN.** 同コマンド全件PASS。
- [ ] **Step 5: Commit.** `git add assets/support-flow-state.js tests/support-flow-state.test.mjs && git commit -m "feat: derive support next actions"`

### Task 2: MFA・会社割当を検証する読み取り専用RPC

**Files:** Create `sql/support_flow_context.sql`; Test `tests/support-flow-context.test.mjs`。

**Interfaces:** `public.support_flow_context(p_ticket_id uuid) RETURNS jsonb` → `{ticket,customer,assignment,active_handoff}`。`ticket`はid,number,request_type,status,support_stage,next_action,customer_id,asset_id,contract_id等。`active_handoff`はid,state,reason,next_action,accepted_by,accepted_at。会計／原価は返さない。

- [ ] **Step 1: failing test.** `assert.match(sql,/app_private\.can_access_ticket/)`、`assert.match(sql,/support_assignments/)`、`assert.match(sql,/current_company_id/)`、`assert.match(sql,/auth\.jwt\(\).*aal/s)`。隔離DBで担当サポート会社PASS・別社42501・未割当表示・複数割当を勝手に単独選択しないことを確認。
- [ ] **Step 2: RED.** `node --test tests/support-flow-context.test.mjs` → FAIL。
- [ ] **Step 3: Implement.** 既存`support_ticket_workspace(p_ticket_id)`の返却フィールドを確認し、重複集約を避けて補足する。`SECURITY DEFINER SET search_path TO ''`、スキーマ修飾、`anon`実行禁止、`authenticated`への許可＋関数内部で`can_access_ticket`、MFA、会社割当を厳格確認。
- [ ] **Step 4: GREEN.** Node + 非本番DBの担当社／別社／社内／顧客権限テストPASS。
- [ ] **Step 5: Commit.** `git add sql/support_flow_context.sql tests/support-flow-context.test.mjs && git commit -m "feat: add assigned-only support flow context"`

### Task 3: チケット詳細のステップ型ガイド

**Files:** Create `assets/support-flow-controller.js`; Modify `index.html`（既存`renderTicketDetail(ticketId)`）；Test `tests/support-flow-controller.test.mjs`と既存`tests/support-ticket-tabs.test.mjs`。

**Interfaces:** `window.QuoteFlowSupportFlow.configure({rpc,getRole,getTicketHost,toast,refreshTicket})`、`mount(ticketId)`、`openNext(ticketId)`。既存`window.QuoteFlowTicketTabs.mount/revealAndScroll/hasUnsentEdits`と共存。

- [ ] **Step 1: failing test.** `assert.match(host.innerHTML,/次に必要な操作/)`、`assert.ok(document.getElementById('supportRemoteWorkspace'))`、`assert.equal(previousDraft,afterNavigationDraft)`。4つの既存工程`supportLinearIntake`／`supportKnowledgeWorkspace`／`supportRemoteWorkspace`／`supportReportWorkspace`のDOM、添付、戻る操作を保持。
- [ ] **Step 2: RED.** `node --test tests/support-flow-controller.test.mjs` → FAIL。
- [ ] **Step 3: Implement.** 既存のDOMを再生成せず、チケット見出しに種別・担当会社・進捗・次操作を表示。必要な工程にのみ遷移。外部Company権限は最終的にDBが判断。
- [ ] **Step 4: GREEN.** `node --test tests/support-flow-controller.test.mjs tests/support-ticket-tabs.test.mjs tests/work-report-access.test.mjs`。
- [ ] **Step 5: Commit.** `git add assets/support-flow-controller.js index.html tests/support-flow-controller.test.mjs && git commit -m "feat: guide support users through ticket flow"`

### Task 4: 直接解決と自社引継ぎの分岐・完了

**Files:** Modify `assets/support-flow-controller.js`; Test `tests/support-flow-actions.test.mjs`。

**Interfaces:**
- `reportAndClose(ticketId,body)` → `complete_support_ticket_with_report({p_ticket_id,p_report_body})`
- `requestHandoff(ticketId,reason,nextAction)` → `handoff_ticket_to_internal({p_ticket_id,p_reason,p_next_action})`
- `acceptHandoff(handoffId)` → `accept_ticket_handoff({p_handoff_id})`
- `finishHandoff(handoffId,result,note,closeTicket)` → `finish_internal_handoff_work({p_handoff_id,p_result,p_support_note,p_close_ticket})`

- [ ] **Step 1: failing test.** 空報告／理由／次操作は呼出し前に拒否。サポート会社に自社受領・自社完了ボタンなし。`pending`で完了禁止、`p_close_ticket=false`なら継続。二重クリック一回のRPC、保存結果不明時は`support_flow_context`で再読込。元の`ticket_number`維持。
- [ ] **Step 2: RED.** `node --test tests/support-flow-actions.test.mjs`。
- [ ] **Step 3: Implement.** 既存4 RPCだけで申請・受領・自社対応結果・報告。リモート履歴を参照して必要事項のみ入力。`visibility='support'`の情報を顧客に送らない。
- [ ] **Step 4: GREEN.** 同テストおよび`tests/work-report-access.test.mjs` PASS。
- [ ] **Step 5: Commit.** `git add assets/support-flow-controller.js tests/support-flow-actions.test.mjs && git commit -m "feat: finish support work or hand off safely"`

### Task 5: 担当先の一覧・通知・CallConnect例外

**Files:** Modify `assets/support-flow-controller.js`・`index.html`（`renderSupport`／`renderHome`）; Test `tests/support-flow-notifications.test.mjs`。

**Interfaces:** 既存`support_unread_notifications()`、`internal_unread_handoff_notifications()`、`internal_handoff_queue()`、`support_assignment_states()`。既読は`support_ticket_reads`／`support_handoff_reads`／`internal_handoff_reads`を再利用。

- [ ] **Step 1: failing test.** 担当外・未割当・複数割当・CallConnect新規・明示的引継ぎ・既読別利用者の6ケース。`assert.equal(internalCallConnectNewAlertCount,0)`と`assert.equal(internalExplicitHandoffAlertCount,1)`を確認。
- [ ] **Step 2: RED.** `node --test tests/support-flow-notifications.test.mjs`。
- [ ] **Step 3: Implement.** 一覧と通知に工程・担当先・次操作を表示。DB通知の不具合が証明された場合だけ別途`sql/support_flow_notification_fixes.sql`で最小の互換変更。無関係な全件通知を新設しない。
- [ ] **Step 4: GREEN.** Node＋隔離DBでサポート会社2社、社内、顧客の権限／既読テストPASS。
- [ ] **Step 5: Commit.** `git add assets/support-flow-controller.js index.html tests/support-flow-notifications.test.mjs && git commit -m "feat: scope first-line alerts to assigned recipients"`

### Task 6: 単独検証・公開前ゲート

**Files:** Modify `.github/workflows/quote-flow-ci.yml`; Create `scripts/verify-support-flow.mjs`、`tests/support-flow-rollout.test.mjs`。

**Interfaces:** `scripts/verify-support-flow.mjs`は本番と分離したテスト接続先、担当社・別社・自社・顧客の検証結果を受け取り、実データの変更や公開を行わず検証ログを作る。

- [ ] **Step 1: failing test.** DBの本番／非本番が未確認ならスクリプトが書き込み試験を拒否。`pending/accepted`強制完了、匿名閲覧、CallConnect新規誤通知、二重申請に関するテストがCIに存在すること。
- [ ] **Step 2: RED.** `node --test tests/support-flow-rollout.test.mjs`。
- [ ] **Step 3: Implement.** CIに`tests/support-flow-*.test.mjs`、既存`support-ticket-tabs`・報告・ブラウザー静的検査を追加し、隔離DBの再現手順とロール別手動確認表を整備。
- [ ] **Step 4: GREEN.** `node --test tests/support-flow-*.test.mjs tests/support-ticket-tabs.test.mjs tests/work-report-access.test.mjs`、`node scripts/validate-static.mjs`、`node scripts/validate-browser.mjs`。別DB実機確認と復元可能性が揃わなければ「未公開」と記録。
- [ ] **Step 5: Commit.** `git add .github/workflows/quote-flow-ci.yml scripts/verify-support-flow.mjs tests/support-flow-rollout.test.mjs && git commit -m "test: gate first-line support flow release"`

## Execution Order and Release Safety

Task 1→2→3→4→5→6で完結する独立サポート機能。旧チケットの状態や番号を一括書換えしない。非本番DBで5ロール・複数顧客・引継ぎ再送・添付・CallConnect通知を確認し、バックアップと復旧手順が揃うまで本番アプリとDBの切替を行わない。
