# QuoteFlow Cloud — PR #35 Vercel Preview / 環境整合性ゲート

確認日: 2026-10-13 JST
対象PR: https://github.com/plusalphasapporo/PlusAlphaQuoteFlow/pull/35
検証対象リポジトリ: `plusalphasapporo/PlusAlphaQuoteFlow`
検証対象コミット: `1160683a98937cb7bc25a3f039d15f83b66b22c4`
Supabaseステージング: `dqtqoghnctdqoljxbjjz`

## 1. 確認できた構成（本番反映不可）

Vercelチーム: `nijiiroclassflat-s-projects`（`team_NhGhGsd7mxOZmAbTLXPHDUeI`）

| Vercelプロジェクト | Project ID | 直近デプロイに記録された GitHub リポジトリ | 判断 |
| --- | --- | --- | --- |
| `quote-flow` | `prj_dP1yMIhhnkWNslOSPTOag5GBgd7s` | `plusalphasapporo/QuoteFlow` | **PR #35と別リポジトリ** |
| `plusalphaquoteflow` | `prj_t9EHMKNlDzYIABWqmVjIHK77VJYz` | `plusalphasapporo/nijiiro-transport-app` | **QuoteFlow Cloudとは別のアプリ** |

- 上記2プロジェクトのデプロイ履歴をPR #35コミットSHAで検索したが、該当デプロイは0件。
- Vercel連携のチーム指定リクエストがHTTP 403。スコープ `nijiiroclassflat-s-projects` に対する接続権限・再認証の確認が必要。
- チームを指定しない一部読み取りでは情報が得られるが、**チーム権限が解決したことを意味しない**。
- 現行PR #35の `index.html` の `createClient` はステージング `https://dqtqoghnctdqoljxbjjz.supabase.co` を直接指定している。
- `index.html` と `vercel.json` のCSP接続先も上記ステージングに限定されている。
- したがって、今のPR #35を本番としてデプロイすると、本番UIがステージングDBへ接続する危険がある。

## 2. 次に必要な作業（既存のVercel本番プロジェクトを変更しない）

- [ ] チームの所有者が、ChatGPT側Vercel接続の `nijiiroclassflat-s-projects` アクセス権を再認可する。APIキー・トークン・パスワードをチャットに貼らない。
- [ ] Vercelの既存プロジェクト `quote-flow` を `PlusAlphaQuoteFlow` に安易に付け替えない。旧 `QuoteFlow` の稼働環境が変わる可能性がある。
- [ ] `plusalphaquoteflow` は `nijiiro-transport-app` 由来のため、QuoteFlow Cloud用として流用しない。
- [ ] `plusalphasapporo/PlusAlphaQuoteFlow` 用の**専用ステージング／プレビュー**プロジェクト・適切なGit接続先を確認または用意する。新規プロジェクト作成／課金が必要な場合は事前に運用責任者の承認を得る。
- [ ] PR #35と同じコミットSHAのPreviewを確認し、PreviewバックエンドがSupabaseステージングのみであることを検証する。
- [ ] Vercel Deployment Protection / SSOを勝手に無効化しない。権限を持つ認証済みユーザーのみテストする。
- [ ] 本番反映前に、`createClient` と `vercel.json` のCSPを本番／ステージング環境で分離する設計・検証を別途完了する。

## 3. 認証済みPreviewでの動作確認

- [ ] 自社管理者: MFA完了 → ダッシュボード → 顧客管理 → 機械台帳 → 案件管理 → 引継ぎ管理の表示、保存、再読込。
- [ ] 自社職員: 権限範囲内の受付・案件進行。管理者専用処理は拒否。
- [ ] サポート会社職員: 受付 → AI・ナレッジ → TeamViewer → 作業報告 → 必要時の引継ぎ。
- [ ] 顧客ユーザー: 自社受付などの管理者機能へのアクセス不可。
- [ ] 案件作成 → 案件番号表示 → 対応画面移動 → 更新 → 再読込後維持。連打・再試行時の二重登録なし。
- [ ] CallConnectの**新規**通話を用い、履歴の反映・文字起こしが利用可能な場合の保存・案件紐付けをテスト。終了後に不要テストデータを残さない。
- [ ] OneDrive / SharePoint の顧客資料が実際に表示されることを確認。必要なGraph設定は管理者だけがVercel/Supabaseの安全な環境変数管理画面で設定する（値をPRやCIログに書かない）。

## 4. 既に合格している項目／合格扱いしない項目

- [x] PR #35のGitHub Actionsは全項目成功: https://github.com/plusalphasapporo/PlusAlphaQuoteFlow/actions/runs/38375922776
- [x] Supabaseステージング `callconnect-records-sync` v7：同期HTTP 200が2回、監査ログ2件（いずれもchecked_count=0）。
- [x] 既存20案件の番号欠落・重複なし。主要関連テーブルの孤立データなし。
- [ ] 新規CallConnect通話の取り込み成功（HTTP 200のみでは未達成）。
- [ ] 認証済みブラウザによる主要画面・CRUD・権限のE2Eテスト。
- [ ] 正しいVercel Previewでの検証。
- [ ] **本番Supabaseの接続設定／リリース時の安全な切替・ロールバック。**

## 判定

**2026-10-13時点: ステージングのコードCI・既存データ整合性は概ね合格。ただし、Vercel Git連携の不一致、チーム403、環境分離、および認証済みE2E未検証により、本番リリースは不可。**

このファイルはリリース許可ではない。PR #35はドラフトのまま保持する。
