---
name: issue-triage
description: 実装対象IssueをGitHub CLIで探索・優先順位付けし、着手候補を決定する補助Skill。
---

# Skill: issue-triage

## 目的

Issue着手前の取り違えを防ぎ、優先度の高いIssueを選定する。

## 利用シーン

- 「次に着手すべきIssueを選びたい」
- 「ラベル付きIssueだけ見たい」
- 「期限・担当・状態で絞り込みたい」

## 実施手順

1. `gh issue list --repo <owner>/<repo> --state open` を基点に一覧化。
2. 必要に応じて `--label`, `--assignee`, `--search` で絞り込み。
3. タイトル/ラベル/最終更新日/コメント数で優先度を暫定判定。
4. 着手候補上位3件を提示し、次に `issue-to-code` へ接続する。

## 出力

- 着手候補Issueの短い比較表
- 推奨着手順
- 直近のブロッカー有無
