# 01: 入力正規化（Issue参照の確定）

## 目的

ユーザー入力からIssue識別子を一意に確定し、後続処理の失敗率を下げる。

## 入力

- Issue番号（例: `123`）
- Issue URL（例: `https://github.com/<owner>/<repo>/issues/123`）
- 任意のベースブランチ指定

## 処理

1. 入力文字列から `owner` / `repo` / `issue_number` を抽出。
2. URLと番号が同時指定された場合はURLを優先。
3. `base_branch` 未指定時はデフォルトブランチを利用。
4. 抽出結果を実行前に内部的に整形・記録。

## 完了条件

- `owner`, `repo`, `issue_number`, `base_branch` が確定している。
- 抽出不能な場合は理由を明示して停止できる状態。
