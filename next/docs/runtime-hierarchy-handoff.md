# native subagent対応を完了するには実行モデルの再設計が必要

## このhandoffで相談したいこと

`next/`にはWorkItemの階層、Execution、Delegation、runtime launcherが実装されている。しかし、現在成立するのは`wr-next run WORK -- COMMAND`が直接起動したsubprocessまでである。Codex、Claude Code、OMPなどが内部で生成するnative subagentには、専用Executionやcontextを割り当てられない。

元の実装担当者には、次の方針を相談したい。

1. launcherを全agentの必須wrapperにせず、runtimeが持つsession/subagent lifecycleへどう統合するか。
2. WorkItemの親子、runtime agentの親子、work delegation、Executionの継続を別の関係としてどう保存するか。
3. 親agentへ、担当scope内だけを分解・委譲できる権限をどう渡すか。
4. native subagentごとに一意なExecutionとcapabilityを発行し、`report`と`done`を誤帰属させない方法。

現時点では、native subagentを含む実runtime対応を完了扱いにしない。

## 現在の実装と検証済み範囲

後継実装は`next/`に分離されている。Bun 1.4.2、Bun SQLite、Cloudflare SQLite-backed Durable Objectを使う。既存wrのCLI、D1、migration、hook、releaseには接続していない。

実装済みの主な領域は次のとおり。

- WorkItemの親子、開始依存、cycle検査、scope revision。
- RunとExecutionの分離、writer/resource reservation、lane capacity。
- Result、Check、Acceptanceの分離と、要求・artifact変更時の失効。
- subprocess launcher、context file、ClaudeのSessionStart/SessionEnd/PostToolUse hook。
- Git commit provenance、rewrite lineage、明示的なco-author。
- `gh` CLIを使ったPR作成・同期と、外部副作用の重複防止。
- legacy checklistの限定的なimport、shadow比較、scope cutover、rollback。

Bun 1.4.2で`bun ci`、`bun run verify`、72テスト、統合デモ、real workerd smokeが成功している。agent、GitHub PR、legacy checklistを使う統合デモは合成データであり、native subagent対応やlive GitHub対応の証明ではない。

## `wr-next serve`の位置付けが暫定的

`bin/wr-next serve`は、ローカルの状態authorityである。launcherとは別の役割を持つ。CLI、agent、Git hookからHTTPで操作を受け、Bun SQLite上でclaim、reservation、idempotency、Acceptanceを同じtransaction境界に置く。

この構造自体は並列processの調停に必要だが、人間が毎回別terminalでserverを管理する使い方は暫定である。製品の通常経路は、remote Durable Objectへ接続するか、local authorityをCLIが安全に自動起動・再利用する形が望ましい。

相談したい点は、authorityの責務を維持したまま、手動`serve`を通常操作から外せるかである。SQLiteを各CLI processが直接開く構成へ戻すと、認証、同時claim、外部副作用の再送制御が崩れるため避けたい。

## launcherは現在wrapperとして動く

`wr-next run W2 -- COMMAND`は、次の処理を行う。

1. authorityへ`execution.start`を送る。
2. WorkItemと作業環境を予約する。
3. Execution専用のworker、launcher、Git、GitHub capabilityを発行する。
4. owner-onlyのcontext fileを作る。
5. `WR_NEXT_CONTEXT`を設定して`COMMAND`をspawnする。
6. process終了を観測し、reservationとoutboxを処理する。

この方式なら、別々の`wr-next run`から起動したprocessには別contextが配られる。

```text
wr-next run W2 -- agent-a  -> context A -> Execution A -> W2
wr-next run W3 -- agent-b  -> context B -> Execution B -> W3
```

一方、起動後のagentがruntime固有のsubagent機能を使う場合、wr-nextは生成境界を観測できない。

```text
wr-next run W1 -- parent-agent  -> context P
  ├─ native subagent A          -> context Pを継承する可能性
  └─ native subagent B          -> context Pを継承する可能性
```

AとBが親contextを継承すると、両者の`report`と`done`はW1の親Executionへ帰属する。環境を継承しなければ、今度は担当WorkItemを特定できない。したがって、wrapperの内側で生成されるnative subagentは安全に追跡できない。

launcherはgeneric subprocess、CI worker、明示的なworktree起動には有用だが、すべてのagent/subagentの必須入口にはできない。runtime adapterの補助機能として位置付け直す必要がある。

## `report`の暗黙解決はExecution専用contextがある場合だけ安全

`wr-next report`と`wr-next done`でWorkItemを省略すると、現在は次の順序で解決する。

```text
WR_NEXT_CONTEXT
  -> worker capability
  -> capabilityにbindされたExecution
  -> Execution.work
  -> WorkItem
```

