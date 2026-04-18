---
name: issue-to-code
description: ユーザーの `/issue` 指示をトリガーに、GitHub CLIでIssueを取得し、要件を分解して実装・検証・報告まで一貫して実行するSkill。
---

# Skill: issue-to-code

## 目的

GitHub Issueの要求を、曖昧さを減らした実装タスクに変換し、リポジトリへ安全に反映する。

## トリガー

- `/issue <issue番号|issueURL> [base_branch]`
- `issueを読んで実装して` のような自然言語指示

## 実行ポリシー

- 要件は最小機能単位で分割し、下記ファイル順に処理する。
- 各ステップで「入力」「処理」「完了条件」を満たすこと。
- 不明点はIssue本文・コメント・既存コードから優先的に解決する。
- 破壊的変更は避け、必要時は代替案を提示する。

## 要件定義ファイル（最小機能単位）

1. [requirements/01-input-normalization.md](requirements/01-input-normalization.md)
2. [requirements/02-gh-context-and-auth.md](requirements/02-gh-context-and-auth.md)
3. [requirements/03-fetch-issue.md](requirements/03-fetch-issue.md)
4. [requirements/04-requirement-extraction.md](requirements/04-requirement-extraction.md)
5. [requirements/05-codebase-impact-mapping.md](requirements/05-codebase-impact-mapping.md)
6. [requirements/06-implementation-planning.md](requirements/06-implementation-planning.md)
7. [requirements/07-implementation-and-validation.md](requirements/07-implementation-and-validation.md)
8. [requirements/08-traceability-and-reporting.md](requirements/08-traceability-and-reporting.md)

## 出力物

- 変更コード（必要な場合）
- 変更理由とIssue要件の対応表
- テスト/検証結果
- 未解決事項と次アクション
