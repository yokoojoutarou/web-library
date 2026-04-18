# 03: Issue取得（本文・コメント・メタ情報）

## 目的

実装に必要なIssue情報を欠落なく収集する。

## 入力

- `owner/repo`
- `issue_number`

## 処理

1. `gh issue view <issue_number> --repo <owner>/<repo> --json number,title,body,labels,assignees,state,author,comments` を実行。
2. Issue本文とコメントを時系列で統合。
3. `state` が `open` 以外なら、実装可否を判定（通常は要確認として扱う）。
4. 関連PR/Issueリンク（本文内URL）を抽出して参照候補化。

## 完了条件

- タイトル/本文/コメント/ラベル/状態を取得済み。
- 取得失敗時に、再試行条件または停止理由を明確化。