workerが別WorkItemを明示した場合は`AMBIGUOUS_CONTEXT`で拒否される。この境界は、Executionごとに異なるcapabilityが配られていれば安全である。

native subagentには専用capabilityを配れていないため、並列subagentを区別できない。cwd、最新session、親processだけからWorkItemを推定してはいけない。

## sub WorkItemは構造だけ実装されている

現在のWorkItem階層は次を扱える。

- `add --under`による親子作成。
- `needs`による開始依存。
- 親子の完了待ちを含むcycle検査。
- 最初の子を追加した親を`children-v1`へ変更。
- 直接の子が全件Acceptance済みになった場合の親Acceptance。
- 子のAcceptance失効に伴う親の再open。
- cancelledの子を成功として扱わない。

しかし、agentが子を作って実行する経路は不足している。

- `work.create`と`work.plan`はoperator専用であり、managed orchestratorは担当親scopeを分解できない。
- 子を持つ親は、read-onlyのorchestrator Execution以外では起動できない。
- readyな子を選んでdispatchするcommandはない。
- 既存の子を委譲する場合も、親から`wr-next run CHILD -- COMMAND`を呼ぶwrapper方式に限られる。
- native subagentを子WorkItemへbindできない。

したがって、現状をsub WorkItem対応済みとは呼べない。階層DAGと完了集約は実装済みだが、agentによる分解、委譲、native subagent実行は未実装である。

## agentの親子も部分的なlineageしかない

現在の`Session`にはruntime、external session ID、deviceしかなく、親sessionを持たない。現行wrにある`CliSession.parentCliSessionId`相当が後継実装にはない。

`Execution.parent`は存在するが、親context内から明示的に`wr-next run CHILD`を実行し、Delegationが発行された場合だけ設定される。runtimeが生成したagent treeは反映されない。

現在混在している関係を、少なくとも次の4種類に分けたい。

1. **Work hierarchy**: W1がW2を含む。
2. **Runtime agent hierarchy**: agent Aがagent Bを生成した。
3. **Work delegation**: Execution AがW2への着手権限をExecution Bへ委譲した。
4. **Continuation**: Execution A2が停止済みExecution Aを再開した。

同じagentが複数WorkItemを順番に担当する場合や、別agentが仕事を引き継ぐ場合があるため、この4種類は同じ`parent`では表現できない。

## 必要と考える最小モデル

具体的な名前は変更してよいが、意味は分離したい。

```ts
type RuntimeSession = {
  id: string
  runtime: string
  externalSessionId: string
  parentSessionId: string | null
  deviceId: string
}

type Run = {
  id: string
  sessionId: string | null
  parentRunId: string | null
  runtimeAgentId: string | null
  state: "active" | "ended" | "unknown"
}

type Delegation = {
  id: string
  parentExecutionId: string
  workItemId: string
  runtimeChildId: string | null
  state: "issued" | "claimed" | "revoked" | "expired"
}

type Execution = {
  id: string
  workItemId: string
  runId: string
  delegationId: string | null
  parentExecutionId: string | null
  continuedFromExecutionId: string | null
}
```

`parentSessionId`はruntime上の親子、`delegationId`は仕事を渡した根拠、`continuedFromExecutionId`は再開を表す。これらを相互に推測して補完しない。

## 親agentにはscope限定のplanning権限が必要

agentにはoperator権限を渡さず、担当親WorkItemの子孫scopeに限定したcapabilityを発行する必要がある。

許可候補:

- 直接の子WorkItem作成。
- 未着手の子WorkItem更新。
- 担当scope内のdependency追加・削除。
- 担当scope内のDelegation発行。
- readinessと子Executionの参照。

拒否対象:

- 担当scope外の変更。
- operatorまたは人間authorityのHold解除。
- trusted Checkの生成。
- migration、cutover、rollback。
- publisher、reviewer、observerの偽装。
- workspace全体のplan変更。

親WorkItemのscope revisionをいつ進めるか、既に実行中の親を分解するときのreplan権限も明示する必要がある。

## runtime adapterに必要な契約

runtime/harnessがnative subagentを生成するとき、少なくとも次をwr-nextへ渡す必要がある。

```ts
type ChildStarted = {
  parentRuntimeSessionId: string
  parentExecutionId: string
  runtimeChildId: string
  workItemId: string
}
```

authority側の処理は次を想定する。

```text
親Executionとscopeを検証
  -> Delegationを発行
  -> 子WorkItemをatomic claim
  -> child Session/Run/Executionを作成
  -> child専用capabilityを発行
  -> runtimeChildIdへbinding
```

