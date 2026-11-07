# Despachante de agentes

Usa as Issues de `Joaodev1409/EAG-final` (remote `meu`) como fila de tasks para o Claude Code (`server/`, worktree `../EAG-claude`) e o Antigravity (`client/`, worktree `../EAG-agy`).

Requisitos: `gh` instalado e autenticado (`gh auth login`), `claude` e `agy` no PATH, worktrees criadas com `criar-worktrees.ps1` e **limpas** (sem mudanças não commitadas).

```powershell
powershell -ExecutionPolicy Bypass -File scripts\agentes\despachante.ps1 -Acao preparar  # cria as labels e põe .agentes/ e PARAR no .git/info/exclude
powershell -ExecutionPolicy Bypass -File scripts\agentes\despachante.ps1 -Acao planejar  # claude só leitura propõe até 3 issues "proposta"
powershell -ExecutionPolicy Bypass -File scripts\agentes\despachante.ps1 -Acao uma-vez   # uma passada (bom para o primeiro teste)
powershell -ExecutionPolicy Bypass -File scripts\agentes\despachante.ps1 -Acao loop      # a cada intervaloMinutos
powershell -ExecutionPolicy Bypass -File scripts\agentes\despachante.ps1 -Acao status
```

## Ciclo de uma issue

`proposta` → (João troca para) `aprovada` → `em-andamento` → `pr-aberto` (ou `falhou`) → João revisa e faz o merge.

1. Para cada agente sem issue `em-andamento`, pega a `aprovada` mais antiga com a label `agente:<nome>`.
2. Na worktree: `git fetch meu`, `git merge --no-edit meu/main` na branch do agente, cria `tarefa/<agente>-<N>`.
3. Roda o agente headless com o texto da issue. Confere se só mudou os **caminhos permitidos** da issue (linha `**Caminhos permitidos:**`), faz o commit `#N: título` e roda `npm run build` e `npm test --prefix server`. Se falhar, devolve o erro ao agente (até `maxTentativas`); depois disso, label `falhou` e comentário com o erro.
4. Se passar: `git push meu tarefa/<agente>-<N>` e `gh pr create` com `Closes #N` e label `pr-aberto`.
5. O outro agente revisa o diff só com leitura, e a revisão vira comentário no PR.

## Travas

- Push só para `tarefa/*` (`Push-Seguro`); merge só da `meu/main` **para** a branch do agente. Nada de push nem merge na `main`.
- `limiteTasksPorDia`, `timeoutTaskMinutos` (mata a árvore de processos), `timeoutRevisaoMinutos`.
- Arquivo `PARAR` na raiz do EAG: o loop encerra na próxima checagem (a cada 10 s, ou entre tasks).
- Logs, prompts e saídas em `.agentes/` (fora do git).
- Claude: `--permission-mode dontAsk` com lista de permissões gerada por task (lê tudo, só edita os caminhos da issue, só roda build/test/git status/diff/log; push, merge, commit, checkout, `.env*`, internet negados). Na revisão e no planejador, só leitura. Orçamento por execução em `orcamentoUsdPorExecucaoClaude`.
- Antigravity: o `agy` não tem regra de permissão por caminho; roda com `--mode accept-edits --sandbox` (revisão: `--mode plan`). A trava de caminhos do despachante confere o resultado e reprova o que sair do permitido. Ajuste `argsTarefa`/`argsRevisao` no `config.json` se o `agy -p` não conseguir editar nesse modo.