子agent内の`report`と`done`は、child capabilityまたはruntimeChildIdから子Executionを解決する。親のcontextを継承しただけのprocessには、子WorkItemの更新を許可しない。

最初から汎用plugin interfaceを作る必要はない。実際に利用するharnessを一つ選び、そのsubagent生成・終了境界へ直接統合して契約を固める方がよい。対応できないruntimeはsupportedと表示しない。

## 親子agentのライフサイクル規則

次の状態を推測で処理しない。

- 親が終了しても、子が終了したとはみなさない。
- 子が生存中なら親へ`children_active`または同等の状態を表示する。
- 親のcancelやcapability revokeと、子OS processの停止を分ける。
- 親を失った子はorphanとして表示する。
- 子のResultは担当した子WorkItemへ提出する。
- 子WorkItemのAcceptanceを、Work hierarchyを通じて親へ集約する。
- agent親子だけを理由に、子Resultを親WorkItemへ転用しない。
- resumeした親へ既存の子を自動で付け替えない。
- 孫agentでも同じ規則を再帰的に適用する。

agent treeとWorkItem graphは別projectionとして表示する必要がある。

## PR作成の現在の実装

`wr-next pr create W2`は内部で`gh` CLIを使う。

```text
Git repositoryとcurrent branchを取得
  -> authorityでeffect.prepare
  -> effect.beginで作成権をclaim
  -> PR bodyへoperation markerを追加
  -> gh pr create
  -> receiptを保存
  -> effect.resolve
  -> gh apiでPR、commit、review、checkを再取得
```

作成呼び出しは次に相当する。

```bash
gh pr create --repo OWNER/REPO --head BRANCH --base BASE --title TITLE --body-file FILE
```

応答が不明になった場合は、PR bodyの`<!-- wr-next:operation:... -->`を`gh pr list`で検索し、重複作成を避ける。branchのpushは行わない。PRを後から同期したobserverと、作成したpublisherは区別する。

この部分は実行形式のmockで検証済みだが、live GitHub APIでは未検証である。native subagentが直接`gh pr create`した場合のpublisher確定も、runtime adapterとExecution bindingが完成するまで受入済みとしない。

## 既存wrからのmigrationは別課題

既存wrからの直接importerはまだない。実装済みなのはlegacy checklist用の限定importerと、shadow、cutover、rollbackである。

安全な移行では、既存wrを変更せず、version付きread-only exportを新DBへshadow importする。旧Taskの`done`にはResult、subject SHA、Check、Acceptanceがないため、新しいAcceptanceへ自動変換しない。PRのHEAD、commit membership、review、CIはGitHubから再観測する。

runtime hierarchyを直す前に旧Session親子をimportすると、新旧の意味が混ざる。先にSession、Run、Execution、Delegationの契約を確定し、その後で既存wr用export/importを設計したい。

## 受入条件

次を満たすまでは、sub WorkItemとnative subagent対応を完了扱いにしない。

1. 親agentが担当scope内に子WorkItemを作れる。scope外は拒否される。
2. 親agentが二つのreadyな子をnative subagentへ並列委譲できる。
3. 各子に別Session、Run、Execution、capabilityが割り当てられる。
4. 子Aの`report`と`done`が子Bまたは親へ誤帰属しない。
5. 子が親環境を継承しただけでは、親Executionを更新できない。
6. 子終了、親終了、orphan、resumeを別々に記録できる。
7. 孫agentでもlineageとdelegationが維持される。
8. 子ResultのAcceptanceからWorkItemの親が集約完了する。
9. runtime agent treeとWorkItem graphを別々に説明できる。
10. 対応runtimeの実CLIで上記を確認する。合成subprocessだけでは受入としない。

## 関連ファイル

- `next/src/domain/model.ts`: Session、Run、Execution、Delegation。
- `next/src/domain/service.ts`: planning権限、delegation発行、execution start。
- `next/src/domain/work.ts`: readinessと親WorkItemのAcceptance集約。
- `next/src/runtime/launcher.ts`: wrapperとcontext発行、Claude lifecycle hook。
- `next/src/cli/files.ts`: `WR_NEXT_CONTEXT`とconnection解決。
- `next/src/cli/main.ts`: `run`、`report`、`done`、`pr create`。
- `next/src/integrations/github.ts`: `gh`によるPR作成・同期。
- `next/src/projections/views.ts`: status、workpad、Mermaid。
- `next/docs/architecture.md`: 現在の設計原則とmigration境界。

## 今回変更しない範囲

このhandoff作成時点では、runtime modelの修正、native subagent adapter、既存wr importer、本番deploy、既存DB migration、旧wr削除、正式rename、releaseは行っていない。現在の実装と検証結果を保存し、上記の論点を元の実装担当者と再検討するためのcommitとする。
